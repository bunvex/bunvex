// What a route checks first, on Convex's backend (the oracle) and on bunvex's: the same requests, compared
// answer by answer.
// - The app metrics routes (`/api/app_metrics/*`, crates/local_backend/src/app_metrics.rs) read and check their
//   query arguments before `metrics_log` checks ViewMetrics. A request with bad arguments and no key is a 400,
//   not a 403.
// - The push routes (`/api/deploy2/*`, `/api/get_config_hashes`; deploy_config.rs, deploy_config2.rs) take
//   the admin key from the JSON body only (`must_be_admin_from_key`). Without `adminKey` the answer is
//   `BadJsonBody`, whatever the `Authorization` header says, and the header is not read.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`args-before-auth: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

/** `admin`: the backend's own scheme and key (DV-97); a string: that header as given; null: none. */
async function raw(
  b: Backend,
  method: string,
  path: string,
  opts: { body?: string; auth?: "admin" | string | null; contentType?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  const auth = opts.auth === undefined ? null : opts.auth;
  if (auth === "admin") headers.authorization = `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
  else if (auth !== null) headers.authorization = auth;
  const ct = opts.contentType === undefined ? (opts.body === undefined ? null : "application/json") : opts.contentType;
  if (ct !== null) headers["content-type"] = ct;
  const r = await fetch(`${b.url}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  // `BadDeployKey`'s wording is #558's (bunvex names the deployment until it merges); remove this then.
  const text = (await r.text()).replace(/invalid for deployment '[^']*'/, "invalid for this deployment");
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body };
}

const W = encodeURIComponent(
  JSON.stringify({
    start: { secs_since_epoch: 0, nanos_since_epoch: 0 },
    end: { secs_since_epoch: 60, nanos_since_epoch: 0 },
    num_buckets: 1,
  }),
);

describe.skipIf(!ready)("arguments before auth, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("app metrics: arguments first, then ViewMetrics", async () => {
    const queries: Record<string, string[]> = {
      udf_rate: [
        "",
        `window=${W}`,
        `udfPath=ops:read&metric=invocations&window=${W}`,
        `udfPath=ops:read&metric=nope&window=${W}`,
        `udfPath=ops:read&metric=invocations&window=nope`,
        `udfPath=bad::&metric=invocations&window=${W}`,
        `path=ops:read&metric=invocations&window=${W}`,
        `udfPath=ops:read&window=${W}`,
      ],
      failure_percentage_top_k: ["", `window=${W}`, `window=${W}&k=0`, `window=${W}&k=x`, "window=nope"],
      cache_hit_percentage_top_k: ["", `window=${W}`, `window=${W}&k=26`],
      function_call_count_top_k: ["", `window=${W}`, `window=${W}&k=3`],
      subscription_invalidations_top_k: [
        "",
        `window=${W}`,
        `window=${W}&k=0`,
        `window=${W}&udfPath=ops:apply`,
        `window=${W}&udfPath=bad::`,
      ],
      cache_hit_percentage: ["", `udfPath=ops:read&window=${W}`, `udfPath=ops:read&window=nope`],
      latency_percentiles: [
        "",
        `udfPath=ops:read&percentiles=[50,99]&window=${W}`,
        `udfPath=ops:read&percentiles=nope&window=${W}`,
        `udfPath=ops:read&percentiles=[50]&window=nope`,
      ],
      table_rate: [
        "",
        `name=a&metric=rowsRead&window=${W}`,
        `name=a&metric=nope&window=${W}`,
        `name=_bad-&metric=rowsRead&window=${W}`,
        `name=a&metric=rowsRead&window=nope`,
      ],
      scheduled_job_lag: ["", `window=${W}`, "window=nope"],
      function_concurrency: ["", `window=${W}`, "window=nope"],
      stream_function_logs: ["", "cursor=0", "cursor=x"],
      stream_udf_execution: ["", "cursor=0", "cursor=x"],
    };
    // An admin's valid log stream request long-polls (60 s): the streams are asked without one.
    for (const [route, qs] of Object.entries(queries))
      for (const q of qs)
        for (const auth of route.startsWith("stream_")
          ? ([null, "Bearer abc"] as const)
          : ([null, "Bearer abc", "admin"] as const)) {
          const path = `/api/app_metrics/${route}?${q}`;
          const r = {
            convex: await raw(convex, "GET", path, { auth }),
            bunvex: await raw(bunvex, "GET", path, { auth }),
          };
          expect({ path, auth, ...r.bunvex }).toEqual({ path, auth, ...r.convex });
        }
  }, 120_000);

  test("push routes: the admin key from the body only", async () => {
    const paths = [
      "/api/get_config_hashes",
      "/api/deploy2/start_push",
      "/api/deploy2/evaluate_push",
      "/api/deploy2/evaluate_schema",
      "/api/deploy2/wait_for_schema",
      "/api/deploy2/finish_push",
      "/api/deploy2/report_push_completed",
    ];
    for (const path of paths) {
      const cases: { body?: string; auth?: "admin" | string | null; contentType?: string | null }[] = [
        { body: "{}", auth: "admin" },
        { body: "{}" },
        { body: '{"adminKey":5}', auth: "admin" },
        { body: "[]", auth: "admin" },
        { body: "{", auth: "admin" },
        { body: '{"adminKey":"garbage"}', auth: "admin" },
        { body: "{}", auth: "admin", contentType: null },
        { body: "{}", auth: "Nonsense header" },
      ];
      for (const c of cases) {
        const r = { convex: await raw(convex, "POST", path, c), bunvex: await raw(bunvex, "POST", path, c) };
        expect({ path, ...c, ...r.bunvex }).toEqual({ path, ...c, ...r.convex });
      }
      // The body's key, with a header naming nothing valid: the header is not read.
      const withKey = (b: Backend) =>
        raw(b, "POST", path, { body: JSON.stringify({ adminKey: b.adminKey }), auth: "Nonsense header" });
      const k = { convex: await withKey(convex), bunvex: await withKey(bunvex) };
      // Past the key, each route checks its own arguments (not compared here): neither side refuses the key.
      for (const r of [k.convex, k.bunvex])
        expect(["BadAdminKey", "BadDeployKey", "InvalidHeaderFailure", "InvalidAdminKey"]).not.toContain(
          (r.body as { code?: string }).code,
        );
    }
  }, 120_000);
});

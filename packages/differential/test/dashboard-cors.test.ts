// The dashboard's routes from another origin, on Convex's backend (the oracle) and on bunvex's (STUDY-67 §9): the
// preflight Chrome sends before each admin request (the admin key and the client header asked), and the CORS
// headers of the request itself. A dashboard served on its own origin (the image on 6791, `bunvex dashboard serve`)
// reads a deployment only through routes behind the layer: `/api/*`, the health routes. The meta `/version` and
// `/metrics` stay outside it on both. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-cors: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

const ORIGIN = "http://127.0.0.1:6791";

/** The answer's status, body and CORS headers (`access-control-*` and `vary`). */
async function corsOf(r: Response) {
  const headers = Object.fromEntries(
    [...r.headers]
      .filter(([k]) => k.startsWith("access-control-") || k === "vary")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return { status: r.status, body: await r.text(), headers };
}

/** The routes both backends serve that a dashboard calls (Convex's and bunvex's), and the meta routes. */
const ROUTES: [string, string, string?][] = [
  ["GET", "/instance_name"],
  ["GET", "/instance_version"],
  ["GET", "/version"],
  ["GET", "/metrics"],
  ["GET", "/"],
  ["POST", "/echo", "hi"],
  ["GET", "/api/check_admin_key"],
  ["GET", "/api/shapes2"],
  ["POST", "/api/query", '{"path":"nope:nope","args":{},"format":"json"}'],
  ["POST", "/api/update_environment_variables", '{"changes":[]}'],
  ["GET", "/api/v1/list_environment_variables"],
  ["GET", "/api/app_metrics/function_call_count_top_k?window=x&k=5"],
  ["GET", "/api/app_metrics/stream_function_logs?cursor=0"],
  ["POST", "/api/delete_tables", '{"tableNames":[]}'],
  ["POST", "/api/cancel_all_jobs", "{}"],
  ["POST", "/api/cancel_job", '{"id":"x"}'],
  ["POST", "/api/v1/pause_deployment", "{}"],
  ["POST", "/api/export/request/zip", ""],
  ["POST", "/api/import/start_upload", ""],
  ["POST", "/api/cancel_import", '{"importId":"x"}'],
  ["POST", "/api/run_test_function", "{}"],
  // the CLI's routes (under two layers on Convex, as the health routes)
  ["POST", "/api/get_config_hashes", "{}"],
  ["POST", "/api/deploy2/start_push", "{}"],
  ["GET", "/api/stream_function_logs?cursor=0"],
  ["POST", "/api/perform_import", '{"importId":"x"}'],
];

describe.skipIf(!ready)("the dashboard's routes from another origin, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("each preflight, with the admin key's and the client's headers asked: the same answer", async () => {
    let allowed = 0;
    for (const [method, path] of ROUTES) {
      const preflight = (b: Backend, client: string) =>
        fetch(`${b.url}${path}`, {
          method: "OPTIONS",
          headers: {
            origin: ORIGIN,
            "access-control-request-method": method,
            "access-control-request-headers": `authorization,${client},content-type`,
          },
        }).then(corsOf);
      // each dashboard sends its own client header (DV-307's rule 5): the name differs, the answer must not
      const c = await preflight(convex, "convex-client");
      const b = await preflight(bunvex, "bunvex-client");
      if (c.headers["access-control-allow-origin"] === ORIGIN) allowed++;
      const asked = (h: Record<string, string>) => ({
        ...h,
        ...(h["access-control-allow-headers"] && { "access-control-allow-headers": "(the asked ones)" }),
      });
      expect({ path, ...b, headers: asked(b.headers) }).toEqual({ path, ...c, headers: asked(c.headers) });
      if (b.headers["access-control-allow-headers"])
        expect(b.headers["access-control-allow-headers"]).toBe("authorization,bunvex-client,content-type");
    }
    // the meta `/version` and `/metrics` only are outside the layer
    expect(allowed).toBe(ROUTES.length - 2);
  });

  // `vary` included: twice on Convex's routes under two layers (the health and the CLI routes)
  test("each request from another origin, without a key: the same CORS headers", async () => {
    for (const [method, path, body] of ROUTES) {
      const send = (b: Backend) =>
        fetch(`${b.url}${path}`, {
          method,
          headers: { origin: ORIGIN, ...(body !== undefined && { "content-type": "application/json" }) },
          ...(body !== undefined && { body }),
        }).then(async (r) => ({ path, headers: (await corsOf(r)).headers }));
      expect(await send(bunvex)).toEqual(await send(convex));
    }
  });

  test("the version the dashboard shows: /instance_version, from another origin, with the key", async () => {
    for (const b of [convex, bunvex]) {
      const r = await fetch(`${b.url}/instance_version`, {
        headers: { origin: ORIGIN, authorization: `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}` },
      });
      expect([b.name, r.status, r.headers.get("access-control-allow-origin")]).toEqual([b.name, 200, ORIGIN]);
      expect(await r.text()).toBe(await (await fetch(`${b.url}/version`)).text());
    }
  });
});

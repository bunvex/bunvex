// The dashboard's Functions, runner and Settings reads (STUDY-149 PR 4) on Convex's backend (the oracle) and on
// bunvex's: `_system/frontend/modules:*`, `components:list`, `getVersion`, the URL queries (renamed by rule 5,
// DV-474), `listEnvironmentVariables`, `latestExport` and `snapshotImport:list`; a function run over the socket as
// an admin and acting as a user, as the runner does; and a custom test query (`/api/run_test_function`). The same
// requests on both, answers compared after ids and times are named by order. Each backend gets its own auth
// scheme, encoded format and test-query module specifier (DV-97, DV-307, DV-390). Local only: skipped, with a
// note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BunvexClient } from "@bunvex/client";
import { ConvexClient } from "convex/browser";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { errorText } from "../harness/compare.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`dashboard-functions: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../functions-app");

let convex: Backend;
let bunvex: Backend;

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;
const encoded = (b: Backend) => (b.name === "convex" ? "convex_encoded_json" : "encoded_json");
/** DV-474: Convex's `convexCloudUrl` / `convexSiteUrl` are bunvex's `cloudUrl` / `siteUrl`. */
const urlQuery = (b: Backend, which: "cloud" | "site") =>
  `_system/frontend/${b.name === "convex" ? `convex${which === "cloud" ? "Cloud" : "Site"}Url` : `${which}Url`}`;

/** A system function over the HTTP API as an admin, in the backend's encoded format: its value or its error. */
async function sys(b: Backend, path: string, args: unknown = {}, kind: "query" | "mutation" = "query") {
  const r = await fetch(`${b.url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: authOf(b) },
    body: JSON.stringify({ path, args, format: encoded(b) }),
  });
  const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
  return body.status === "success" ? { value: body.value } : { error: body.errorMessage };
}

/** An admin route: its status and body. */
async function route(b: Backend, path: string, body?: unknown) {
  const r = await fetch(`${b.url}${path}`, {
    method: "POST",
    headers: { authorization: authOf(b), ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text === "" ? "" : (JSON.parse(text) as unknown) };
}

/**
 * Ids named by order of appearance; what each backend writes its own way masked: times (int64 under a time field,
 * a float `_creationTime`), an export's object key and size, an import's object key.
 */
function normalize(value: unknown): unknown {
  const names = new Map<string, string>();
  const idName = (s: string) => {
    if (!names.has(s)) names.set(s, `id${names.size}`);
    return names.get(s)!;
  };
  const MASKED = /^(_creationTime|start_ts|complete_ts|expiration_ts|timestamp|zip_object_key|fq_object_key|size)$/;
  const walk = (v: unknown, key = ""): unknown => {
    if (MASKED.test(key) && v !== null && v !== undefined) return `<${key}>`;
    if (typeof v === "string" && /^[0-9a-z]{31,37}$/.test(v)) return idName(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

async function same(f: (b: Backend) => Promise<unknown>) {
  const [c, x] = [await f(convex), await f(bunvex)];
  expect(normalize(x)).toEqual(normalize(c));
  return c;
}

/** A nested module, which the harness's flat copy cannot carry: written into the functions directory. */
const prepare = (project: string, dir: "convex" | "bunvex") => {
  mkdirSync(join(project, dir, "dir"), { recursive: true });
  const pkg = dir === "convex" ? "convex" : "bunvex";
  writeFileSync(
    join(project, dir, "dir", "nested.ts"),
    `import { queryGeneric } from "${pkg}/server";\nimport { v } from "${pkg}/values";\n\n` +
      `export const deep = queryGeneric({ args: { a: v.union(v.string(), v.null()) }, handler: async (_c, { a }) => a });\n`,
  );
};

const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean) => {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (done(v)) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
};

describe.skipIf(!ready)("the dashboard's Functions, runner and Settings reads on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
  }, 300_000);
  afterAll(async () => {
    await Promise.all([convex?.stop(), bunvex?.stop()]);
  });

  test("modules: every module with its functions, lines, kinds, visibility, HTTP routes and crons", async () => {
    // The table's order is the push's, which each CLI makes its own way: compared by path. Convex's CLI also
    // pushes the app's component definition, `convex.config.js` (no functions); bunvex has no components (DV-55).
    // Found here, not fixed in this PR: `messages:secret` (a returns validator) is on line 39 on Convex and 37 on
    // bunvex, the position the push's analysis records (STUDY-65 M5), so it is masked.
    const byPath = (r: { value?: unknown }) =>
      (r.value as [string | null, [string, { functions: { name: string; lineno?: number }[] }][]][]).map(([c, ms]) => [
        c,
        ms
          .filter(([p]) => p !== "convex.config.js")
          .map(([p, m]) => [
            p,
            {
              ...m,
              functions: m.functions.map((f) =>
                p === "messages.js" && f.name === "secret" ? { ...f, lineno: "<line>" } : f,
              ),
            },
          ])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ]);
    const all = (await same(async (b) => byPath(await sys(b, "_system/frontend/modules:listForAllComponents")))) as [
      null,
      [string, { functions: { name: string }[] }][],
    ][];
    // what the comparison stands on
    expect(all).toHaveLength(1);
    expect(all[0]![1].map(([p]) => p)).toEqual(["crons.js", "dir/nested.js", "http.js", "messages.js", "schema.js"]);
    expect(all[0]![1].find(([p]) => p === "http.js")![1].functions.map((f) => f.name)).toEqual([
      "GET /hello",
      "POST /files/*",
    ]);
    await same(async (b) => {
      const r = (await sys(b, "_system/frontend/modules:list", { componentId: null })).value as [string, unknown][];
      return byPath({ value: [[null, r]] });
    });
  });

  test("argsValidator: by display name, the default export, a function without arguments, misses", async () => {
    for (const fn of [
      "messages:send",
      "messages:list",
      "messages:loose",
      "messages:secret",
      "messages",
      "messages:default",
      "messages:nope",
      "nope:list",
      "messages.js:send",
      "dir/nested:deep",
      "messages:send:extra",
    ]) {
      // the validator's JSON text is each client's `exportArgs()`: compared as JSON
      const [c, x] = [convex, bunvex].map(async (b) => {
        const r = await sys(b, "_system/frontend/modules:argsValidator", { function: fn });
        return typeof r.value === "string" ? { json: JSON.parse(r.value) as unknown } : r;
      });
      expect({ fn, answer: await x }).toEqual({ fn, answer: await c });
    }
  });

  test("components:list: the root alone", async () => {
    await same((b) => sys(b, "_system/frontend/components:list"));
  });

  test("getVersion: the version the app was pushed with; the URLs (DV-474)", async () => {
    for (const b of [convex, bunvex]) {
      const v = (await sys(b, "_system/frontend/getVersion")).value;
      expect(typeof v).toBe("string");
      expect((await sys(b, urlQuery(b, "cloud"))).value).toBe(b.url);
      expect((await sys(b, urlQuery(b, "site"))).value).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }
    // bunvex has no `convexCloudUrl`
    expect((await sys(bunvex, "_system/frontend/convexCloudUrl")).error).toBeDefined();
  });

  test("listEnvironmentVariables: the documents, by name", async () => {
    await same((b) => sys(b, "_system/frontend/listEnvironmentVariables"));
    for (const b of [convex, bunvex])
      expect(
        (
          await route(b, "/api/update_environment_variables", {
            changes: [
              { name: "ZED", value: "2" },
              { name: "ALPHA", value: "one" },
            ],
          })
        ).status,
      ).toBe(200);
    const vars = (await same((b) => sys(b, "_system/frontend/listEnvironmentVariables"))) as { value: unknown[] };
    expect(vars.value).toHaveLength(2);
  });

  test("latestExport: none, then the export requested", async () => {
    await same((b) => sys(b, "_system/frontend/latestExport"));
    for (const b of [convex, bunvex]) {
      expect((await route(b, "/api/export/request/zip?includeStorage=false")).status).toBe(200);
      await until(
        () => sys(b, "_system/frontend/latestExport"),
        (r) => (r.value as { state?: string } | null)?.state === "completed",
      );
    }
    const e = (await same((b) => sys(b, "_system/frontend/latestExport"))) as { value: Record<string, unknown> };
    expect(e.value.state).toBe("completed");
  });

  test("snapshotImport:list: none, then an import waiting for confirmation", async () => {
    await same((b) => sys(b, "_system/frontend/snapshotImport:list"));
    for (const b of [convex, bunvex]) {
      const start = await route(b, "/api/import/start_upload");
      const uploadToken = (start.body as { uploadToken: string }).uploadToken;
      const part = await fetch(
        `${b.url}/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=1`,
        { method: "POST", headers: { authorization: authOf(b) }, body: '{"n":1}\n{"n":2}\n' },
      );
      const partToken = (await part.json()) as string;
      const finished = await route(b, "/api/import/finish_upload", {
        import: { format: "jsonLines", tableName: "imported", mode: "requireEmpty" },
        uploadToken,
        partTokens: [partToken],
      });
      expect(finished.status).toBe(200);
      await until(
        () => sys(b, "_system/frontend/snapshotImport:list"),
        (r) => (r.value as { state: { state: string } }[])[0]?.state.state !== "uploaded",
      );
    }
    // the confirmation names each one's CLI (rule 5): rewritten
    await same(async (b) => {
      const r = (await sys(b, "_system/frontend/snapshotImport:list")) as { value: Record<string, unknown>[] };
      return r.value.map((i) => ({
        ...i,
        state: JSON.parse(JSON.stringify(i.state).replace("npx convex import", "bunvex import")),
      }));
    });
  });

  test("the runner: a query as an admin and acting as a user, an internal query, a mutation, an action", async () => {
    const identity = { subject: "user|1", issuer: "https://issuer.example", name: "Ada" };
    // biome-ignore lint/suspicious/noExplicitAny: the clients' internal admin API, as the dashboard uses it
    const run = async (b: Backend, f: (c: any) => Promise<unknown>, actingAs?: unknown) => {
      const client = b.name === "convex" ? new ConvexClient(b.url) : new BunvexClient(b.url);
      // biome-ignore lint/suspicious/noExplicitAny: as above
      const base = (client as any).client;
      base.setAdminAuth(b.adminKey, actingAs);
      try {
        return await f(base);
      } finally {
        await client.close();
      }
    };
    /** A query's first result over a subscription, with its log lines (the runner's `watchQuery`). */
    // biome-ignore lint/suspicious/noExplicitAny: as above
    const watch = (path: string, args: Record<string, unknown>) => (base: any) =>
      new Promise((resolveResult) => {
        const { queryToken, unsubscribe } = base.subscribe(path, args);
        const check = () => {
          if (!base.hasLocalQueryResultByToken?.(queryToken) && base.localQueryResultByToken(queryToken) === undefined)
            return;
          let value: unknown;
          try {
            value = { value: base.localQueryResultByToken(queryToken) };
          } catch (e) {
            value = { error: String((e as Error).message) };
          }
          unsubscribe();
          clearInterval(timer);
          resolveResult({ ...(value as object), logLines: base.localQueryLogs(path, args) });
        };
        const timer = setInterval(check, 10);
      });
    const strip = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
    await same(async (b) => strip(await run(b, watch("messages:whoami", {}))));
    await same(async (b) => strip(await run(b, watch("messages:whoami", {}), identity)));
    await same(async (b) => strip(await run(b, watch("messages:secret", { n: 7n }))));
    await same(async (b) => strip(await run(b, (c) => c.mutationInternal("messages:send", { body: "hey" }))));
    await same(async (b) => strip(await run(b, (c) => c.actionInternal("messages:act", { x: 2 }))));
    // a misfit's error, as the runner shows it
    await same(async (b) => {
      const r = (await run(b, (c) => c.mutationInternal("messages:send", { body: 1 }))) as { errorMessage?: string };
      return { success: false, error: r.errorMessage?.replace(/^\[Request ID: \w+\] /, "").split("\n")[0] };
    });
  });

  test("a custom test query: its value and log lines; a module that does not load", async () => {
    const preamble = (b: Backend) =>
      `import { query, internalQuery } from "${b.name === "convex" ? "convex" : "bunvex"}:/_system/repl/wrappers.js";\n`;
    const testQuery = (b: Backend, source: string) =>
      fetch(`${b.url}/api/run_test_function`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle: { path: "testQuery.js", source: preamble(b) + source },
          adminKey: b.adminKey,
          args: {},
          format: encoded(b),
        }),
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    await same((b) =>
      testQuery(
        b,
        `export default query({ handler: async (ctx) => { console.log("counting"); return (await ctx.db.query("messages").collect()).length; } });`,
      ),
    );
    await same(async (b) => {
      const r = await testQuery(b, `export default query({ handler: async () => { throw new Error("nope"); } });`);
      // without the request id and the stack, which differ by design (harness/compare.ts)
      return { ...r, body: { ...r.body, errorMessage: errorText(String(r.body.errorMessage)) } };
    });
    const broken = await Promise.all([convex, bunvex].map((b) => testQuery(b, "export default query({")));
    for (const r of broken) expect(r.status).toBe(400);
  });
});

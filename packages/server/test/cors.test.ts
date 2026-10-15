// Convex's CORS layer on the API (STUDY-67 H2, `router.rs` `cors()`): a page on another origin can call
// `/api/*`. Expected headers are what Convex's local backend answers (STUDY-67 §1.6).
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", { ok: query(async () => "ok") });
  const http = httpRouter();
  http.route({ path: "/plain", method: "GET", handler: httpAction(async () => new Response("plain")) });
  const s = createServer({ engine, functions, port: 0, sitePort: null, http });
  stops.push(s.stop);
  return `http://127.0.0.1:${s.server!.port}`;
}

const ORIGIN = "https://app.example";
const VARY = "origin, access-control-request-method, access-control-request-headers";
const cors = (r: Response) => ({
  origin: r.headers.get("access-control-allow-origin"),
  credentials: r.headers.get("access-control-allow-credentials"),
  vary: r.headers.get("vary"),
});

test("a call from another origin: the origin mirrored, credentials allowed; none without an Origin", async () => {
  const base = await setup();
  const call = (headers: Record<string, string>) =>
    fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ path: "m:ok", args: {} }),
    });
  const r = await call({ origin: ORIGIN });
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "success", value: "ok" });
  expect(cors(r)).toEqual({ origin: ORIGIN, credentials: "true", vary: VARY });
  expect(cors(await call({}))).toEqual({ origin: null, credentials: "true", vary: VARY });
});

test("a preflight: 200, no body, every method, a day's max age, the asked headers mirrored", async () => {
  const base = await setup();
  for (const path of ["/api/mutation", "/api/query_ts", "/api/storage/upload"]) {
    const r = await fetch(`${base}${path}`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expect(Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("access-control-")))).toEqual({
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,OPTIONS,PATCH,DELETE,PUT",
      "access-control-allow-headers": "content-type,authorization",
      "access-control-max-age": "86400",
    });
  }
});

test("request errors carry the headers too, so a page can read them", async () => {
  const base = await setup();
  const r = await fetch(`${base}/api/query`, { method: "POST", headers: { origin: ORIGIN }, body: "{nope" });
  expect(r.status).toBe(400);
  expect(cors(r).origin).toBe(ORIGIN);
});

test("the health route has them; /version and HTTP actions do not (they answer CORS themselves)", async () => {
  const base = await setup();
  expect(cors(await fetch(`${base}/instance_name`, { headers: { origin: ORIGIN } })).origin).toBe(ORIGIN);
  expect(cors(await fetch(`${base}/version`, { headers: { origin: ORIGIN } })).origin).toBeNull();
  const action = await fetch(`${base}/http/plain`, { headers: { origin: ORIGIN } });
  expect(await action.text()).toBe("plain");
  expect(cors(action)).toEqual({ origin: null, credentials: null, vary: null });
});

// The dashboard's routes from another origin (its image on 6791, `bunvex dashboard serve`, a page of its own): every
// route `@bunvex/dashboard-source` calls, with the admin key and the client header as it sends them. The
// preflight Chrome sends first, then the request itself: both need the layer, or the browser drops the answer.
describe("the dashboard's routes, from another origin", () => {
  const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
  const NAME = "carnitas";
  const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
  const AUTH = { authorization: `Bunvex ${KEY}`, "bunvex-client": "dashboard-0.0.0" };
  const ASKED = "authorization,bunvex-client,content-type";

  async function admin() {
    const engine = await new Engine(
      defineSchema({ items: defineTable(v.any()) }),
      await MemoryPersistence.open(null, { durable: false }),
      { instanceName: NAME, instanceSecret: SECRET },
    ).init();
    const functions = new Functions(engine).register("m", { ok: query(async () => "ok") });
    const s = createServer({ engine, functions, port: 0, sitePort: null, label: "memory" });
    stops.push(s.stop);
    return `http://127.0.0.1:${s.server!.port}`;
  }

  // [method, path, body]: what server-source.ts, credentials.ts, metrics.ts, logs.ts, settings.ts, tables.ts,
  // writes.ts, deployment.ts and functions.ts call (the sync socket is a WebSocket: no CORS)
  const ROUTES: [string, string, unknown?][] = [
    ["GET", "/instance_name"],
    ["GET", "/instance_version"],
    ["GET", "/stats"],
    ["GET", "/api/check_admin_key"],
    ["GET", "/api/shapes2"],
    ["POST", "/api/query", { path: "m:ok", args: {}, format: "json" }],
    ["POST", "/api/update_environment_variables", { changes: [] }],
    ["GET", "/api/v1/list_environment_variables"],
    ["GET", "/api/app_metrics/udf_rate?metric=invocations&udfIdentifier=m:ok&window={}"],
    ["GET", "/api/app_metrics/function_call_count_top_k?window={}&k=5"],
    ["GET", "/api/app_metrics/stream_function_logs?cursor=0"],
    ["POST", "/api/delete_tables", { tableNames: [] }],
    ["POST", "/api/cancel_all_jobs", {}],
    ["POST", "/api/cancel_job", { id: "nope" }],
    ["POST", "/api/v1/pause_deployment"],
    ["POST", "/api/v1/unpause_deployment"],
    ["POST", "/api/export/request/zip?includeStorage=false"],
    ["GET", "/api/export/zip/nope"],
    ["POST", "/api/import/start_upload"],
    ["POST", "/api/cancel_import", { importId: "nope" }],
    ["POST", "/api/run_test_function", {}],
    ["GET", "/api/debug/subscriptions"],
  ];

  test("each preflight: 200 with the layer's headers, the admin key's and the client's headers allowed", async () => {
    const base = await admin();
    for (const [method, path] of ROUTES) {
      const r = await fetch(`${base}${path}`, {
        method: "OPTIONS",
        headers: { origin: ORIGIN, "access-control-request-method": method, "access-control-request-headers": ASKED },
      });
      expect([path, r.status, await r.text()]).toEqual([path, 200, ""]);
      expect([path, Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("access-control-")))]).toEqual([
        path,
        {
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET,POST,OPTIONS,PATCH,DELETE,PUT",
          "access-control-allow-headers": ASKED,
          "access-control-max-age": "86400",
        },
      ]);
    }
  });

  test("each request: the origin mirrored and credentials allowed, whatever the status", async () => {
    const base = await admin();
    for (const [method, path, body] of ROUTES) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { origin: ORIGIN, ...AUTH, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      await r.arrayBuffer();
      // Convex's health and CLI routes are under two layers: the list once per layer
      const twice = /^\/(instance_|api\/(import|cancel_import|run_test_function))/.test(path);
      const vary = twice ? `${VARY}, ${VARY}` : VARY;
      expect([path, cors(r)]).toEqual([path, { origin: ORIGIN, credentials: "true", vary }]);
    }
  });

  test("what the deployment header reads answers: the name, the version, the counters", async () => {
    const base = await admin();
    const get = (path: string) => fetch(`${base}${path}`, { headers: { origin: ORIGIN, ...AUTH } });
    expect(await (await get("/instance_name")).text()).toBe(NAME);
    const version = await get("/instance_version");
    expect(version.status).toBe(200);
    expect(await version.text()).toBe(await (await fetch(`${base}/version`)).text());
    const stats = await get("/stats");
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { storage: string }).storage).toBe("memory");
    // without the key: refused, and still readable by the page (it shows the error)
    const refused = await fetch(`${base}/stats`, { headers: { origin: ORIGIN } });
    expect(refused.status).toBe(403);
    expect(cors(refused).origin).toBe(ORIGIN);
  });

  test("the meta /version stays outside the layer, as Convex's (the dashboard reads /instance_version)", async () => {
    const base = await admin();
    const pre = await fetch(`${base}/version`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": ASKED },
    });
    expect(pre.status).toBe(405);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

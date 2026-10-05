// `_system/` functions only for an admin or the system acting as itself, as Convex's
// `application_function_runner` (`path.is_system() && !(identity.is_admin() || identity.is_system())` →
// `unauthorized_error`: 403 `SystemIdentityRequired`, "Operation <op> not permitted") and
// `ModuleModel::get_metadata` (the same for reading a `_system/` module: `/api/run`, scheduling). Every entry
// point: the HTTP API, `/api/run`, an action's runQuery / runMutation / runAction, a query's or mutation's
// nested call, the scheduler, crons, function handles, an HTTP action.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { createFunctionHandle } from "../src/function-handles.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5c".repeat(32);
const NAME = "sysid-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 2 });
const SYSTEM = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), system: true });
const actingAs = (identity: object) => Buffer.from(JSON.stringify(identity)).toString("base64");
const SYS = "_system/cli/tables";
const PAGE = { paginationOpts: { numItems: 10, cursor: null } };

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const caught = async (f: () => Promise<unknown>) => {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

async function setup() {
  const engine = await new Engine(
    defineSchema({ log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    viaRunQuery: action(({ runQuery }) => caught(() => runQuery(SYS as never, PAGE))),
    viaRunMutation: action(({ runMutation }) =>
      caught(() => runMutation("_system/frontend/fileStorageV2:deleteFiles" as never, { storageIds: [] })),
    ),
    viaRunAction: action(({ runAction }) => caught(() => runAction("_system/x:y" as never, {}))),
    nested: mutation(({ runQuery }) => caught(() => runQuery(SYS as never, PAGE))),
    nestedInQuery: query(({ runQuery }) => caught(() => runQuery(SYS as never, PAGE))),
    schedule: mutation(({ scheduler }) => caught(() => scheduler.runAfter(0, SYS as never, PAGE))),
    scheduleFromAction: action(({ scheduler }) => caught(() => scheduler.runAfter(0, SYS as never, PAGE))),
    handle: mutation(() => caught(() => createFunctionHandle(SYS as never))),
  });
  const http = httpRouter();
  http.route({
    path: "/peek",
    method: "GET",
    handler: httpAction(async ({ runQuery }) => {
      const r = await caught(() => runQuery(SYS as never, PAGE));
      return new Response(JSON.stringify(r));
    }),
  });
  const s = createServer({ engine, functions, port: 0, http });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, auth?: string) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const call = (kind: string, path: string, args: object = {}, auth?: string) =>
    post(`/api/${kind}`, { path, args }, auth);
  return { engine, functions, post, call, site: s.siteUrl!, port: s.server.port };
}

const REFUSED = (op: string) => ({ code: "SystemIdentityRequired", message: `Operation ${op} not permitted` });

test("HTTP API: nobody and an admin acting as a user are refused before any lookup; an admin and the system run it", async () => {
  const t = await setup();
  for (const [path, args] of [
    [SYS, PAGE],
    ["_system/does/not:exist", {}],
  ] as const) {
    const r = await t.call("query", path, args);
    expect([r.status, r.body]).toEqual([403, REFUSED("query")]);
  }
  const acting = await t.call("query", SYS, PAGE, `Bunvex ${KEY}:${actingAs({ subject: "u", issuer: "i" })}`);
  expect([acting.status, acting.body]).toEqual([403, REFUSED("query")]);
  const m = await t.call("mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds: [] });
  expect([m.status, m.body]).toEqual([403, REFUSED("mutation")]);
  expect((await t.call("query", SYS, PAGE, `Bunvex ${KEY}`)).body.status).toBe("success");
  expect((await t.call("query", SYS, PAGE, `Bunvex ${SYSTEM}`)).body.status).toBe("success");
  // an admin asking for one that does not exist: not found
  const missing = await t.call("query", "_system/does/not:exist", {}, `Bunvex ${KEY}`);
  expect(missing.body.errorMessage).toContain("Could not find public function for '_system/does/not:exist'.");
});

test("/api/run: reading a system module is refused to nobody (get_module)", async () => {
  const t = await setup();
  const byPath = await t.post("/api/run/_system/cli/tables", { args: PAGE });
  expect([byPath.status, byPath.body]).toEqual([403, REFUSED("get_module")]);
});

test("an action's runQuery, runMutation and runAction: refused unless an admin ran the action", async () => {
  const t = await setup();
  const value = async (path: string, auth?: string) => (await t.call("action", path, {}, auth)).body.value;
  expect(await value("m:viaRunQuery")).toEqual({ ok: false, error: "Operation query not permitted" });
  expect(await value("m:viaRunMutation")).toEqual({ ok: false, error: "Operation mutation not permitted" });
  expect(await value("m:viaRunAction")).toEqual({ ok: false, error: "Operation action not permitted" });
  // run by an admin, the action's calls are the admin's
  expect((await value("m:viaRunQuery", `Bunvex ${KEY}`)).ok).toBe(true);
  expect((await value("m:viaRunMutation", `Bunvex ${KEY}`)).ok).toBe(true);
  // acting as a user, it is that user's
  const acting = await value("m:viaRunQuery", `Bunvex ${KEY}:${actingAs({ subject: "u", issuer: "i" })}`);
  expect(acting).toEqual({ ok: false, error: "Operation query not permitted" });
});

test("a mutation's or query's nested call: refused to nobody", async () => {
  const t = await setup();
  expect((await t.call("mutation", "m:nested")).body.value).toEqual({
    ok: false,
    error: "Operation query not permitted",
  });
  expect((await t.call("query", "m:nestedInQuery")).body.value).toEqual({
    ok: false,
    error: "Operation query not permitted",
  });
});

test("the scheduler: scheduling a system function is refused (get_module); for an admin it does not exist", async () => {
  const t = await setup();
  expect((await t.call("mutation", "m:schedule")).body.value).toEqual({
    ok: false,
    error: "Operation get_module not permitted",
  });
  expect((await t.call("action", "m:scheduleFromAction")).body.value).toEqual({
    ok: false,
    error: "Operation get_module not permitted",
  });
  expect((await t.call("mutation", "m:schedule", {}, `Bunvex ${KEY}`)).body.value).toEqual({
    ok: false,
    error: "Attempted to schedule function at nonexistent path: _system/cli/tables.js",
  });
});

test("crons and function handles never point at a system function", async () => {
  const t = await setup();
  expect(() => t.functions.cronTarget("c", SYS)).toThrow("schedules a function that does not exist");
  expect((await t.call("mutation", "m:handle")).body.value).toEqual({
    ok: false,
    error: "Cannot create function handle for system UDF",
  });
});

test("an HTTP action's runQuery: refused to its anonymous caller", async () => {
  const t = await setup();
  const r = await (await fetch(`${t.site}/peek`)).json();
  expect(r).toEqual({ ok: false, error: "Operation query not permitted" });
});

test("sync: a subscription to a system query without an admin fails with the refusal", async () => {
  const t = await setup();
  const c = await v1Client(syncUrl(t.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, SYS, PAGE)]);
  const tr = await c.transition(0);
  const m = tr.modifications[0] as any;
  expect(m.type).toBe("QueryFailed");
  expect(m.errorMessage).toContain("Operation query not permitted");
});

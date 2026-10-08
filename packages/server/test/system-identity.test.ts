// `_system/` functions only for an admin or the system acting as itself, as Convex's
// `application_function_runner` (`path.is_system() && !(identity.is_admin() || identity.is_system())` →
// `unauthorized_error`, `SystemIdentityRequired`, "You don't have permission to perform this operation.", before b352fab "Operation <op> not permitted") and `ModuleModel::get_metadata`
// (the same for reading a `_system/` module: `/api/run`, scheduling). Every expectation here was checked against
// Convex's local backend (precompiled-2026-09-28): the HTTP API (a query's or mutation's refusal is its error,
// an action's a 403), `/api/run` and `/api/function`, an action's calls (never resolved), a query's or
// mutation's nested call (not found, or run for an admin), the scheduler, crons, function handles, an HTTP
// action, and a sync subscription.
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

const REFUSED = (_op: string) => ({ code: "SystemIdentityRequired", message: "You don't have permission to perform this operation." });

/** A query's or mutation's refusal, as Convex answers it: the function's error, not a 403. */
const REFUSED_RUN = (_op: string) =>
  expect.stringMatching(/Server Error\nYou don't have permission to perform this operation\.\n$/);

test("HTTP API: nobody and an admin acting as a user are refused before any lookup; an admin and the system run it", async () => {
  const t = await setup();
  for (const [path, args] of [
    [SYS, PAGE],
    ["_system/does/not:exist", {}],
  ] as const) {
    const r = await t.call("query", path, args);
    expect([r.status, r.body.status, r.body.errorMessage]).toEqual([200, "error", REFUSED_RUN("query")]);
  }
  const acting = await t.call("query", SYS, PAGE, `Bunvex ${KEY}:${actingAs({ subject: "u", issuer: "i" })}`);
  expect([acting.status, acting.body.errorMessage]).toEqual([200, REFUSED_RUN("query")]);
  const m = await t.call("mutation", "_system/frontend/fileStorageV2:deleteFiles", { storageIds: [] });
  expect([m.status, m.body.errorMessage]).toEqual([200, REFUSED_RUN("mutation")]);
  // an action's refusal is the request's (403), as Convex's
  const a = await t.call("action", "_system/x:y", {});
  expect([a.status, a.body]).toEqual([403, REFUSED("action")]);
  expect((await t.call("query", SYS, PAGE, `Bunvex ${KEY}`)).body.status).toBe("success");
  expect((await t.call("query", SYS, PAGE, `Bunvex ${SYSTEM}`)).body.status).toBe("success");
  // an admin asking for one that does not exist: Convex's module lookup words it
  const noModule = await t.call("query", "_system/does/not:exist", {}, `Bunvex ${KEY}`);
  expect(noModule.body.errorMessage).toEndWith(`Couldn't find system module '"does/not.js"'.\n`);
  const noFunction = await t.call("query", "_system/cli/tables:nope", {}, `Bunvex ${KEY}`);
  expect(noFunction.body.errorMessage).toEndWith(`Couldn't find "nope" in module "_system/cli/tables.js".\n`);
  // an admin's action of a system path: there are none; Convex's internal error
  const adminAction = await t.call("action", "_system/x:y", {}, `Bunvex ${KEY}`);
  expect([adminAction.status, adminAction.body.code]).toEqual([500, "InternalServerError"]);
});

test("/api/run and /api/function: refused to nobody (get_module); not found even to an admin", async () => {
  const t = await setup();
  const byPath = await t.post("/api/run/_system/cli/tables", { args: PAGE });
  expect([byPath.status, byPath.body]).toEqual([403, REFUSED("get_module")]);
  for (const r of [
    await t.post("/api/run/_system/cli/tables/default", { args: PAGE }, `Bunvex ${KEY}`),
    await t.post("/api/function", { path: SYS, args: PAGE }, `Bunvex ${KEY}`),
  ]) {
    expect(r.body.status).toBe("error");
    expect(r.body.errorMessage).toMatch(
      /Could not find function for '_system\/cli[/:]tables'\. Did you forget to run `bunvex dev`\?/,
    );
  }
});

test("an action's runQuery, runMutation and runAction never resolve a system function, whoever runs it", async () => {
  const t = await setup();
  const value = async (path: string, auth?: string) => (await t.call("action", path, {}, auth)).body.value;
  for (const auth of [undefined, `Bunvex ${KEY}`]) {
    expect(await value("m:viaRunQuery", auth)).toEqual({
      ok: false,
      error: "Couldn't resolve api._system.cli.tables.default",
    });
    expect(await value("m:viaRunMutation", auth)).toEqual({
      ok: false,
      error: "Couldn't resolve api._system.frontend.fileStorageV2.deleteFiles",
    });
    expect(await value("m:viaRunAction", auth)).toEqual({ ok: false, error: "Couldn't resolve api._system.x.y" });
  }
});

test("a mutation's or query's nested call: not found to nobody; an admin's runs it", async () => {
  const t = await setup();
  const missing = { ok: false, error: "Could not find public function for '_system/cli/tables'." };
  expect((await t.call("mutation", "m:nested")).body.value).toEqual(missing);
  expect((await t.call("query", "m:nestedInQuery")).body.value).toEqual(missing);
  const ran = { ok: true, value: { page: [{ name: "log" }], isDone: true, continueCursor: "end" } };
  expect((await t.call("mutation", "m:nested", {}, `Bunvex ${KEY}`)).body.value).toEqual(ran);
  expect((await t.call("query", "m:nestedInQuery", {}, `Bunvex ${KEY}`)).body.value).toEqual(ran);
  // acting as a user, it is that user's
  const acting = await t.call("mutation", "m:nested", {}, `Bunvex ${KEY}:${actingAs({ subject: "u", issuer: "i" })}`);
  expect(acting.body.value).toEqual(missing);
});

test("the scheduler: scheduling a system function is refused (get_module); for an admin it does not exist", async () => {
  const t = await setup();
  expect((await t.call("mutation", "m:schedule")).body.value).toEqual({
    ok: false,
    error: "You don't have permission to perform this operation.",
  });
  expect((await t.call("action", "m:scheduleFromAction")).body.value).toEqual({
    ok: false,
    error: "You don't have permission to perform this operation.",
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

test("an HTTP action's runQuery never resolves a system function", async () => {
  const t = await setup();
  const r = await (await fetch(`${t.site}/peek`)).json();
  expect(r).toEqual({ ok: false, error: "Couldn't resolve api._system.cli.tables.default" });
});

test("sync: a subscription to a system query without an admin fails with the refusal", async () => {
  const t = await setup();
  const c = await v1Client(syncUrl(t.port));
  stops.push(() => c.ws.close());
  c.modify([add(1, SYS, PAGE)]);
  const tr = await c.transition(0);
  const m = tr.modifications[0] as any;
  expect(m.type).toBe("QueryFailed");
  expect(m.errorMessage).toContain("You don't have permission to perform this operation.");
});

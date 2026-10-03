// Pausing a deployment (STUDY-57), as Convex's: `/api/v1/pause_deployment` and `/api/v1/unpause_deployment`
// set `_backend_state.user`, with an audit event when it changes. While paused, user functions fail (system
// ones run), scheduled functions and crons wait, and file storage refuses; on unpause everything resumes.
import { afterEach, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, adminCallerOf, Functions, mutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const SECRET = "5a".repeat(32);
const NAME = "pause-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 3 });
const READ_ONLY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });
const PAUSED =
  "Cannot run functions while this deployment is paused. Resume the deployment in the dashboard settings to allow functions to run.";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** Lets a running action go on once the test says so. */
let gate: Promise<void> = Promise.resolve();

async function setup() {
  const engine = await new Engine(
    defineSchema({ log: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine).register("m", {
    count: query(async ({ db }) => (await db.query("log").collect()).length),
    echo: query((_ctx, { x }: { x: number }) => x),
    // The caller's usage so far, as a nested call's budget shows it (its limit = usage + budget).
    usage: query(async ({ runQuery }, { limit }: { limit: "documentsRead" | "databaseQueries" }) => {
      try {
        return await runQuery("m:count" as never, {}, { transactionLimits: { [limit]: 0 } });
      } catch (e) {
        return (e as Error).message.split("\n")[0];
      }
    }),
    add: mutation(({ db }, { tag }: { tag: string }) => db.insert("log", { tag })),
    later: mutation(({ scheduler }, { ms }: { ms: number }) =>
      scheduler.runAfter(ms, "m:add" as never, { tag: "job" }),
    ),
    shout: action((_ctx, { s }: { s: string }) => s.toUpperCase()),
    storeAfterGate: action(async ({ storage }) => {
      await gate;
      return storage.store(new Blob(["x"]));
    }),
    uploadUrl: mutation(({ storage }) => storage.generateUploadUrl()),
    urlOf: query(({ storage }, { id }: { id: string }) => storage.getUrl(id as never)),
  });
  const http = httpRouter();
  http.route({ path: "/hi", method: "GET", handler: httpAction(async () => new Response("hi")) });
  const s = createServer({ engine, functions, port: 0, http, fileStorage: new MemoryBlobStore() });
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = (path: string, body?: object, key = KEY) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { authorization: `Bunvex ${key}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const call = async (kind: string, path: string, args: object = {}, key = KEY) =>
    (await (await post(`/api/${kind}`, { path, args }, key)).json()) as {
      status: string;
      value?: any;
      errorMessage?: string;
    };
  const events = async () =>
    ((await engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect()))) as any[]).map(
      (e) => [e.action, e.metadata],
    );
  return { engine, api, site: s.siteUrl!, post, call, events };
}

test("pause and unpause: 200 with no body, the state, one audit event per change, Convex's errors", async () => {
  const t = await setup();
  const state = async () => (await t.call("query", "_system/frontend/backendState")).value;
  expect(await state()).toEqual({ system: "none", usage_limit: "none", user: "none" });
  const unpauseFirst = await t.post("/api/v1/unpause_deployment");
  expect([unpauseFirst.status, await unpauseFirst.json()]).toEqual([
    400,
    { code: "UnpauseDeploymentFailed", message: "Deployment is not currently paused." },
  ]);
  const r = await t.post("/api/v1/pause_deployment");
  expect([r.status, await r.text()]).toEqual([200, ""]);
  expect(await state()).toEqual({ system: "none", usage_limit: "none", user: "paused" });
  expect((await t.call("query", "_system/frontend/deploymentState")).value).toEqual({ state: "paused" });
  // Pausing again: 200, no change, no second event.
  expect((await t.post("/api/v1/pause_deployment")).status).toBe(200);
  expect(await t.events()).toEqual([["pause_deployment", {}]]);
  expect((await t.post("/api/v1/unpause_deployment")).status).toBe(200);
  expect(await t.events()).toEqual([
    ["pause_deployment", {}],
    ["unpause_deployment", {}],
  ]);
  expect((await t.call("query", "_system/frontend/deploymentState")).value).toEqual({ state: "running" });
});

test("the state check is a system read: out of the function's limits, as Convex's system_tx_size", async () => {
  const t = await setup();
  await t.call("mutation", "m:add", { tag: "a" });
  // A stored state document (pause, unpause), read by the check before the function runs.
  await t.post("/api/v1/pause_deployment");
  await t.post("/api/v1/unpause_deployment");
  // Twice each: the scan, then the cached state.
  for (const limit of ["documentsRead", "databaseQueries", "documentsRead", "databaseQueries"])
    expect((await t.call("query", "m:usage", { limit })).value).toStartWith(
      limit === "documentsRead"
        ? "Uncaught Error: Too many documents read in a single function execution (limit: 0)."
        : "Uncaught Error: Too many reads in a single function execution (limit: 0).",
    );
});

test("a read-only key cannot pause, but reads the state (noPermissionRequired)", async () => {
  const t = await setup();
  const r = await t.post("/api/v1/pause_deployment", undefined, READ_ONLY);
  expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([403, "OperationNotPermitted"]);
  expect((await t.call("query", "_system/frontend/deploymentState", {}, READ_ONLY)).value).toEqual({
    state: "running",
  });
});

test("the state queries need no operation: a key with none of ViewData's may run them", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine);
  const caller = adminCallerOf(
    { kind: "admin", memberId: 1, readOnly: true, allowedOps: ["ViewLogs"], issuedS: 0 },
    null,
  );
  expect(await functions.runQuery("_system/frontend/deploymentState", {}, true, caller)).toEqual({ state: "running" });
  expect(() => functions.checkQueryAccess("_system/cli/tables", caller)).toThrow("(deployment:data:view)");
});

test("while paused user functions fail with Convex's message (a cached query too); system ones run", async () => {
  const t = await setup();
  expect((await t.call("query", "m:count")).value).toBe(0); // now cached
  // Run after the state was read once: served from the engine's state cache, and cached itself.
  expect((await t.call("query", "m:echo", { x: 1 })).value).toBe(1);
  await t.post("/api/v1/pause_deployment");
  expect((await t.call("query", "m:echo", { x: 1 })).errorMessage).toEndWith(`${PAUSED}\n`);
  for (const [kind, path, args] of [
    ["query", "m:count", {}],
    ["mutation", "m:add", { tag: "a" }],
    ["action", "m:shout", { s: "a" }],
    // Convex checks the state before it resolves the path.
    ["query", "m:nope", {}],
  ] as const) {
    const r = await t.call(kind, path, args);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toEndWith(`Server Error\n${PAUSED}\n`);
  }
  expect((await t.call("query", "_system/frontend/backendState")).status).toBe("success");
  const http = await fetch(`${t.site}/hi`);
  expect(http.status).toBe(500);
  expect(await http.text()).toContain(PAUSED);
  await t.post("/api/v1/unpause_deployment");
  expect((await t.call("mutation", "m:add", { tag: "a" })).status).toBe("success");
  expect((await t.call("query", "m:count")).value).toBe(1);
  expect((await t.call("action", "m:shout", { s: "a" })).value).toBe("A");
  expect(await (await fetch(`${t.site}/hi`)).text()).toBe("hi");
});

test("scheduled functions wait while paused and run on unpause", async () => {
  const t = await setup();
  await t.call("mutation", "m:later", { ms: 200 });
  await t.post("/api/v1/pause_deployment");
  await Bun.sleep(500);
  const count = () => t.engine.query(async (db) => (await db.query("log").collect()).length);
  expect(await count()).toBe(0);
  await t.post("/api/v1/unpause_deployment");
  for (let i = 0; i < 100 && (await count()) === 0; i++) await Bun.sleep(10);
  expect(await count()).toBe(1);
});

test("file storage refuses while paused: upload, download and an action's ctx.storage (400 BackendIsNotRunning)", async () => {
  const t = await setup();
  const uploadUrl = (await t.call("mutation", "m:uploadUrl")).value as string;
  const { storageId } = (await (await fetch(uploadUrl, { method: "POST", body: "hello" })).json()) as {
    storageId: string;
  };
  const url = (await t.call("query", "m:urlOf", { id: storageId })).value as string;
  let open!: () => void;
  gate = new Promise((r) => {
    open = r;
  });
  const running = t.call("action", "m:storeAfterGate");
  await Bun.sleep(50);
  await t.post("/api/v1/pause_deployment");
  open();
  const notRunning = {
    code: "BackendIsNotRunning",
    message: "Cannot perform this operation when the backend is not running",
  };
  expect((await running).errorMessage).toContain(notRunning.message);
  const up = await fetch(uploadUrl, { method: "POST", body: "again" });
  expect([up.status, await up.json()]).toEqual([400, notRunning]);
  const down = await fetch(url);
  expect([down.status, await down.json()]).toEqual([400, notRunning]);
  await t.post("/api/v1/unpause_deployment");
  expect(await (await fetch(url)).text()).toBe("hello");
});

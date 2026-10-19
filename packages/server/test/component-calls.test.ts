// Calls across components (STUDY-155 PR 1): the app's queries, mutations and actions calling a child component's
// public functions by reference, in the nested transaction, with Convex's identity rule, argument checks, errors,
// texts and log lines.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import type { ModuleSource } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import type { LogEvent } from "../src/log-events.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "ab".repeat(32);
const NAME = "component-calls-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, lines: string[]): ModuleSource => ({
  path,
  source: lines.join("\n"),
  environment: "isolate",
});
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

const APP_DEFINITION = mod("bunvex.config.js", [
  'import { defineApp } from "bunvex/server";',
  `import counter from "${dep("counter")}";`,
  "const app = defineApp();",
  "app.use(counter);",
  "export default app;",
]);
const NO_COMPONENTS = mod("bunvex.config.js", [
  'import { defineApp } from "bunvex/server";',
  "export default defineApp();",
]);
/** The app: its own `messages`, and functions calling `counter`'s. */
const APP_SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "export default defineSchema({ messages: defineTable({ text: v.string() }), items: defineTable({ n: v.number() }) });",
]);
const APP = mod("app.js", [
  'import { action, componentsGeneric, createFunctionHandle, mutation, query } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "const components = componentsGeneric();",
  "const c = components.counter.lib;",
  "export const count = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.count, {}) });",
  "export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.runMutation(c.add, a) });",
  "export const rolledBack = mutation({ args: {}, handler: async (ctx) => { let caught = null; try { await ctx.runMutation(c.addThenThrow, {}); } catch (e) { caught = e.message; } return { caught, count: await ctx.runQuery(c.count, {}) }; } });",
  "export const refusal = mutation({ args: { which: v.string() }, handler: async (ctx, { which }) => { const ref = { child: components.nope.lib.x, internal: c.secret, branch: components.counter.lib, bare: components.counter, kind: c.add }[which]; try { await ctx.runQuery(ref, {}); return null; } catch (e) { return e.message; } } });",
  "export const whoFromMutation = mutation({ args: {}, handler: async (ctx) => ctx.runQuery(c.whoami, {}) });",
  "export const whoFromAction = action({ args: {}, handler: async (ctx) => ctx.runQuery(c.whoami, {}) });",
  "export const fromAction = action({ args: {}, handler: async (ctx) => { await ctx.runMutation(c.add, { body: 'from action' }); let miss = null; try { await ctx.runQuery(c.missing, {}); } catch (e) { miss = e.message; } return { count: await ctx.runQuery(c.count, {}), miss }; } });",
  "export const idAcross = mutation({ args: { table: v.string() }, handler: async (ctx, { table }) => { const id = table === 'messages' ? await ctx.db.insert('messages', { text: 't' }) : await ctx.db.insert('items', { n: 1 }); try { return await ctx.runQuery(c.takesId, { id }); } catch (e) { return e.message; } } });",
  "export const errorAcross = mutation({ args: {}, handler: async (ctx) => { try { await ctx.runMutation(c.boom, {}); } catch (e) { return { name: e.name, data: e.data, message: e.message.split('\\n')[0] }; } } });",
  "export const deep = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { try { return await ctx.runMutation(c.recurse, { n }); } catch (e) { return e.message; } } });",
  "export const scheduleIt = mutation({ args: {}, handler: async (ctx) => { try { await ctx.scheduler.runAfter(0, c.add, { body: 'later' }); return null; } catch (e) { return e.message; } } });",
  "export const viaHandle = mutation({ args: {}, handler: async (ctx) => { const h = await createFunctionHandle(c.add); await ctx.runMutation(h, { body: 'by handle' }); return { h, count: await ctx.runQuery(c.count, {}) }; } });",
  "export const callHandle = mutation({ args: { h: v.string() }, handler: async (ctx, { h }) => { try { return await ctx.runQuery(h, {}); } catch (e) { return e.message; } } });",
  "export const record = mutation({ args: { text: v.string() }, handler: async (ctx, a) => { await ctx.db.insert('messages', a); return (await ctx.db.query('messages').collect()).length; } });",
  "export const callBack = mutation({ args: {}, handler: async (ctx) => { const h = await createFunctionHandle('app:record'); return ctx.runMutation(c.callBack, { h }); } });",
  "export const internalByHandle = mutation({ args: {}, handler: async (ctx) => ctx.runQuery(await ctx.runMutation(c.secretHandle, {}), {}) });",
  "export const scheduleHandle = mutation({ args: {}, handler: async (ctx) => { try { await ctx.scheduler.runAfter(0, await createFunctionHandle(c.add), { body: 'x' }); return null; } catch (e) { return e.message; } } });",
  "export const logged = mutation({ args: {}, handler: async (ctx) => { console.log('app line'); await ctx.runMutation(c.logIt, {}); } });",
]);
const COUNTER = {
  definitionPath: "counter",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("counter");',
  ]),
  dependencies: [] as string[],
  schema: mod("schema.js", [
    'import { defineSchema, defineTable } from "bunvex/server";',
    'import { v } from "bunvex/values";',
    "export default defineSchema({ messages: defineTable({ body: v.string() }) });",
  ]),
  functions: [
    mod("lib.js", [
      'import { createFunctionHandle, internalQuery, mutation, query } from "bunvex/server";',
      'import { BunvexError, v } from "bunvex/values";',
      "export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert('messages', a); } });",
      "export const addThenThrow = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert('messages', { body: 'gone' }); throw new Error('nope'); } });",
      "export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).length });",
      "export const secret = internalQuery({ args: {}, handler: async () => 'internal' });",
      "export const whoami = query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null });",
      "export const takesId = query({ args: { id: v.id('messages') }, handler: async () => 'accepted' });",
      "export const boom = mutation({ args: {}, handler: async () => { throw new BunvexError({ code: 42 }); } });",
      "export const recurse = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => n === 0 ? 'bottom' : ctx.runMutation('lib:recurse', { n: n - 1 }) });",
      "export const callBack = mutation({ args: { h: v.string() }, handler: async (ctx, { h }) => ctx.runMutation(h, { text: 'from child' }) });",
      "export const secretHandle = mutation({ args: {}, handler: async () => createFunctionHandle('lib:secret') });",
      "export const logIt = mutation({ args: {}, handler: async () => { console.log('component line'); } });",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-calls-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  await s.codeReady;
  stops.push(async () => {
    s.server.stop(true);
    await engine.close();
  });
  const api = `http://127.0.0.1:${s.server.port}`;
  const post = async (path: string, body: object, auth: string | null = `Bunvex ${KEY}`) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  /** A push of the app, with `counter` mounted or not. */
  const push = async (withCounter = true) => {
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition: withCounter ? APP_DEFINITION : NO_COMPONENTS,
        dependencies: withCounter ? ["counter"] : [],
        schema: APP_SCHEMA,
        changedModules: [APP],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: withCounter ? [COUNTER] : [],
    });
    if (start.status !== 200) throw new Error(JSON.stringify(start.body));
    await post("/api/deploy2/wait_for_schema", {
      adminKey: KEY,
      schemaChange: start.body!.schemaChange,
      timeoutMs: 5000,
    });
    const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
    if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  };
  await push();
  /** The app's function `path`, called as a client (no admin key). */
  const call = async (kind: "query" | "mutation" | "action", path: string, args: object = {}) =>
    (await post(`/api/${kind}`, { path, args, format: "json" }, null)).body!;
  return { engine, functions, s, post, call, push };
}

describe("the app calling a child component", () => {
  test("its query and mutation by reference, in the component's namespace", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:add", { body: "a" })).status).toBe("success");
    expect((await d.call("query", "app:count")).value).toBe(1);
  });

  test("a failed nested mutation's writes are rolled back; the caller catches and goes on", async () => {
    const d = await deployment();
    await d.call("mutation", "app:add", { body: "kept" });
    const r = (await d.call("mutation", "app:rolledBack")).value;
    expect(r.caught).toStartWith("Uncaught Error: nope");
    expect(r.count).toBe(1);
  });

  test("Convex's texts: an unknown child, an internal or missing export, a branch (DV-531), the wrong kind", async () => {
    const d = await deployment();
    const refusal = async (which: string) => (await d.call("mutation", "app:refusal", { which })).value;
    expect(await refusal("child")).toBe("Child component 'nope' not found");
    expect(await refusal("internal")).toBe("Child component 'counter' does not export 'lib.secret'");
    expect(await refusal("branch")).toBe("Child component 'counter' does not export 'lib'");
    expect(await refusal("bare")).toBe("Child component 'counter' does not export ''");
    expect(await refusal("kind")).toContain(
      "Trying to execute lib.js:add in 'counter' as Query, but it is defined as Mutation.",
    );
  });

  test("from an action: its own transactions, and an action's miss reads as Convex's map's", async () => {
    const d = await deployment();
    expect((await d.call("action", "app:fromAction")).value).toEqual({
      count: 1,
      miss: "Couldn't resolve counter.lib.missing",
    });
  });

  test("identity: the caller's from a mutation, none from an action (propagate_component_auth)", async () => {
    const d = await deployment();
    // An admin acting as a user: the identity a mutation passes on, and an action does not.
    const asUser = async (kind: "mutation" | "action", path: string) =>
      (
        await d.post(
          `/api/${kind}`,
          { path, args: {}, format: "json" },
          `Bunvex ${KEY}:${Buffer.from(JSON.stringify({ subject: "user-1", issuer: "https://issuer.test" })).toString("base64")}`,
        )
      ).body!;
    expect((await asUser("mutation", "app:whoFromMutation")).value).toBe("user-1");
    expect((await asUser("action", "app:whoFromAction")).value).toBeNull();
  });

  test("arguments are checked in the component's namespace: an app id of the same table name and number passes (C4)", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:idAcross", { table: "messages" })).value).toBe("accepted");
    expect((await d.call("mutation", "app:idAcross", { table: "items" })).value).toContain("ArgumentValidationError");
  });

  test("a BunvexError crosses with its data; the depth limit counts calls inside a component", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:errorAcross")).value).toMatchObject({ data: { code: 42 } });
    expect((await d.call("mutation", "app:deep", { n: 3 })).value).toBe("bottom");
    expect((await d.call("mutation", "app:deep", { n: 10 })).value).toContain(
      "Cross component call depth limit exceeded",
    );
  });

  test("a nested call's console lines name the component's function in the log stream (Q-5)", async () => {
    const d = await deployment();
    const events: LogEvent[] = [];
    d.functions.logManager = { active: true, send: (e: LogEvent[]) => events.push(...e) } as never;
    await d.call("mutation", "app:logged");
    const consoles = events.filter((e) => e.event.topic === "console") as (LogEvent & {
      event: { source: { path: string; componentPath?: string | null } };
    })[];
    expect(consoles.map((e) => [e.event.source.path, e.event.source.componentPath ?? null])).toEqual([
      ["app.js:logged", null],
      ["lib.js:logIt", "counter"],
    ]);
  });

  test("a subscription to the app's query re-runs when the component's data changes", async () => {
    const d = await deployment();
    const c = await v1Client(syncUrl(d.s.server.port));
    stops.push(() => c.ws.close());
    c.modify([{ type: "Add", queryId: 1, udfPath: "app:count", args: [{}] }]);
    await c.until(() =>
      c
        .transitions()
        .some((t) => t.modifications.some((m) => m.type === "QueryUpdated" && (m as { value: unknown }).value === 0)),
    );
    await d.call("mutation", "app:add", { body: "x" });
    await c.until(() =>
      c
        .transitions()
        .some((t) => t.modifications.some((m) => m.type === "QueryUpdated" && (m as { value: unknown }).value === 1)),
    );
  });

  test("scheduling a component's function: not yet (Q-4)", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:scheduleIt")).value).toBe(
      "Scheduling a function of a component is not supported yet",
    );
  });
});

describe("function handles across components (PR 2)", () => {
  test("the app's handle to a component's function; calling it", async () => {
    const d = await deployment();
    const r = (await d.call("mutation", "app:viaHandle")).value;
    expect(r.h).toStartWith("function://");
    expect(r.count).toBe(1);
  });

  test("a child calls back into the app through a handle, in the app's namespace", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:callBack")).value).toBe(1);
  });

  test("a handle reaches an internal function the component hands out", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:internalByHandle")).value).toBe("internal");
  });

  test("an unmounted component's handles are gone: Function handle not found", async () => {
    const d = await deployment();
    const { h } = (await d.call("mutation", "app:viaHandle")).value;
    await d.push(false);
    expect((await d.call("mutation", "app:callHandle", { h })).value).toContain("Function handle not found");
  });

  test("scheduling a component's function through a handle: not yet (Q-4)", async () => {
    const d = await deployment();
    expect((await d.call("mutation", "app:scheduleHandle")).value).toBe(
      "Scheduling a function of a component is not supported yet",
    );
  });
});

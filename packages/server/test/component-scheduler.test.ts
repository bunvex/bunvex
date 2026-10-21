// The scheduler in components (STUDY-157 PR 1): Convex's "Scheduler in component" cases (js-integration-tests
// scheduler.test.ts) and component.test.ts's handle case, rewritten for bunvex, plus an action's schedule and cancel
// (DV-536), the limits across nested calls, a job whose component was unmounted, `_scheduled_functions`' `component`
// (AD-33), the cascade of a canceled job across namespaces and `/api/cancel_job` with a `componentId`.
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
import type { SchedulerOptions } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";

const SECRET = "ab".repeat(32);
const NAME = "component-scheduler-test";
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
const SCHEMA = mod("schema.js", [
  'import { defineSchema, defineTable } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "export default defineSchema({ messages: defineTable({ body: v.string() }) });",
]);
/** A job's document in the caller's namespace, or null when the id names none there. */
const JOB =
  "async (ctx, { id }) => { const n = ctx.db.system.normalizeId('_scheduled_functions', id); return n && ctx.db.system.get(n); }";
const APP = mod("app.js", [
  'import { action, componentsGeneric, createFunctionHandle, mutation, query } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  "const c = componentsGeneric().counter.lib;",
  "export const addMessage = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert('messages', a); } });",
  "export const scheduleInParent = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.scheduler.runAfter(0, 'app:addMessage', a) });",
  "export const scheduleChildFromParent = mutation({ args: { body: v.string(), delay: v.optional(v.number()) }, handler: async (ctx, { body, delay }) => ctx.scheduler.runAfter(delay ?? 0, c.add, { body }) });",
  "export const scheduleWithinComponent = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.runMutation(c.scheduleSelf, a) });",
  "export const scheduleByHandle = mutation({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(0, await createFunctionHandle(c.add), { body: 'by handle' }) });",
  "export const scheduleParent = mutation({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(0, c.parent, {}) });",
  "export const scheduleFromAction = action({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(0, c.add, { body: 'from action' }) });",
  "export const refusal = mutation({ args: { which: v.string() }, handler: async (ctx, { which }) => { const ref = { internal: c.secret, query: c.count }[which]; try { return await ctx.scheduler.runAfter(0, ref, {}); } catch (e) { return e.message; } } });",
  "export const tooMany = mutation({ args: {}, handler: async (ctx) => { for (let i = 0; i < 600; i++) await ctx.scheduler.runAfter(60000, 'app:addMessage', { body: 'x' }); try { await ctx.runMutation(c.scheduleMany, { n: 500 }); return null; } catch (e) { return e.message; } } });",
  `export const job = query({ args: { id: v.string() }, handler: ${JOB} });`,
  "export const jobInComponent = query({ args: { id: v.string() }, handler: async (ctx, a) => ctx.runQuery(c.job, a) });",
  "export const cancel = mutation({ args: { id: v.string() }, handler: async (ctx, { id }) => { await ctx.scheduler.cancel(id); } });",
  "export const messages = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).map((m) => m.body) });",
  "export const messagesInComponent = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.messages, {}) });",
]);
const COUNTER = {
  definitionPath: "counter",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("counter");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    mod("lib.js", [
      'import { action, internalQuery, mutation, query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      "export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert('messages', a); } });",
      "export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).length });",
      "export const secret = internalQuery({ args: {}, handler: async () => 'internal' });",
      "export const messages = query({ args: {}, handler: async (ctx) => (await ctx.db.query('messages').collect()).map((m) => m.body) });",
      "export const scheduleLater = mutation({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(60000, 'lib:add', { body: 'later' }) });",
      "export const scheduleSelf = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.scheduler.runAfter(0, 'lib:add', a) });",
      "export const scheduleMany = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { for (let i = 0; i < n; i++) await ctx.scheduler.runAfter(60000, 'lib:add', { body: 'x' }); } });",
      "export const missing = mutation({ args: { which: v.string() }, handler: async (ctx, { which }) => { try { await ctx.scheduler.runAfter(0, which, {}); return null; } catch (e) { return e.message; } } });",
      "export const scheduleQuery = mutation({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(0, 'lib:count', {}) });",
      `export const job = query({ args: { id: v.string() }, handler: ${JOB} });`,
      // An action's schedule and cancel, in its component's namespace (DV-536).
      "export const scheduleAndCancel = action({ args: {}, handler: async (ctx) => { const id = await ctx.scheduler.runAfter(60000, 'lib:add', { body: 'never' }); await ctx.scheduler.cancel(id); return id; } });",
      // A scheduled action that schedules a child job, then waits for its own job to be canceled.
      "export const parent = action({ args: {}, handler: async (ctx) => { await new Promise((r) => setTimeout(r, 300)); return ctx.scheduler.runAfter(0, 'lib:add', { body: 'born canceled' }); } });",
      "export const scheduleParent = mutation({ args: {}, handler: async (ctx) => ctx.scheduler.runAfter(0, 'lib:parent', {}) });",
      "export const children = query({ args: {}, handler: async (ctx) => (await ctx.db.system.query('_scheduled_functions').collect()).filter((j) => j.name === 'lib.js:add').map((j) => j.state.kind) });",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment(scheduler: SchedulerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-scheduler-"));
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
    scheduler,
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
        schema: SCHEMA,
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
  /** The app's function `path`, called as a client; its value, or its error's message. */
  const call = async (kind: "query" | "mutation" | "action", path: string, args: object = {}) => {
    const r = (await post(`/api/${kind}`, { path, args, format: "json" }, null)).body!;
    return r.status === "success" ? r.value : { error: r.errorMessage as string };
  };
  /** The component's function `path`, run by the admin (`/api/function` with its `componentPath`). */
  const run = async (path: string, args: object = {}) => {
    const r = (await post("/api/function", { path, args, componentPath: "counter", format: "json" })).body!;
    return r.status === "success" ? r.value : { error: r.errorMessage as string };
  };
  const components = async () =>
    (await post("/api/query", { path: "_system/frontend/components:list", args: {}, format: "json" })).body!.value as {
      id: string;
      path: string;
    }[];
  return { engine, functions, post, call, run, push, components };
}

/** Wait for a job to finish, as Convex's `waitForJob`: pending (or running) until it is done. */
async function waitFor(state: () => Promise<any>, ms = 5000): Promise<any> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await state();
    expect(s).not.toBeNull();
    const kind = s!.state.kind;
    if (kind !== "pending" && kind !== "inProgress") return s!;
    if (Date.now() > until) throw new Error(`the job is still ${kind}`);
    await Bun.sleep(20);
  }
}

describe("Scheduler in component (Convex's js-integration-tests)", () => {
  test("schedule in parent: the job and the message the parent's", async () => {
    const d = await deployment();
    const id = await d.call("mutation", "app:scheduleInParent", { body: "hello" });
    expect(await d.call("query", "app:jobInComponent", { id })).toBeNull();
    expect((await waitFor(() => d.call("query", "app:job", { id }))).state.kind).toBe("success");
    expect(await d.call("query", "app:messages")).toEqual(["hello"]);
    expect(await d.call("query", "app:messagesInComponent")).toEqual([]);
  });

  test("schedule within component: the job and the message the component's", async () => {
    const d = await deployment();
    const id = await d.call("mutation", "app:scheduleWithinComponent", { body: "hello" });
    expect(await d.call("query", "app:job", { id })).toBeNull();
    const job = await waitFor(() => d.call("query", "app:jobInComponent", { id }));
    expect(job.state.kind).toBe("success");
    // AD-33: a component's function, named by its path even in its own namespace.
    expect(job.component).toBe("counter");
    expect(await d.call("query", "app:messages")).toEqual([]);
    expect(await d.call("query", "app:messagesInComponent")).toEqual(["hello"]);
  });

  test("schedule child from parent: the job the parent's, the message the child's", async () => {
    const d = await deployment();
    const id = await d.call("mutation", "app:scheduleChildFromParent", { body: "hello" });
    expect(await d.call("query", "app:jobInComponent", { id })).toBeNull();
    const job = await waitFor(() => d.call("query", "app:job", { id }));
    expect(job.state.kind).toBe("success");
    expect(job.name).toBe("lib.js:add");
    // AD-33: the job names its function's component.
    expect(job.component).toBe("counter");
    expect(Object.keys(job)).toEqual([
      "_creationTime",
      "_id",
      "args",
      "completedTime",
      "component",
      "name",
      "scheduledTime",
      "state",
    ]);
    expect(await d.call("query", "app:messages")).toEqual([]);
    expect(await d.call("query", "app:messagesInComponent")).toEqual(["hello"]);
  });

  test("a function handle schedules the child's function (component.test.ts)", async () => {
    const d = await deployment();
    const id = await d.call("mutation", "app:scheduleByHandle");
    const job = await waitFor(() => d.call("query", "app:job", { id }));
    expect(job.state.kind).toBe("success");
    expect(job.component).toBe("counter");
    expect(await d.call("query", "app:messagesInComponent")).toEqual(["by handle"]);
  });
});

describe("the scheduler from a component's functions", () => {
  test("an action schedules: from the app into the child, the job the app's", async () => {
    const d = await deployment();
    const id = await d.call("action", "app:scheduleFromAction");
    expect((await waitFor(() => d.call("query", "app:job", { id }))).state.kind).toBe("success");
    expect(await d.call("query", "app:messagesInComponent")).toEqual(["from action"]);
  });

  test("a component's action cancels its own job, in its namespace (DV-536)", async () => {
    const d = await deployment();
    const id = await d.run("lib:scheduleAndCancel");
    expect((await d.run("lib:job", { id })).state.kind).toBe("canceled");
    expect(await d.call("query", "app:job", { id })).toBeNull();
  });

  test("Convex's texts: a missing module or function names the component; a reference's export must be public", async () => {
    const d = await deployment();
    expect(await d.run("lib:missing", { which: "nope:x" })).toBe(
      "Attempted to schedule function at nonexistent path: counter nope.js",
    );
    expect(await d.run("lib:missing", { which: "lib:nope" })).toBe(
      "Attempted to schedule function, but no exported function nope found in the file: lib.js in 'counter'. Did you forget to export it?",
    );
    expect(await d.call("mutation", "app:refusal", { which: "internal" })).toBe(
      "Child component 'counter' does not export 'lib.secret'",
    );
  });

  test("a query scheduled in a component fails when it runs, naming the component", async () => {
    const d = await deployment();
    const id = await d.run("lib:scheduleQuery");
    const job = await waitFor(() => d.run("lib:job", { id }));
    expect(job.state).toEqual({
      error: `Unsupported function type. FunctionName("count") in module "lib.js" in 'counter' is defined as a Query. "\n                            "Only Mutation and Action can be scheduled.`,
      kind: "failed",
    });
  });

  test("the limits count the whole transaction, nested calls into a component included", async () => {
    const d = await deployment();
    expect(await d.call("mutation", "app:tooMany")).toStartWith(
      "Uncaught Error: Too many functions scheduled by this mutation (limit: 1000)",
    );
  });

  test("a job whose component was unmounted fails: its module is gone", async () => {
    const d = await deployment();
    // Due after the push that unmounts the component, even a slow one (a push under the function sandbox's
    // `process` loads the code in a new child).
    const id = await d.call("mutation", "app:scheduleChildFromParent", { body: "late", delay: 2000 });
    await d.push(false);
    const job = await waitFor(() => d.call("query", "app:job", { id }), 10_000);
    expect(job.state).toEqual({ error: "Couldn't find JavaScript module 'lib.js'.", kind: "failed" });
  }, 20_000);

  test("what a canceled job's action schedules is born canceled, in the component's namespace", async () => {
    const d = await deployment();
    const id = await d.run("lib:scheduleParent");
    await Bun.sleep(100);
    await d.post("/api/cancel_job", { id, componentId: (await d.components()).find((c) => c.path === "counter")!.id });
    await Bun.sleep(600);
    expect((await d.run("lib:job", { id })).state.kind).toBe("canceled");
    expect(await d.run("lib:children")).toEqual(["canceled"]);
  });
});

describe("across namespaces", () => {
  test("the app's canceled job: what the child's action it ran schedules is born canceled", async () => {
    const d = await deployment();
    // The job lives in the app's namespace; the action runs in the child's, and schedules there.
    const id = await d.call("mutation", "app:scheduleParent");
    await Bun.sleep(100);
    expect((await d.post("/api/cancel_job", { id })).status).toBe(200);
    await Bun.sleep(600);
    expect((await d.call("query", "app:job", { id })).state.kind).toBe("canceled");
    expect(await d.run("lib:children")).toEqual(["canceled"]);
  });

  test("garbage collection deletes a component's completed jobs too", async () => {
    const d = await deployment({ retentionSeconds: 0, gcDelayMs: 50 });
    const id = await d.run("lib:scheduleSelf", { body: "done" });
    expect((await waitFor(() => d.run("lib:job", { id }))).state.kind).toBe("success");
    const until = Date.now() + 5000;
    while ((await d.run("lib:job", { id })) !== null && Date.now() < until) await Bun.sleep(50);
    expect(await d.run("lib:job", { id })).toBeNull();
  });
});

describe("/api/cancel_job with a componentId", () => {
  test("cancels the component's job; without it, the id names no job of the app's", async () => {
    const d = await deployment();
    const id = await d.run("lib:scheduleLater");
    const componentId = (await d.components()).find((c) => c.path === "counter")!.id;
    expect((await d.post("/api/cancel_job", { id })).status).toBe(200);
    expect((await d.run("lib:job", { id })).state.kind).toBe("pending");
    expect((await d.post("/api/cancel_job", { id, componentId })).status).toBe(200);
    expect((await d.run("lib:job", { id })).state.kind).toBe("canceled");
  });

  test("cancel_all_jobs cancels the component's jobs only", async () => {
    const d = await deployment();
    const mine = await d.run("lib:scheduleLater");
    const apps = await d.call("mutation", "app:scheduleChildFromParent", { body: "x", delay: 60000 });
    const componentId = (await d.components()).find((c) => c.path === "counter")!.id;
    expect((await d.post("/api/cancel_all_jobs", { componentId })).status).toBe(200);
    expect((await d.run("lib:job", { id: mine })).state.kind).toBe("canceled");
    expect((await d.call("query", "app:job", { id: apps })).state.kind).toBe("pending");
    // The app's, filtered by its function's component path (Convex's `componentPath`).
    expect((await d.post("/api/cancel_all_jobs", { udfPath: "lib.js:add", componentPath: "" })).status).toBe(200);
    expect((await d.call("query", "app:job", { id: apps })).state.kind).toBe("pending");
    expect((await d.post("/api/cancel_all_jobs", { udfPath: "lib.js:add", componentPath: "counter" })).status).toBe(
      200,
    );
    expect((await d.call("query", "app:job", { id: apps })).state.kind).toBe("canceled");
  });
});

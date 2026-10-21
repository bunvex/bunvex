// Components over the bridge (STUDY-168 PR 7, STUDY-171 §15): the same app, mounting the same components, pushed to a
// server running its code in `vm` and to one running it in `process`, every case called on both, and what the client
// gets compared: the value, or the error's whole message (its frames, mapped to the module) and its data, and the log
// lines.
//
// The app mounts `counter` twice (`counter`, with its variables bound, and `second`, with none) and `other`. The cases
// cover a component's queries, mutations, actions and HTTP routes, run by an admin in each instance and called from
// the app (`ctx.runQuery(components.counter.lib.count)`, from a query, a mutation and an action); function handles
// across components (the app's to a component's function, a component's back into the app, one component's to
// another's); errors that cross (thrown, with data, a refusal of the tree), console lines on both sides, each
// instance's own module state and variables, `ctx.meta`, the scheduler and storage in a component, and the writes
// they left. Then, under `process` only: where the instances run (one child, beside the app's version), what a push
// and a dead child do to it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { SqlitePersistence } from "@bunvex/core/persistence/sqlite";
import { adminKeyCipherKey, createServer, Functions, issueAdminKey } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { ProcessExecutor } from "../src/executor.ts";
import { TestBlobs } from "./fixtures/blobs.ts";

/** Every `process` executor the servers of this file made, in order. */
const executors: ProcessExecutor[] = [];
provideProcessExecutor(() => {
  const e = new ProcessExecutor();
  executors.push(e);
  return e;
});
process.env.TZ = "UTC";

const SECRET = "c7".repeat(32);
const NAME = "component-parity-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));

type Module = { path: string; source: string; environment: "isolate" };
const mod = (path: string, source: string): Module => ({ path, source, environment: "isolate" });
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

const APP_DEFINITION = mod(
  "bunvex.config.js",
  `import { defineApp } from ${SERVER};
import { v } from ${VALUES};
import counter from "${dep("counter")}";
import other from "${dep("other")}";
const app = defineApp({ env: { APPX: v.optional(v.string()) } });
app.use(counter, { env: { MODE: "fast", KEY: app.env.APPX }, httpPrefix: "/c/" });
app.use(counter, { name: "second" });
app.use(other);
export default app;`,
);

/** The app with `counter` alone: `second` and `other` unmounted. */
const ONLY_COUNTER = mod(
  "bunvex.config.js",
  `import { defineApp } from ${SERVER};
import { v } from ${VALUES};
import counter from "${dep("counter")}";
const app = defineApp({ env: { APPX: v.optional(v.string()) } });
app.use(counter, { env: { MODE: "fast", KEY: app.env.APPX }, httpPrefix: "/c/" });
export default app;`,
);

const APP_SCHEMA = mod(
  "schema.js",
  `import { defineSchema, defineTable } from ${SERVER};
import { v } from ${VALUES};
export default defineSchema({ notes: defineTable({ text: v.string() }) });`,
);

/** The app's cases: `c` is `counter`'s `lib`, `s` is `second`'s, `o` is `other`'s. */
const APP = mod(
  "app.js",
  `import { action, componentsGeneric, createFunctionHandle, mutation, query } from ${SERVER};
import { v } from ${VALUES};
const components = componentsGeneric();
const c = components.counter.lib;
const s = components.second.lib;
const o = components.other.lib;
export const count = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.count, {}) });
export const counts = query({ args: {}, handler: async (ctx) => [await ctx.runQuery(c.count, {}), await ctx.runQuery(s.count, {}), await ctx.runQuery(o.count, {})] });
export const envs = query({ args: {}, handler: async (ctx) => [await ctx.runQuery(c.env, {}), await ctx.runQuery(s.env, {}), process.env.APPX ?? null, process.env.MODE ?? null] });
export const meta = query({ args: {}, handler: async (ctx) => [await ctx.runQuery(c.meta, {}), await ctx.runQuery(s.meta, {}), await ctx.meta.getFunctionMetadata()] });
export const clock = query({ args: {}, handler: async (ctx) => { const t = Date.now(); const inner = await ctx.runQuery(c.now, {}); return [inner === t, typeof inner]; } });
export const uncaught = query({ args: {}, handler: async (ctx) => ctx.runQuery(c.throws, {}) });
export const caught = query({ args: {}, handler: async (ctx) => { try { await ctx.runQuery(c.throws, {}); } catch (e) { return [e.name, e.message.split("\\n")[0], e instanceof Error, e.stack.split("\\n").filter((l) => l.includes("app.js")).length]; } } });
export const refusal = query({ args: { which: v.string() }, handler: async (ctx, { which }) => { const ref = { child: components.nope.lib.x, internal: c.secret, branch: components.counter.lib, missing: c.nope, kind: c.add }[which]; try { await ctx.runQuery(ref, {}); return null; } catch (e) { return e.message; } } });
export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => ctx.runMutation(c.add, a) });
export const addBoth = mutation({ args: {}, handler: async (ctx) => { await ctx.runMutation(c.add, { body: "c" }); await ctx.runMutation(s.add, { body: "s" }); await ctx.runMutation(o.add, { body: "o" }); return [await ctx.runQuery(c.count, {}), await ctx.runQuery(s.count, {}), await ctx.runQuery(o.count, {})]; } });
export const rolledBack = mutation({ args: {}, handler: async (ctx) => { let caught = null; try { await ctx.runMutation(c.addThenThrow, {}); } catch (e) { caught = e.message.split("\\n")[0]; } return { caught, count: await ctx.runQuery(c.count, {}) }; } });
export const errorData = mutation({ args: {}, handler: async (ctx) => { try { await ctx.runMutation(c.boom, {}); } catch (e) { return [e.name, e.data, e.message.split("\\n")[0]]; } } });
export const errorDataUncaught = mutation({ args: {}, handler: async (ctx) => ctx.runMutation(c.boom, {}) });
export const deep = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => { try { return await ctx.runMutation(c.recurse, { n }); } catch (e) { return e.message.split("\\n")[0]; } } });
export const state = mutation({ args: {}, handler: async (ctx) => [await ctx.runMutation(c.bump, {}), await ctx.runMutation(s.bump, {}), await ctx.runMutation(c.bump, {}), await ctx.runMutation(o.bump, {})] });
export const viaHandle = mutation({ args: {}, handler: async (ctx) => { const h = await createFunctionHandle(c.add); await ctx.runMutation(h, { body: "by handle" }); return [h.startsWith("function://"), await ctx.runQuery(c.count, {})]; } });
export const record = mutation({ args: { text: v.string() }, handler: async (ctx, a) => { await ctx.db.insert("notes", a); return (await ctx.db.query("notes").collect()).length; } });
export const callBack = mutation({ args: {}, handler: async (ctx) => { const h = await createFunctionHandle("app:record"); return ctx.runMutation(c.callBack, { h }); } });
export const across = mutation({ args: {}, handler: async (ctx) => { const h = await ctx.runMutation(o.handleOf, {}); return ctx.runMutation(c.callOther, { h }); } });
export const internalByHandle = mutation({ args: {}, handler: async (ctx) => ctx.runQuery(await ctx.runMutation(c.secretHandle, {}), {}) });
export const badHandle = mutation({ args: {}, handler: async (ctx) => { try { await ctx.runQuery("function://nope", {}); } catch (e) { return e.message; } } });
export const idArg = mutation({ args: {}, handler: async (ctx) => { const id = await ctx.db.insert("notes", { text: "t" }); try { return await ctx.runQuery(c.takesId, { id }); } catch (e) { return e.message.split("\\n")[0]; } } });
export const logged = mutation({ args: {}, handler: async (ctx) => { console.log("app line"); await ctx.runMutation(c.logIt, {}); console.warn("app after"); return 1; } });
export const schedule = mutation({ args: {}, handler: async (ctx) => [typeof (await ctx.scheduler.runAfter(60_000, c.add, { body: "later" })), await ctx.runMutation(c.scheduleOwn, {})] });
export const fromAction = action({ args: {}, handler: async (ctx) => { await ctx.runMutation(c.add, { body: "from action" }); let miss = null; try { await ctx.runQuery(c.missing, {}); } catch (e) { miss = e.message; } return { count: await ctx.runQuery(c.count, {}), miss, act: await ctx.runAction(c.act, { n: 2 }) }; } });
export const actionUncaught = action({ args: {}, handler: async (ctx) => ctx.runAction(c.actThrows, {}) });
export const actionHandle = action({ args: {}, handler: async (ctx) => ctx.runAction(await createFunctionHandle(c.act), { n: 5 }) });
export const actionStorage = action({ args: {}, handler: async (ctx) => ctx.runAction(c.store, { text: "stored in a component" }) });
export const actionLogs = action({ args: {}, handler: async (ctx) => { console.log("action line"); await ctx.runAction(c.actLogs, {}); return 1; } });
export const whoFromAction = action({ args: {}, handler: async (ctx) => ctx.runQuery(c.whoami, {}) });
`,
);

const COUNTER_LIB = mod(
  "lib.js",
  `import { action, createFunctionHandle, internalQuery, mutation, query } from ${SERVER};
import { BunvexError, v } from ${VALUES};
let calls = 0;
export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert("messages", a); } });
export const addThenThrow = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert("messages", { body: "gone" }); throw new Error("nope"); } });
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).length });
export const env = query({ args: {}, handler: async () => ({ mode: process.env.MODE ?? null, key: process.env.KEY ?? null, appx: process.env.APPX ?? null, site: (process.env.BUNVEX_SITE_URL ?? "").replace(/:\\d+/, ":<port>") }) });
export const meta = query({ args: {}, handler: async (ctx) => ctx.meta.getFunctionMetadata() });
export const now = query({ args: {}, handler: async () => Date.now() });
export const throws = query({ args: {}, handler: async () => { throw new Error("thrown in a component"); } });
export const secret = internalQuery({ args: {}, handler: async () => "internal" });
export const whoami = query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null });
export const takesId = query({ args: { id: v.id("messages") }, handler: async () => "accepted" });
export const boom = mutation({ args: {}, handler: async () => { throw new BunvexError({ code: 42, n: 2n }); } });
export const recurse = mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => (n === 0 ? "bottom" : ctx.runMutation("lib:recurse", { n: n - 1 })) });
export const bump = mutation({ args: {}, handler: async () => ++calls });
export const callBack = mutation({ args: { h: v.string() }, handler: async (ctx, { h }) => ctx.runMutation(h, { text: "from the component" }) });
export const callOther = mutation({ args: { h: v.string() }, handler: async (ctx, { h }) => ctx.runMutation(h, { body: "from counter" }) });
export const secretHandle = mutation({ args: {}, handler: async () => createFunctionHandle("lib:secret") });
export const logIt = mutation({ args: {}, handler: async () => { console.log("component line", { n: 1 }); console.error("component error line"); } });
export const scheduleOwn = mutation({ args: {}, handler: async (ctx) => { const id = await ctx.scheduler.runAfter(60_000, "lib:add", { body: "own" }); await ctx.scheduler.cancel(id); return typeof id; } });
export const act = action({ args: { n: v.number() }, handler: async (ctx, { n }) => [n, await ctx.runQuery("lib:count", {}), (await ctx.meta.getFunctionMetadata()).componentPath ?? null] });
export const actThrows = action({ args: {}, handler: async () => { throw new BunvexError("an action's data"); } });
export const actLogs = action({ args: {}, handler: async () => { console.log("component action line"); return 1; } });
export const store = action({ args: { text: v.string() }, handler: async (ctx, { text }) => { const id = await ctx.storage.store(new Blob([text], { type: "text/plain" })); const b = await ctx.storage.get(id); const m = await ctx.storage.getMetadata(id); return [await b.text(), b.type, m.size, typeof (await ctx.storage.getUrl(id))]; } });
`,
);

const COUNTER_HTTP = mod(
  "http.js",
  `import { httpActionGeneric as httpAction, httpRouter } from ${SERVER};
const http = httpRouter();
http.route({ path: "/hello", method: "GET", handler: httpAction(async () => new Response("hello from counter")) });
http.route({ path: "/count", method: "GET", handler: httpAction(async (ctx) => Response.json({ count: await ctx.runQuery("lib:count", {}) })) });
http.route({ path: "/add", method: "POST", handler: httpAction(async (ctx, req) => { await ctx.runMutation("lib:add", { body: await req.text() }); return new Response(null, { status: 204 }); }) });
http.route({ path: "/env", method: "GET", handler: httpAction(async () => new Response([process.env.MODE ?? "none", (process.env.BUNVEX_SITE_URL ?? "").replace(/:\\d+/, ":<port>")].join(" "))) });
http.route({ path: "/throws", method: "GET", handler: httpAction(async () => { console.log("before the throw"); throw new Error("an HTTP action's error"); }) });
http.route({ path: "/whoami", method: "GET", handler: httpAction(async (ctx) => new Response(String((await ctx.auth.getUserIdentity())?.subject ?? null))) });
http.route({ pathPrefix: "/echo/", method: "POST", handler: httpAction(async (ctx, req) => new Response(new URL(req.url).pathname + " " + (await req.text()))) });
export default http;
`,
);

const MESSAGES_SCHEMA = mod(
  "schema.js",
  `import { defineSchema, defineTable } from ${SERVER};
import { v } from ${VALUES};
export default defineSchema({ messages: defineTable({ body: v.string() }) });`,
);

const COUNTER = {
  definitionPath: "counter",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from ${SERVER};
import { v } from ${VALUES};
export default defineComponent("counter", { env: { MODE: v.optional(v.string()), KEY: v.optional(v.string()) } });`,
  ),
  dependencies: [] as string[],
  schema: MESSAGES_SCHEMA,
  functions: [COUNTER_LIB, COUNTER_HTTP],
  udfServerVersion: "1.46.0",
};

const OTHER = {
  definitionPath: "other",
  definition: mod(
    "bunvex.config.js",
    `import { defineComponent } from ${SERVER};\nexport default defineComponent("other");`,
  ),
  dependencies: [] as string[],
  schema: MESSAGES_SCHEMA,
  functions: [
    mod(
      "lib.js",
      `import { createFunctionHandle, mutation, query } from ${SERVER};
import { v } from ${VALUES};
let calls = 100;
export const add = mutation({ args: { body: v.string() }, handler: async (ctx, a) => { await ctx.db.insert("messages", a); return (await ctx.db.query("messages").collect()).length; } });
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).length });
export const bump = mutation({ args: {}, handler: async () => ++calls });
export const handleOf = mutation({ args: {}, handler: async () => createFunctionHandle("lib:add") });
`,
    ),
  ],
  udfServerVersion: "1.46.0",
};

type Outcome = { status: string; value?: unknown; errorMessage?: string; errorData?: unknown; logLines?: string[] };

const own = (t: string) =>
  t
    .replace(/\b[0-9a-z]{31,37}\b/g, "<id>")
    .replace(/\b1\d{12}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16}\b/g, "<request>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");

function normalized(o: Outcome) {
  const logLines = JSON.parse(own(JSON.stringify(o.logLines ?? [])));
  if (o.status === "success") return { value: JSON.parse(own(JSON.stringify(o.value ?? null))), logLines };
  const message = (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "");
  return { error: own(message), data: o.errorData, logLines };
}

const dirs: string[] = [];

async function deployment(sandbox: "vm" | "process") {
  const dir = mkdtempSync(join(tmpdir(), `bunvex-component-parity-${sandbox}-`));
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
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
    fileStorage: new TestBlobs(),
    redactLogsToClient: false,
  });
  await s.codeReady;
  const executor = sandbox === "process" ? executors.at(-1)! : null;
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
  const push = async (definition = APP_DEFINITION) => {
    const start = await post("/api/deploy2/start_push", {
      adminKey: KEY,
      functions: "bunvex",
      nodeDependencies: [],
      appDefinition: {
        definition,
        dependencies: ["counter", "other"],
        schema: APP_SCHEMA,
        changedModules: [APP],
        unchangedModuleHashes: [],
        udfServerVersion: "1.46.0",
      },
      componentDefinitions: [COUNTER, OTHER],
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
  await post("/api/update_environment_variables", { changes: [{ name: "APPX", value: "secret-x" }] });
  await push();
  /** The app's function `path`, called as a client. */
  const call = async (kind: string, path: string, args: object = {}) =>
    (await post(`/api/${kind}`, { path, args, format: "json" }, null)).body as Outcome;
  /** `path` in component `componentPath`, as an admin runs it (`bunvex run --component`). */
  const run = async (componentPath: string, path: string, args: object = {}) =>
    (await post("/api/function", { componentPath, path, args, format: "json" })).body as Outcome;
  /** An HTTP action request (`/http/...`): its status, its headers that matter, its body. */
  const http = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${api}/http${path}`, init);
    return { status: r.status, type: r.headers.get("content-type"), body: own(await r.text()) };
  };
  return { s, engine, functions, executor, call, run, http, push };
}

let vm: Awaited<ReturnType<typeof deployment>>;
let proc: Awaited<ReturnType<typeof deployment>>;
beforeAll(async () => {
  [vm, proc] = await Promise.all([deployment("vm"), deployment("process")]);
}, 60_000);
afterAll(async () => {
  await vm?.s.shutdown();
  await proc?.s.shutdown();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The app's cases, in order (state carries from one to the next, the same on both servers). */
const APP_CASES: [kind: string, path: string, args?: object][] = [
  ["query", "app:count"],
  ["mutation", "app:add", { body: "a" }],
  ["query", "app:count"],
  ["mutation", "app:addBoth"],
  ["query", "app:counts"],
  ["query", "app:envs"],
  ["query", "app:meta"],
  ["query", "app:clock"],
  ["query", "app:uncaught"],
  ["query", "app:caught"],
  ["query", "app:refusal", { which: "child" }],
  ["query", "app:refusal", { which: "internal" }],
  ["query", "app:refusal", { which: "branch" }],
  ["query", "app:refusal", { which: "missing" }],
  ["query", "app:refusal", { which: "kind" }],
  ["mutation", "app:rolledBack"],
  ["mutation", "app:errorData"],
  ["mutation", "app:errorDataUncaught"],
  ["mutation", "app:deep", { n: 3 }],
  ["mutation", "app:deep", { n: 80 }],
  ["mutation", "app:state"],
  ["mutation", "app:state"],
  ["mutation", "app:viaHandle"],
  ["mutation", "app:callBack"],
  ["mutation", "app:across"],
  ["mutation", "app:internalByHandle"],
  ["mutation", "app:badHandle"],
  ["mutation", "app:idArg"],
  ["mutation", "app:logged"],
  ["mutation", "app:schedule"],
  ["action", "app:fromAction"],
  ["action", "app:actionUncaught"],
  ["action", "app:actionHandle"],
  ["action", "app:actionStorage"],
  ["action", "app:actionLogs"],
  ["action", "app:whoFromAction"],
  ["query", "app:counts"],
];

describe("the app's calls into its components: the same in vm and in process", () => {
  for (const [i, [kind, path, args]] of APP_CASES.entries())
    test(`${i} ${kind} ${path} ${args ? JSON.stringify(args) : ""}`, async () => {
      const [x, y] = await Promise.all([vm.call(kind, path, args), proc.call(kind, path, args)]);
      expect(normalized(y)).toEqual(normalized(x));
    });
});

/** A component's own functions, run by an admin in each instance. */
const RUN_CASES: [component: string, path: string, args?: object][] = [
  ["counter", "lib:count"],
  ["second", "lib:count"],
  ["other", "lib:count"],
  ["counter", "lib:add", { body: "admin" }],
  ["counter", "lib:count"],
  ["counter", "lib:env"],
  ["second", "lib:env"],
  ["counter", "lib:meta"],
  ["second", "lib:bump"],
  ["other", "lib:bump"],
  ["counter", "lib:secret"],
  ["counter", "lib:throws"],
  ["counter", "lib:boom"],
  ["counter", "lib:recurse", { n: 5 }],
  ["counter", "lib:logIt"],
  ["counter", "lib:act", { n: 1 }],
  ["second", "lib:act", { n: 2 }],
  ["counter", "lib:actThrows"],
  ["counter", "lib:actLogs"],
  ["counter", "lib:store", { text: "admin's file" }],
  ["counter", "lib:nope"],
  ["counter", "lib:add", { body: 1 }],
  ["", "app:count"],
];

describe("a component's own functions, run in each instance: the same in vm and in process", () => {
  for (const [i, [component, path, args]] of RUN_CASES.entries())
    test(`${i} ${component || "(app)"} ${path} ${args ? JSON.stringify(args) : ""}`, async () => {
      const [x, y] = await Promise.all([vm.run(component, path, args), proc.run(component, path, args)]);
      expect(normalized(y)).toEqual(normalized(x));
    });
});

/** A component's HTTP routes, mounted at `/c/`. */
const HTTP_CASES: [path: string, init?: RequestInit][] = [
  ["/c/hello"],
  ["/c/count"],
  ["/c/add", { method: "POST", body: "over http" }],
  ["/c/count"],
  ["/c/env"],
  ["/c/throws"],
  ["/c/whoami", { headers: { authorization: "Bearer not-a-token" } }],
  ["/c/echo/a/b", { method: "POST", body: "echoed" }],
  ["/c/nope"],
  ["/hello"],
];

describe("a component's HTTP routes: the same in vm and in process", () => {
  for (const [i, [path, init]] of HTTP_CASES.entries())
    test(`${i} ${init?.method ?? "GET"} ${path}`, async () => {
      const [x, y] = await Promise.all([vm.http(path, init), proc.http(path, init)]);
      expect(y).toEqual(x);
    });
});

describe("what the calls left: the same in vm and in process", () => {
  test("each namespace's documents, jobs and files", async () => {
    const view = async (d: typeof vm) =>
      Promise.all(
        [null, ...d.engine.catalog.components.keys()].map(async (ns) =>
          d.engine.query((db) =>
            db.asSystem(() =>
              db.inComponent(ns, async () => {
                const names = [
                  ...(ns === null ? d.engine.catalog : d.engine.catalog.components.get(ns)!).tables.keys(),
                ];
                const out: Record<string, unknown> = {};
                for (const t of names.filter((n) =>
                  ["notes", "messages", "_scheduled_functions", "_storage"].includes(n),
                ))
                  out[t] = (await db.query(t).collect()).map((r) => {
                    const { _id, _creationTime, scheduledTime, completedTs, sha256, ...rest } = r as Record<
                      string,
                      unknown
                    >;
                    return own(JSON.stringify(rest));
                  });
                return out;
              }),
            ),
          ),
        ),
      );
    const [x, y] = await Promise.all([view(vm), view(proc)]);
    expect(y).toEqual(x);
    expect(JSON.stringify(x)).toContain("from counter");
  });
});

// Where the instances run under `process` (STUDY-168 PR 7): beside the app's version, in its child.
describe("under process: the app and its component instances in one child", () => {
  test("one child holds the app's version and each instance's", async () => {
    const children = await proc.executor!.children();
    expect(children.length).toBe(1);
    // The app, `counter`, `second` and `other`: four versions, each instance its own (DV-492, C3). The push analyzed
    // each definition's code in that child too, then let it go: the child forgot it (`unload`).
    expect(children[0]!.versions).toBe(4);
    expect(children[0]!.held).toBe(4);
  });

  test("a push loads them all again in a new child; the old one stops", async () => {
    const [before] = await proc.executor!.children();
    const started = proc.executor!.started;
    await proc.push();
    // One child for the push: its own version, each definition's analysis and each instance's code in it.
    expect(proc.executor!.started - started).toBe(1);
    const after = await proc.executor!.children();
    expect(after.length).toBe(1);
    expect(after[0]!.pid).not.toBe(before!.pid);
    expect(after[0]!.versions).toBe(4);
    expect(after[0]!.held).toBe(4);
    await waitGone(before!.pid);
    // Module state starts again with the new versions, as under vm.
    await vm.push();
    const [x, y] = await Promise.all([vm.call("mutation", "app:state"), proc.call("mutation", "app:state")]);
    expect(normalized(y)).toEqual(normalized(x));
    expect((y.value as number[])[0]).toBe(1);
  }, 30_000);

  test("a child that dies is replaced at the next call, with every version loaded again", async () => {
    const [before] = await proc.executor!.children();
    const started = proc.executor!.started;
    process.kill(before!.pid, "SIGKILL");
    await waitGone(before!.pid);
    // The next call into a component (through the app) gets a new child, which holds every version again.
    expect((await proc.call("query", "app:counts")).status).toBe("success");
    expect((await proc.run("second", "lib:count")).status).toBe("success");
    const after = await proc.executor!.children();
    expect(after.length).toBe(1);
    expect(after[0]!.pid).not.toBe(before!.pid);
    expect(after[0]!.versions).toBe(4);
    expect(after[0]!.held).toBe(4);
    expect((await proc.http("/c/hello")).body).toBe("hello from counter");
    // One child started for the four versions.
    expect(proc.executor!.started - started).toBe(1);
  }, 30_000);
});

describe("under process: an instance that goes, and an app deployed alone", () => {
  test("an unmounted instance's version is let go: the child forgets it", async () => {
    const [before] = await proc.executor!.children();
    await proc.push(ONLY_COUNTER);
    const after = await proc.executor!.children();
    expect(after.map((c) => [c.versions, c.held])).toEqual([[2, 2]]);
    await waitGone(before!.pid);
    expect((await proc.run("second", "lib:count")).errorMessage).toContain(
      "Could not find function for 'lib:count' in 'second'",
    );
    expect((await proc.run("counter", "lib:count")).status).toBe("success");
    await proc.push();
    expect((await proc.executor!.children()).map((c) => [c.versions, c.held])).toEqual([[4, 4]]);
  }, 30_000);

  test("the app's code deployed alone (deployCode): the instances keep running where they were", async () => {
    await proc.s.deployCode([APP]);
    const children = await proc.executor!.children();
    // The app's new version in a child of its own; the instances, still installed, in the one they were loaded in.
    expect(children.map((c) => c.versions).sort()).toEqual([1, 3]);
    expect((await proc.run("counter", "lib:count")).status).toBe("success");
    expect((await proc.call("query", "app:counts")).status).toBe("success");
    await proc.push();
    expect((await proc.executor!.children()).map((c) => c.versions)).toEqual([4]);
  }, 30_000);
});

/** Waits until `pid` has exited. */
async function waitGone(pid: number) {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} is still running`);
}

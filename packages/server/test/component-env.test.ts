// A component's `process.env` in a nested call (STUDY-171 §15.7, Q-PR7-1): the callee reads its own component's
// variables, as Convex's callee phase loads them (`PreloadedEnvVars::load(tx, component, …)`,
// `isolate/src/environment/udf/phase.rs:195-199`), whoever calls it: the app's query or mutation, another component
// through a handle; the app, called back from a component through a handle, reads its own. Each read stays in the
// read set: a variable a binding names, changed, re-runs the subscription. The same calls under both executors
// (`BUNVEX_FUNCTION_SANDBOX=process` with `packages/sandbox/test/process-preload.ts`).
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
import { createServer } from "../src/server.ts";
import { add, history, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "e7".repeat(32);
const NAME = "component-env-test";
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

/** `envc` mounted twice: with its variables bound (a value, and the app's `APPKEY`), and with none. */
const APP_DEFINITION = mod("bunvex.config.js", [
  'import { defineApp } from "bunvex/server";',
  'import { v } from "bunvex/values";',
  `import envc from "${dep("envc")}";`,
  "const app = defineApp({ env: { APPKEY: v.optional(v.string()) } });",
  'app.use(envc, { env: { MODE: "fast", KEY: app.env.APPKEY } });',
  'app.use(envc, { name: "second" });',
  "export default app;",
]);
const READ = [
  'const NAMES = ["MODE", "KEY", "APPKEY", "SECRET", "NOPE"];',
  "const read = () => Object.fromEntries(NAMES.map((n) => [n, process.env[n] ?? null]));",
  "const badRead = () => { try { return { value: process.env['not a name'] ?? null }; } catch (e) { return { threw: e.message }; } };",
];
const APP = mod("app.js", [
  'import { action, componentsGeneric, createFunctionHandle, mutation, query } from "bunvex/server";',
  ...READ,
  "const components = componentsGeneric();",
  "export const appEnv = query({ args: {}, handler: async () => read() });",
  "export const appEnvMut = mutation({ args: {}, handler: async () => read() });",
  "export const appBad = query({ args: {}, handler: async () => badRead() });",
  "export const viaQuery = query({ args: {}, handler: async (ctx) => ({ before: read(), envc: await ctx.runQuery(components.envc.lib.env, {}), second: await ctx.runQuery(components.second.lib.env, {}), bad: await ctx.runQuery(components.envc.lib.bad, {}), after: read() }) });",
  "export const viaMutation = mutation({ args: {}, handler: async (ctx) => ({ before: read(), envc: await ctx.runMutation(components.envc.lib.envMut, {}), second: await ctx.runQuery(components.second.lib.env, {}), stale: await ctx.runQuery(components.envc.lib.env, {}, { useStaleSnapshot: true }), after: read() }) });",
  "export const viaAction = action({ args: {}, handler: async (ctx) => ({ envc: await ctx.runQuery(components.envc.lib.env, {}), second: await ctx.runMutation(components.second.lib.envMut, {}) }) });",
  "export const toComponent = query({ args: {}, handler: async (ctx) => ctx.runQuery(components.envc.lib.callHandle, { handle: await createFunctionHandle(components.second.lib.env) }) });",
  "export const toComponentMut = mutation({ args: {}, handler: async (ctx) => ctx.runMutation(components.envc.lib.callHandleMut, { handle: await createFunctionHandle(components.second.lib.envMut) }) });",
  "export const toApp = query({ args: {}, handler: async (ctx) => ({ before: read(), call: await ctx.runQuery(components.envc.lib.callHandle, { handle: await createFunctionHandle('app:appEnv') }), after: read() }) });",
  "export const toAppMut = mutation({ args: {}, handler: async (ctx) => ({ before: read(), call: await ctx.runMutation(components.envc.lib.callHandleMut, { handle: await createFunctionHandle('app:appEnvMut') }), after: read() }) });",
  "export const keyOnly = query({ args: {}, handler: async (ctx) => (await ctx.runQuery(components.envc.lib.env, {})).KEY });",
]);
const ENVC = {
  definitionPath: "envc",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'import { v } from "bunvex/values";',
    'export default defineComponent("envc", { env: { MODE: v.optional(v.string()), KEY: v.optional(v.string()) } });',
  ]),
  dependencies: [] as string[],
  schema: null,
  functions: [
    mod("lib.js", [
      'import { mutation, query } from "bunvex/server";',
      'import { v } from "bunvex/values";',
      ...READ,
      "export const env = query({ args: {}, handler: async () => read() });",
      "export const envMut = mutation({ args: {}, handler: async () => read() });",
      "export const bad = query({ args: {}, handler: async () => badRead() });",
      "export const callHandle = query({ args: { handle: v.string() }, handler: async (ctx, { handle }) => { const before = read(); const inner = await ctx.runQuery(handle, {}); return { before, inner, after: read() }; } });",
      "export const callHandleMut = mutation({ args: { handle: v.string() }, handler: async (ctx, { handle }) => { const before = read(); const inner = await ctx.runMutation(handle, {}); return { before, inner, after: read() }; } });",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-component-env-"));
  dirs.push(dir);
  const engine = await new Engine(defineSchema({}), new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
    instanceName: NAME,
    instanceSecret: SECRET,
    storedSchema: true,
  }).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
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
  const start = await post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: APP_DEFINITION,
      dependencies: ["envc"],
      schema: null,
      changedModules: [APP],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: [ENVC],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await post("/api/deploy2/wait_for_schema", {
    adminKey: KEY,
    schemaChange: start.body!.schemaChange,
    timeoutMs: 5000,
  });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  /** The app's function `path`, called as a client: its value, or its error's message. */
  const call = async (kind: "query" | "mutation" | "action", path: string) => {
    const b = (await post(`/api/${kind}`, { path, args: {}, format: "json" }, null)).body!;
    return b.status === "success" ? b.value : { error: b.errorMessage };
  };
  const setEnv = (vars: Record<string, string | null>) =>
    engine.mutation((db) =>
      engine.environment.update(
        db,
        Object.entries(vars).map(([name, value]) => ({ name, value })),
      ),
    );
  return { engine, s, call, setEnv };
}

const NONE = { MODE: null, KEY: null, APPKEY: null, SECRET: null, NOPE: null };
const APP_VARS = { ...NONE, APPKEY: "app-key", SECRET: "app-secret" };
const envc = (key: string | null) => ({ ...NONE, MODE: "fast", KEY: key });
const BAD = {
  threw:
    "The environment variable name not a name is invalid. Environment variable names must begin with a letter and may only include characters a-z, A-Z, 0-9, and underscores.",
};

describe("a component's process.env in a nested call", () => {
  test("app → component, from a query and a mutation: the component's bindings, never the app's variables", async () => {
    const d = await deployment();
    await d.setEnv({ APPKEY: "app-key", SECRET: "app-secret" });
    expect(await d.call("query", "app:appEnv")).toEqual(APP_VARS);
    expect(await d.call("query", "app:viaQuery")).toEqual({
      before: APP_VARS,
      envc: envc("app-key"),
      second: NONE,
      bad: BAD,
      after: APP_VARS,
    });
    expect(await d.call("mutation", "app:viaMutation")).toEqual({
      before: APP_VARS,
      envc: envc("app-key"),
      second: NONE,
      stale: envc("app-key"),
      after: APP_VARS,
    });
    // From an action each call is a run of its own: right before the fix too.
    expect(await d.call("action", "app:viaAction")).toEqual({ envc: envc("app-key"), second: NONE });
  });

  test("component → component through a handle: the callee's own, the caller's again after", async () => {
    const d = await deployment();
    await d.setEnv({ APPKEY: "app-key", SECRET: "app-secret" });
    const want = { before: envc("app-key"), inner: NONE, after: envc("app-key") };
    expect(await d.call("query", "app:toComponent")).toEqual(want);
    expect(await d.call("mutation", "app:toComponentMut")).toEqual(want);
  });

  test("component → app through a handle: the app reads its own variables", async () => {
    const d = await deployment();
    await d.setEnv({ APPKEY: "app-key", SECRET: "app-secret" });
    const want = {
      before: APP_VARS,
      call: { before: envc("app-key"), inner: APP_VARS, after: envc("app-key") },
      after: APP_VARS,
    };
    expect(await d.call("query", "app:toApp")).toEqual(want);
    expect(await d.call("mutation", "app:toAppMut")).toEqual(want);
  });

  test("an unset variable: a binding to it reads nothing, a name nobody set too; a bad name throws in both", async () => {
    const d = await deployment();
    expect(await d.call("query", "app:viaQuery")).toEqual({
      before: NONE,
      envc: envc(null),
      second: NONE,
      bad: BAD,
      after: NONE,
    });
    expect(await d.call("query", "app:appBad")).toEqual(BAD);
  });

  test("the read set: the app's variable a binding names, changed, re-runs the app's query", async () => {
    const d = await deployment();
    const c = await v1Client(syncUrl(d.s.server.port));
    stops.push(() => c.ws.close());
    c.modify([add(1, "app:keyOnly")]);
    await c.until(() => history(c.transitions(), 1).length === 1);
    await d.setEnv({ APPKEY: "first" });
    await c.until(() => history(c.transitions(), 1).at(-1) === "first");
    await d.setEnv({ APPKEY: "second" });
    await c.until(() => history(c.transitions(), 1).at(-1) === "second");
    expect(history(c.transitions(), 1)).toEqual([null, "first", "second"]);
  });
});

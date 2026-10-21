// A nested call's error in its caller's realm (STUDY-171 §15, Q-PR7-2): Convex makes it again in the caller's code
// (`performAsyncSyscall`, npm-packages/convex/src/server/impl/syscall.ts:28-55): `new Error(e.message)`, or the
// application error class with its data. So in pushed code, a caught nested call's error is `instanceof Error` and,
// with data, `instanceof BunvexError`, of the caller's own `Error.prototype` / `BunvexError.prototype`; its message,
// data and frames are as before. For queries, mutations and actions calling the app's functions and a component's.
// Run under `vm`, and under `process` with
//   BUNVEX_FUNCTION_SANDBOX=process BUNVEX_FUNCTION_SANDBOX_ISOLATION=none \
//     bun test --preload ./packages/sandbox/test/process-preload.ts packages/server/test/nested-error-realm.test.ts
// (components and "use node" actions under `process` come with STUDY-168 PR 7, #822, and PR 10: skipped there).
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

const SECRET = "cd".repeat(32);
const NAME = "nested-error-realm-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });
const PROCESS = process.env.BUNVEX_FUNCTION_SANDBOX === "process";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mod = (path: string, lines: string[], environment: "isolate" | "node" = "isolate"): ModuleSource => ({
  path,
  source: lines.join("\n"),
  environment,
});
const dep = (path: string) => `./_componentDeps/${Buffer.from(path).toString("base64url")}`;

/** What the caller sees of an error it caught, in its own realm. */
const SEEN = [
  "const seen = (e) => ({",
  "  isError: e instanceof Error,",
  "  isBunvexError: e instanceof BunvexError,",
  "  proto: Object.getPrototypeOf(e) === Error.prototype ? 'Error' : Object.getPrototypeOf(e) === BunvexError.prototype ? 'BunvexError' : 'other',",
  "  ctor: e.constructor.name,",
  "  name: e.name,",
  "  message: e.message,",
  "  data: e.data === undefined ? 'undefined' : e.data,",
  "  tag: Object.prototype.toString.call(e),",
  "  stack: e.stack,",
  "});",
  "const caught = async (f) => { try { await f(); return null; } catch (e) { return seen(e); } };",
];

const APP = mod("app.js", [
  'import { action, componentsGeneric, mutation, query } from "bunvex/server";',
  'import { BunvexError, v } from "bunvex/values";',
  "const c = componentsGeneric().thrower.lib;",
  ...SEEN,
  "const fail = (data) => { if (data) throw new BunvexError({ code: 'APP' }); throw new Error('app boom'); };",
  "export const throwingQuery = query({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => fail(data) });",
  "export const throwingMutation = mutation({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => fail(data) });",
  "export const throwingAction = action({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => fail(data) });",
  "export const queryToQuery = query({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runQuery('app:throwingQuery', a)) });",
  "export const mutationToQuery = mutation({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runQuery('app:throwingQuery', a)) });",
  "export const mutationToMutation = mutation({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runMutation('app:throwingMutation', a)) });",
  "export const actionToMutation = action({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runMutation('app:throwingMutation', a)) });",
  "export const actionToAction = action({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runAction('app:throwingAction', a)) });",
  "export const queryToComponent = query({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runQuery(c.boomQuery, a)) });",
  "export const mutationToComponent = mutation({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runMutation(c.boomMutation, a)) });",
  "export const actionToComponent = action({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runMutation(c.boomMutation, a)) });",
  "export const own = query({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => caught(async () => fail(data)) });",
  "class FooError extends BunvexError {}",
  "export const subclass = query({ args: {}, handler: async () => { const e = new FooError('foo'); return [e instanceof FooError, e instanceof BunvexError, e instanceof Error, e.name, e.data]; } });",
  "export const queryUncaught = query({ args: { data: v.boolean() }, handler: async (ctx, a) => { await ctx.runQuery('app:throwingQuery', a); } });",
  "export const actionUncaught = action({ args: { data: v.boolean() }, handler: async (ctx, a) => { await ctx.runMutation('app:throwingMutation', a); } });",
]);
const NODE = mod(
  "node.js",
  [
    '"use node";',
    'import { action } from "bunvex/server";',
    'import { BunvexError, v } from "bunvex/values";',
    ...SEEN,
    "export const nodeToMutation = action({ args: { data: v.boolean() }, handler: async (ctx, a) => caught(() => ctx.runMutation('app:throwingMutation', a)) });",
  ],
  "node",
);
const SCHEMA = mod("schema.js", ['import { defineSchema } from "bunvex/server";', "export default defineSchema({});"]);
const THROWER = {
  definitionPath: "thrower",
  definition: mod("bunvex.config.js", [
    'import { defineComponent } from "bunvex/server";',
    'export default defineComponent("thrower");',
  ]),
  dependencies: [] as string[],
  schema: SCHEMA,
  functions: [
    mod("lib.js", [
      'import { mutation, query } from "bunvex/server";',
      'import { BunvexError, v } from "bunvex/values";',
      "const fail = (data) => { if (data) throw new BunvexError({ code: 'COMPONENT' }); throw new Error('component boom'); };",
      "export const boomQuery = query({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => fail(data) });",
      "export const boomMutation = mutation({ args: { data: v.boolean() }, handler: async (_ctx, { data }) => fail(data) });",
    ]),
  ],
  udfServerVersion: "1.46.0",
};

async function deployment() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-nested-error-realm-"));
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
    await s.shutdown();
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
  const components = !PROCESS;
  const start = await post("/api/deploy2/start_push", {
    adminKey: KEY,
    functions: "bunvex",
    nodeDependencies: [],
    appDefinition: {
      definition: mod("bunvex.config.js", [
        'import { defineApp } from "bunvex/server";',
        ...(components ? [`import thrower from "${dep("thrower")}";`] : []),
        "const app = defineApp();",
        ...(components ? ["app.use(thrower);"] : []),
        "export default app;",
      ]),
      dependencies: components ? ["thrower"] : [],
      schema: SCHEMA,
      // Without the component, its calls stay unreached (`componentsGeneric` is a proxy).
      changedModules: PROCESS ? [APP] : [APP, NODE],
      unchangedModuleHashes: [],
      udfServerVersion: "1.46.0",
    },
    componentDefinitions: components ? [THROWER] : [],
  });
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  await post("/api/deploy2/wait_for_schema", {
    adminKey: KEY,
    schemaChange: start.body!.schemaChange,
    timeoutMs: 5000,
  });
  const finish = await post("/api/deploy2/finish_push", { adminKey: KEY, startPush: start.body, dryRun: false });
  if (finish.status !== 200) throw new Error(JSON.stringify(finish.body));
  return async (kind: "query" | "mutation" | "action", path: string, args: object = {}) =>
    (await post(`/api/${kind}`, { path, args, format: "json" }, null)).body!;
}

type Case = readonly [kind: "query" | "mutation" | "action", path: string, callee: string, frames: RegExp];
// The callee's uncaught display is the message (STUDY-41 N2); the caller's frames are where it called (a query's or a
// mutation's nested call, STUDY-95) or awaited (an action's, STUDY-150), mapped to its module: as before this fix.
const SYNC = /^ {4}at <anonymous> \(app\.js:\d+:\d+\)\n {4}at handler \(app\.js:\d+:\d+\)$/;
const ASYNC = /^ {4}at async <anonymous> \(app\.js:\d+:\d+\)$/;
const NODE_ASYNC = /^ {4}at async <anonymous> \(node\.js:\d+:\d+\)$/;
const CASES: Case[] = [
  ["query", "app:queryToQuery", "app", SYNC],
  ["mutation", "app:mutationToQuery", "app", SYNC],
  ["mutation", "app:mutationToMutation", "app", SYNC],
  ["action", "app:actionToMutation", "app", ASYNC],
  ["action", "app:actionToAction", "app", ASYNC],
];
const COMPONENT_CASES: Case[] = [
  ["query", "app:queryToComponent", "component", SYNC],
  ["mutation", "app:mutationToComponent", "component", SYNC],
  ["action", "app:actionToComponent", "component", ASYNC],
];
const NODE_CASES: Case[] = [["action", "node:nodeToMutation", "app", NODE_ASYNC]];

function check(seen: Record<string, any>, data: boolean, callee: string, frames: RegExp, path: string) {
  const { stack, message, ...rest } = seen;
  expect({ path, ...rest } as Record<string, unknown>).toEqual({
    path,
    isError: true,
    isBunvexError: data,
    proto: data ? "BunvexError" : "Error",
    ctor: data ? "BunvexError" : "Error",
    name: data ? "BunvexError" : "Error",
    data: data ? { code: callee === "app" ? "APP" : "COMPONENT" } : "undefined",
    tag: "[object Error]",
  });
  // The callee's uncaught line and its own frame, as before.
  const line = data
    ? `Uncaught BunvexError: {"code":"${callee === "app" ? "APP" : "COMPONENT"}"}`
    : `Uncaught Error: ${callee} boom`;
  expect(message).toStartWith(`${line}\n    at fail (${callee === "app" ? "app" : "lib"}.js:`);
  // The caller's frames: a header-less stack, a Node action's after its header (`Error: <message>`).
  const header = `Error: ${message}\n`;
  expect(frames === NODE_ASYNC ? String(stack).startsWith(header) : true).toBe(true);
  expect(frames === NODE_ASYNC ? String(stack).slice(header.length) : stack).toMatch(frames);
}

/** A client's error message without its request id, its positions as `N:N`. */
const shown = (m: string) => m.replace(/^\[Request ID: [0-9a-f]+\] /, "").replace(/:\d+:\d+\)/g, ":N:N)");

describe("a nested call's error, as its caller catches it", () => {
  for (const [what, cases, skip] of [
    ["the app's own functions", CASES, false],
    ["a component's functions (under `process` with #822)", COMPONENT_CASES, PROCESS],
    ["from a Node action (under `process` with STUDY-168 PR 10)", NODE_CASES, PROCESS],
  ] as const)
    test.skipIf(skip)(`${what}: an error of the caller's realm, its message, data and frames kept`, async () => {
      const call = await deployment();
      for (const [kind, path, callee, frames] of cases)
        for (const data of [false, true]) {
          const r = await call(kind, path, { data });
          expect({ path, status: r.status }).toEqual({ path, status: "success" });
          check(r.value, data, callee, frames, path);
        }
    });

  test("the app's own BunvexError is an Error of its realm, and a subclass of it too", async () => {
    const call = await deployment();
    for (const data of [false, true]) {
      const own = (await call("query", "app:own", { data })).value;
      expect([own.isError, own.isBunvexError, own.proto, own.ctor]).toEqual(
        data ? [true, true, "BunvexError", "BunvexError"] : [true, false, "Error", "Error"],
      );
    }
    expect((await call("query", "app:subclass")).value).toEqual([true, true, true, "BunvexError", "foo"]);
  });

  test("left uncaught, the caller's error reaches the client as before: the message and the data", async () => {
    const call = await deployment();
    for (const path of ["app:queryUncaught", "app:actionUncaught"]) {
      const kind = path === "app:queryUncaught" ? "query" : "action";
      const caller = kind === "query" ? "    at <anonymous> (app.js:N:N)" : "    at async <anonymous> (app.js:N:N)";
      const frames = "    at fail (app.js:N:N)\n    at handler (app.js:N:N)\n\n";
      const plain = await call(kind, path, { data: false });
      expect([shown(plain.errorMessage), plain.errorData]).toEqual([
        `Server Error\nUncaught Error: app boom\n${frames}${caller}\n`,
        undefined,
      ]);
      const withData = await call(kind, path, { data: true });
      expect([shown(withData.errorMessage), withData.errorData]).toEqual([
        `Server Error\nUncaught BunvexError: {"code":"APP"}\n${frames}${caller}\n`,
        { code: "APP" },
      ]);
    }
  });
});

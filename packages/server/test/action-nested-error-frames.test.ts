// A nested call's error as it leaves the action that called it (Convex's `performAsyncSyscall`, syscall.ts, and
// `format_uncaught_error`, isolate/src/helpers.rs): the callee's display, then the action's own frame — where it
// awaited the call, `at async …` — and never a server frame. Pushed code, from a V8 and a "use node" module.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { MemoryBlobStore } from "@bunvex/file-storage";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = ["bunvex", "server"].join("/");
const VALUES = ["bunvex", "values"].join("/");
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const callers = (environment: string) => `
const refs = {
  plain: makeFunctionReference("throws:plain"),
  app: makeFunctionReference("throws:app"),
  mutation: makeFunctionReference("throws:mutation"),
  action: makeFunctionReference("throws:action"),
};
const call = (ctx, target) =>
  target === "mutation" ? ctx.runMutation(refs[target]) : target === "action" ? ctx.runAction(refs[target]) : ctx.runQuery(refs[target]);
export const uncaught = actionGeneric(async (ctx, { target }) => {
  await call(ctx, target);
});
// ${environment}`;

async function deployment() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    moduleStorage: new MemoryBlobStore(),
    redactLogsToClient: false,
  });
  stops.push(() => s.shutdown());
  await s.deployCode([
    {
      path: "throws.js",
      source: `import { actionGeneric, mutationGeneric, queryGeneric } from ${JSON.stringify(SERVER)};
import { BunvexError } from ${JSON.stringify(VALUES)};
export const plain = queryGeneric(async () => { throw new Error("Normal error"); });
export const app = queryGeneric(async () => { throw new BunvexError("Boom boom bop"); });
export const mutation = mutationGeneric(async () => { throw new BunvexError({ code: 123n }); });
export const action = actionGeneric(async () => { throw new BunvexError("Boom boom bop"); });`,
      environment: "isolate",
    },
    {
      path: "v8.js",
      source: `import { actionGeneric, makeFunctionReference } from ${JSON.stringify(SERVER)};${callers("isolate")}`,
      environment: "isolate",
    },
    {
      path: "http.js",
      source: `import { httpActionGeneric, httpRouter, makeFunctionReference } from ${JSON.stringify(SERVER)};
const http = httpRouter();
http.route({ path: "/nested", method: "GET", handler: httpActionGeneric(async (ctx) => {
  await ctx.runQuery(makeFunctionReference("throws:plain"));
  return new Response("unreachable");
}) });
export default http;`,
      environment: "isolate",
    },
    {
      path: "nodeCaller.js",
      source: `"use node";
import { actionGeneric, makeFunctionReference } from ${JSON.stringify(SERVER)};${callers("node")}`,
      environment: "node",
    },
  ]);
  const site = `http://127.0.0.1:${s.server.port}`;
  const run = async (path: string, target: string) =>
    (await (
      await fetch(`${site}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: { target }, format: "json" }),
      })
    ).json()) as { status: string; errorMessage: string; errorData?: unknown };
  return { run, site };
}

// The callee's line, then the caller's `await` in `module`.
const shape = (head: string, callee: string, module: string) =>
  new RegExp(
    `^\\[Request ID: [0-9a-f]{16}\\] Server Error\\n${head}\\n    at <anonymous> \\(${callee}:\\d+:\\d+\\)\\n\\n` +
      `    at async <anonymous> \\(${module}:\\d+:\\d+\\)\\n$`,
  );

test("an uncaught nested error: the callee's display, then the caller's await, no server frame", async () => {
  const { run } = await deployment();
  for (const [module, path] of [
    ["v8.js", "v8:uncaught"],
    ["nodeCaller.js", "nodeCaller:uncaught"],
  ] as const) {
    const plain = await run(path, "plain");
    expect(plain).toMatchObject({ status: "error" });
    expect(plain.errorMessage).toMatch(shape("Uncaught Error: Normal error", "throws.js", module));
    const app = await run(path, "app");
    expect(app.errorMessage).toMatch(shape("Uncaught BunvexError: Boom boom bop", "throws.js", module));
    expect(app.errorData).toBe("Boom boom bop");
    const mutation = await run(path, "mutation");
    expect(mutation.errorMessage).toMatch(shape('Uncaught BunvexError: \\{"code":"123n"\\}', "throws.js", module));
    expect(mutation.errorData).toEqual({ code: "123" });
    const action = await run(path, "action");
    expect(action.errorMessage).toMatch(shape("Uncaught BunvexError: Boom boom bop", "throws.js", module));
  }
});

test("an HTTP action's uncaught nested error: the same, with the route handler's await", async () => {
  const { site } = await deployment();
  const r = await fetch(`${site}/http/nested`);
  expect(r.status).toBe(500);
  const { trace } = (await r.json()) as { trace: string };
  expect(trace).toMatch(
    /^Uncaught Error: Normal error\n {4}at <anonymous> \(throws\.js:\d+:\d+\)\n\n {4}at async <anonymous> \(http\.js:\d+:\d+\)$/,
  );
});

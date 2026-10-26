// Dynamic `import()` (STUDY-188 §X14) under both function sandboxes, `vm` and `process`: the answers Convex's backend
// gives (packages/differential/test/dynamic-import.test.ts compares them with it). In an action a module of the
// version resolves, once; a missing path rejects with "Couldn't find JavaScript module"; a module that throws while
// loading fails the action even inside `try` (Q3). A query or a mutation (an action's nested one too) rejects with
// `TypeError: dynamic module import unsupported`. A `"use node"` module imports as Node does (`vm` only: Node actions
// do not run under `process` yet).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));

const DYNAMIC = `import { action, mutation, query } from ${SERVER};
import { v } from ${VALUES};
const described = (e) => ({ name: e.name, message: e.message, isError: e instanceof Error, isTypeError: e instanceof TypeError });
const tryImport = async (spec) => { try { return { exports: Object.keys(await import(spec)).sort() }; } catch (e) { return { rejected: described(e) }; } };
export const sibling = action(async () => { const a = await import("./helpers.js"); const b = await import("./helpers.js"); return { fib: a.fibonacci(10), same: a === b }; });
export const lazyChunk = action(async () => { const m = await import("./_deps/lazy.js"); return { value: m.lazy, loads: globalThis.lazyLoads }; });
export const importSpec = action({ args: { spec: v.string() }, handler: async (_ctx, { spec }) => tryImport(spec) });
export const throwsOnLoad = action(async () => { await import("./_deps/thrower.js"); return "loaded"; });
export const throwsOnLoadCaught = action(async () => { try { await import("./_deps/thrower.js"); return "loaded"; } catch (e) { return { caught: described(e) }; } });
export const inQuery = query(async () => (await import("./helpers.js")).fibonacci(10));
export const inQueryCaught = query({ args: { spec: v.string() }, handler: async (_ctx, { spec }) => tryImport(spec) });
export const inMutation = mutation(async () => (await import("./helpers.js")).fibonacci(10));
export const inMutationCaught = mutation({ args: { spec: v.string() }, handler: async (_ctx, { spec }) => tryImport(spec) });
export const nestedQuery = action(async (ctx) => ctx.runQuery("dynamic:inQueryCaught", { spec: "./helpers" }));
`;
const HELPERS = `export function fibonacci(n) { return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2); }`;
const LAZY = `globalThis.lazyLoads = (globalThis.lazyLoads ?? 0) + 1;\nexport const lazy = "loaded";`;
const THROWER = `throw new Error("boom");\nexport default null;`;
const NODE = `"use node";
import { action } from ${SERVER};
import { v } from ${VALUES};
export const sibling = action(async () => { const a = await import("./_deps/node/helpers.js"); const b = await import("./_deps/node/helpers.js"); return { fib: a.fibonacci(10), same: a === b }; });
export const importSpec = action({ args: { spec: v.string() }, handler: async (_ctx, { spec }) => {
  try { return { exports: Object.keys(await import(spec)).length > 0 }; }
  catch (e) { return { rejected: { name: e.name, message: e.message, code: e.code, isError: e instanceof Error } }; }
} });
export const throwsOnLoadCaught = action(async () => { try { await import("./_deps/node/thrower.js"); return "loaded"; } catch (e) { return { caught: { name: e.name, message: e.message } }; } });
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string };

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
  });
  await s.codeReady;
  await s.deployCode([
    { path: "dynamic.js", source: DYNAMIC, environment: "isolate" },
    { path: "helpers.js", source: HELPERS, environment: "isolate" },
    { path: "_deps/lazy.js", source: LAZY, environment: "isolate" },
    { path: "_deps/thrower.js", source: THROWER, environment: "isolate" },
    { path: "node.js", source: NODE, environment: "node" },
    { path: "_deps/node/helpers.js", source: HELPERS, environment: "node" },
    { path: "_deps/node/thrower.js", source: THROWER, environment: "node" },
  ]);
  const call = async (kind: string, path: string, args: object = {}): Promise<unknown> => {
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    });
    if (r.status !== 200) return { http: r.status };
    const o = (await r.json()) as Outcome;
    if (o.status === "success") return { value: o.value };
    // The error's first line (its frames are the app's, mapped; compared elsewhere).
    return { error: (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "").split("\n")[0] };
  };
  return { s, call };
}

const missing = (path: string) => ({
  rejected: {
    name: "Error",
    message: `Couldn't find JavaScript module '${path}'. Did you forget to run \`bunvex dev\`?\n`,
    isError: true,
    isTypeError: false,
  },
});
const unsupported = {
  rejected: { name: "TypeError", message: "dynamic module import unsupported", isError: true, isTypeError: true },
};

for (const sandbox of ["vm", "process"] as const) {
  describe(`dynamic import() under ${sandbox}`, () => {
    let d: Awaited<ReturnType<typeof deployment>>;
    beforeAll(async () => {
      d = await deployment(sandbox);
    });
    afterAll(async () => {
      await d?.s.stop();
    });

    test("an action imports a sibling module: the same namespace each time", async () => {
      expect(await d.call("action", "dynamic:sibling")).toEqual({ value: { fib: 55, same: true } });
    });

    test("a module only a dynamic import reaches loads on the first one, once", async () => {
      expect(await d.call("action", "dynamic:lazyChunk")).toEqual({ value: { value: "loaded", loads: 1 } });
      expect(await d.call("action", "dynamic:lazyChunk")).toEqual({ value: { value: "loaded", loads: 1 } });
    });

    test("a specifier resolves against the importing module, `.js` added when it has no extension", async () => {
      for (const spec of ["./helpers", "./helpers.js", "../helpers", "/helpers", "./x/../helpers"])
        expect(await d.call("action", "dynamic:importSpec", { spec })).toEqual({ value: { exports: ["fibonacci"] } });
    });

    test("a path that names no module rejects with Convex's message, naming the path as resolved", async () => {
      for (const [spec, path] of [
        ["./nonexistentPath", "nonexistentPath"],
        ["./nonexistentPath.js", "nonexistentPath.js"],
        ["./sub/dir/../../missing", "missing"],
        ["./_generated/api", "_generated/api"],
      ])
        expect(await d.call("action", "dynamic:importSpec", { spec })).toEqual({ value: missing(path) });
    });

    test("a bare specifier rejects: not prefixed with / or ./ or ../", async () => {
      expect(await d.call("action", "dynamic:importSpec", { spec: "lodash" })).toEqual({
        value: {
          rejected: {
            name: "Error",
            message: 'Relative import path "lodash" not prefixed with / or ./ or ../ from "bunvex:/dynamic.js"',
            isError: true,
            isTypeError: false,
          },
        },
      });
    });

    test("a module that throws while loading fails the action, even inside try (Q3), every time", async () => {
      for (const path of ["dynamic:throwsOnLoad", "dynamic:throwsOnLoadCaught", "dynamic:throwsOnLoadCaught"])
        expect(await d.call("action", path)).toEqual({ error: "Uncaught Error: boom" });
    });

    test("a query, a mutation and an action's nested query reject with dynamic module import unsupported", async () => {
      expect(await d.call("query", "dynamic:inQuery")).toEqual({
        error: "Uncaught TypeError: dynamic module import unsupported",
      });
      expect(await d.call("mutation", "dynamic:inMutation")).toEqual({
        error: "Uncaught TypeError: dynamic module import unsupported",
      });
      for (const spec of ["./helpers", "./nonexistentPath"]) {
        expect(await d.call("query", "dynamic:inQueryCaught", { spec })).toEqual({ value: unsupported });
        expect(await d.call("mutation", "dynamic:inMutationCaught", { spec })).toEqual({ value: unsupported });
      }
      expect(await d.call("action", "dynamic:nestedQuery")).toEqual({ value: unsupported });
    });

    test('a V8 action importing a "use node" module is a system error', async () => {
      expect(await d.call("action", "dynamic:importSpec", { spec: "./node" })).toEqual({ http: 500 });
    });

    test.skipIf(sandbox === "process")('a "use node" action imports as Node does', async () => {
      expect(await d.call("action", "node:sibling")).toEqual({ value: { fib: 55, same: true } });
      expect(await d.call("action", "node:importSpec", { spec: "node:fs" })).toEqual({ value: { exports: true } });
      // Node resolves a file exactly: no `.js` added, and the V8 runtime's modules are not there.
      for (const [spec, path] of [
        ["./_deps/node/helpers", "_deps/node/helpers"],
        ["./helpers.js", "helpers.js"],
        ["./nonexistentPath", "nonexistentPath"],
      ])
        expect(await d.call("action", "node:importSpec", { spec })).toEqual({
          value: {
            rejected: {
              name: "Error",
              message: `Cannot find module '${path}' imported from node.js`,
              code: "ERR_MODULE_NOT_FOUND",
              isError: true,
            },
          },
        });
      // A module that throws while loading rejects the import, as JavaScript does.
      expect(await d.call("action", "node:throwsOnLoadCaught")).toEqual({
        value: { caught: { name: "Error", message: "boom" } },
      });
    });
  });
}

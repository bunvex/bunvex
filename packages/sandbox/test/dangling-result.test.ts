// A query's or mutation's result changed after its handler returned (STUDY-188 §X19 a), the same pushed code under
// `vm` and under `process`: what the function returns is its result as it stood two microtask turns after its
// handler's promise settled, where Convex serializes it (`invokeQuery` / `invokeMutation`). A read left unawaited
// whose `.then` pushes into the returned array, on an empty table and on one with a document, a nested call's result,
// and pushes after 0 to 4 microtask turns. `packages/differential`'s `dangling-result.test.ts` compares with Convex's
// binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));

const MODULE = `
import { query, mutation } from ${SERVER};
const dangling = async ({ db }) => {
  const result = [];
  void db.query("objects").first().then((d) => result.push(d));
  return result;
};
export const q = query({ args: {}, handler: dangling });
export const m = mutation({ args: {}, handler: dangling });
export const sync = query({ args: {}, handler: ({ db }) => {
  const result = { a: 1 };
  void db.query("objects").first().then((d) => { result.b = d; });
  return result;
} });
export const nested = query({ args: {}, handler: (ctx) => ctx.runQuery("cases:q", {}) });
export const microtasks = query({ args: {}, handler: async () => {
  const result = [];
  for (let n = 0; n <= 4; n++) {
    let p = Promise.resolve();
    for (let i = 0; i < n; i++) p = p.then(() => {});
    void p.then(() => result.push(n));
  }
  return result;
} });
export const insert = mutation({ args: {}, handler: async ({ db }) => { await db.insert("objects", {}); } });
`;

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    ...(sandbox === "process" ? { functionSandboxIsolation: "none" as const } : {}),
  });
  await s.codeReady;
  await s.deployCode([{ path: "cases.js", source: MODULE, environment: "isolate" }]);
  const call = async (kind: "query" | "mutation", name: string) => {
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: `cases:${name}`, args: {} }),
    });
    return ((await r.json()) as { value?: unknown }).value;
  };
  return { call, stop: () => s.shutdown() };
}

for (const sandbox of ["vm", "process"] as const)
  describe(`under ${sandbox}`, () => {
    let d: Awaited<ReturnType<typeof deployment>>;
    beforeAll(async () => {
      d = await deployment(sandbox);
    }, 30_000);
    afterAll(() => d?.stop());

    test("a read left unawaited does not change the result, the table empty or not", async () => {
      for (const phase of ["empty", "one document"]) {
        if (phase === "one document") await d.call("mutation", "insert");
        expect([phase, await d.call("query", "q")]).toEqual([phase, []]);
        expect([phase, await d.call("mutation", "m")]).toEqual([phase, []]);
        expect([phase, await d.call("query", "sync")]).toEqual([phase, { a: 1 }]);
        expect([phase, await d.call("query", "nested")]).toEqual([phase, []]);
      }
    });

    test("the result is read two microtask turns after the handler's promise settled", async () => {
      expect(await d.call("query", "microtasks")).toEqual([0, 1]);
    });
  });

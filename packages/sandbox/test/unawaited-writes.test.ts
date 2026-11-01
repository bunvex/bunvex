// A mutation's operations it did not await, under `vm` and under `process` (STUDY-187 §2.11): Convex runs a query's
// or mutation's syscalls to the end before it answers (`environment/udf/mod.rs`: the loop ends when no syscall is
// pending), so a write chained after an unawaited operation, started by the code that operation's answer resumes once
// the handler has returned, is part of the mutation. Under `process` the child waited only for the operations in
// flight when the handler settled, and the chained one held the call to its 1 s limit. The functions are Convex's
// `danglingMutation` and `doublyDanglingMutation` (`udf-tests/convex/asyncTests.ts`) and a write after an unawaited
// read; `packages/differential`'s `dangling-writes.test.ts` compares with Convex's binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));

const MODULE = `
import { query, mutation } from ${SERVER};
export const dangling = mutation({ args: {}, handler: async ({ db }) => {
  void db.insert("one", {});
} });
export const doublyDangling = mutation({ args: {}, handler: async ({ db }) => {
  void (async () => {
    await db.insert("two", {});
    await db.insert("two", {});
  })();
} });
export const afterRead = mutation({ args: {}, handler: async ({ db }) => {
  void db.query("three").first().then((d) => (d ? db.patch(d._id, { n: 7 }) : db.insert("three", { n: 7 })));
} });
export const chain = mutation({ args: {}, handler: ({ db }) => {
  void (async () => {
    for (let i = 0; i < 5; i++) await db.insert("four", { i });
  })();
  return "returned";
} });
export const nested = mutation({ args: {}, handler: async (ctx) => {
  void ctx.runQuery("cases:count", { table: "one" }).then(() => ctx.runMutation("cases:dangling", {}));
} });
export const count = query({ handler: async ({ db }, { table }) => (await db.query(table).collect()).length });
export const n = query({ args: {}, handler: async ({ db }) => (await db.query("three").collect()).map((d) => d.n) });
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
  const call = async (kind: "query" | "mutation", name: string, args: object = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: `cases:${name}`, args }),
    });
    const body = (await r.json()) as { status: string; value?: unknown; errorMessage?: string };
    return body.status === "success" ? body.value : `error: ${body.errorMessage}`;
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

    test("every write a mutation left unawaited is committed, a chained one included", async () => {
      expect(await d.call("mutation", "dangling")).toBeNull();
      expect(await d.call("query", "count", { table: "one" })).toBe(1);
      expect(await d.call("mutation", "doublyDangling")).toBeNull();
      expect(await d.call("query", "count", { table: "two" })).toBe(2);
      expect(await d.call("mutation", "afterRead")).toBeNull();
      expect(await d.call("mutation", "afterRead")).toBeNull();
      expect(await d.call("query", "n")).toEqual([7]);
      expect(await d.call("mutation", "chain")).toBe("returned");
      expect(await d.call("query", "count", { table: "four" })).toBe(5);
      expect(await d.call("mutation", "nested")).toBeNull();
      expect(await d.call("query", "count", { table: "one" })).toBe(2);
    });
  });

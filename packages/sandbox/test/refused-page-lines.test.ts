// A nested query's return refused for a second page (STUDY-186 A8, Convex d7402d6), the same pushed code under `vm`
// and under `process`: as Convex's `runUdf` emits a nested call's lines only once its page is merged into its
// caller's, the refused callee's lines are dropped, its caller's kept; a callee taken, or one that fails, keeps its
// lines. `packages/differential`'s `paginate-components.test.ts` compares the same with Convex's binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));
const MULTIPLE =
  "This query function ran multiple paginated queries. bunvex only supports a single paginated query in each query function.";

const MODULE = `
import { query, mutation } from ${SERVER};
const page = (db) => db.query("items").paginate({ numItems: 1, cursor: null });
export const seed = mutation({ args: {}, handler: async ({ db }) => { await db.insert("items", { n: 1 }); } });
export const callee = query({ args: {}, handler: async ({ db }) => {
  console.log("callee before");
  const p = await page(db);
  console.log("callee after");
  return p.page.length;
} });
export const fails = query({ args: {}, handler: async ({ db }) => {
  console.log("fails before");
  await page(db);
  throw new Error("after the page");
} });
export const refused = query({ args: {}, handler: async (ctx) => {
  console.log("caller before");
  await page(ctx.db);
  try {
    return await ctx.runQuery("cases:callee", {});
  } catch (e) {
    console.log("caller caught");
    return e.message;
  } finally {
    console.log("caller after");
  }
} });
export const taken = query({ args: {}, handler: async (ctx) => {
  console.log("caller before");
  const n = await ctx.runQuery("cases:callee", {});
  console.log("caller after");
  return n;
} });
export const twice = query({ args: {}, handler: async (ctx) => {
  await ctx.runQuery("cases:callee", {});
  try {
    return await ctx.runQuery("cases:callee", {});
  } catch (e) {
    return e.message;
  }
} });
export const failed = query({ args: {}, handler: async (ctx) => {
  const caught = await ctx.runQuery("cases:fails", {}).catch((e) => e.message.split("\\n")[0]);
  console.log("caller pages");
  return [caught, (await page(ctx.db)).page.length];
} });
`;

async function deployment(sandbox: "vm" | "process") {
  const schema = defineSchema({ items: defineTable({ n: v.number() }) });
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
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
    const o = (await r.json()) as { value?: unknown; errorMessage?: string; logLines?: string[] };
    return { value: o.value, error: o.errorMessage, logLines: o.logLines ?? [] };
  };
  await call("mutation", "seed");
  return { call, stop: () => s.shutdown() };
}

for (const sandbox of ["vm", "process"] as const)
  describe(`under ${sandbox}`, () => {
    let d: Awaited<ReturnType<typeof deployment>>;
    beforeAll(async () => {
      d = await deployment(sandbox);
    }, 30_000);
    afterAll(() => d?.stop());

    test("a callee refused for a second page: its lines dropped, the caller's kept", async () => {
      expect(await d.call("query", "refused")).toEqual({
        value: MULTIPLE,
        error: undefined,
        logLines: ["[LOG] 'caller before'", "[LOG] 'caller caught'", "[LOG] 'caller after'"],
      });
      expect(await d.call("query", "twice")).toEqual({
        value: MULTIPLE,
        error: undefined,
        logLines: ["[LOG] 'callee before'", "[LOG] 'callee after'"],
      });
    });

    test("a callee taken, or one that fails, keeps its lines", async () => {
      expect(await d.call("query", "taken")).toEqual({
        value: 1,
        error: undefined,
        logLines: ["[LOG] 'caller before'", "[LOG] 'callee before'", "[LOG] 'callee after'", "[LOG] 'caller after'"],
      });
      expect(await d.call("query", "failed")).toEqual({
        value: ["Uncaught Error: after the page", 1],
        error: undefined,
        logLines: ["[LOG] 'fails before'", "[LOG] 'caller pages'"],
      });
    });
  });

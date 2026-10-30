// A query or mutation whose returned promise can never resolve (STUDY-188 §X16), the same pushed code under `vm` and
// under `process`: Convex fails it at once with "Returned promise will never resolve", its message alone
// (`environment/udf/mod.rs`), where bunvex held the call, its permit and its transaction until the request's timeout.
// A nested call that never resolves fails in its caller, which may catch it. Handlers that wait on real work are not
// taken for one, on a store whose reads take turns of the event loop: reads chained one after the other, a nested
// call, a stale-snapshot query (its own transaction), and `crypto.subtle` work Bun answers from its thread pool turns
// later. `packages/differential`'s
// `never-resolves.test.ts` compares the answers with Convex's binary.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { createProcessExecutor } from "../src/executor.ts";

provideProcessExecutor(createProcessExecutor);

const SERVER = JSON.stringify(["@bunvex", "server"].join("/"));

const MODULE = `
import { query, mutation } from ${SERVER};
const forever = () => new Promise(() => {});
export const never = query({ args: {}, handler: async () => forever() });
export const neverSync = query({ args: {}, handler: () => forever() });
export const neverAfterRead = query({ args: {}, handler: async (ctx) => { await ctx.db.query("items").first(); return forever(); } });
export const neverWrites = mutation({ args: {}, handler: async (ctx) => { await ctx.db.insert("items", { tag: "never" }); return forever(); } });
export const nested = query({ args: {}, handler: async (ctx) => ctx.runQuery("cases:never", {}) });
export const nestedCaught = query({ args: {}, handler: async (ctx) => {
  try { await ctx.runQuery("cases:never", {}); return "not caught"; }
  catch (e) { return { name: e.name, message: e.message, after: (await ctx.db.query("items").collect()).length }; }
} });
export const chained = query({ args: {}, handler: async (ctx) => {
  const seen = [];
  let doc = await ctx.db.query("items").first();
  for (let i = 0; i < 5 && doc; i++) {
    seen.push(doc.k);
    const next = doc.k;
    doc = await ctx.db.query("items").filter((q) => q.gt(q.field("k"), next)).first();
  }
  const [all, last] = await Promise.all([ctx.db.query("items").collect(), ctx.db.query("items").order("desc").first()]);
  return { seen, all: all.length, last: last.k };
} });
export const nestedChain = mutation({ args: {}, handler: async (ctx) => {
  const a = await ctx.runQuery("cases:chained", {});
  const stale = await ctx.runQuery("cases:chained", {}, { useStaleSnapshot: true });
  return { a: a.seen, stale: stale.seen };
} });
export const digest = query({ args: {}, handler: async () => {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(8 * 1024 * 1024));
  return [...new Uint8Array(d)].slice(0, 4);
} });
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("items").collect()).length });
`;

type Outcome = { status: string; value?: unknown; errorMessage?: string };

/** A store whose reads answer a few ms later, as a remote database's do: each read waits turns of the event loop. */
async function slowStore() {
  const p = await MemoryPersistence.open(null, { durable: false });
  const slow =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      await Bun.sleep(2);
      return await f(...a);
    };
  p.get = slow(p.get.bind(p)) as never;
  p.scan = slow(p.scan.bind(p)) as never;
  return p;
}

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), await slowStore()).init();
  const s = createServer({
    engine,
    functions: new Functions(engine),
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    ...(sandbox === "process" ? { functionSandboxIsolation: "none" as const } : {}),
  });
  await s.codeReady;
  await engine.mutation(async (db) => {
    for (const k of [1, 2, 3]) await db.insert("items", { k });
  });
  await s.deployCode([{ path: "cases.js", source: MODULE, environment: "isolate" }]);
  const call = async (kind: "query" | "mutation", name: string) => {
    const r = await fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: `cases:${name}`, args: {} }),
    });
    const o = (await r.json()) as Outcome;
    if (o.status === "success") return { value: o.value };
    // Without the request id; a nested call's frames are not this study's (STUDY-95).
    return {
      error: (o.errorMessage ?? "").replace(/^\[Request ID: [0-9a-f]+\] Server Error\n/, "").split("\n    at ")[0],
    };
  };
  return { call, stop: () => s.shutdown() };
}

const NEVER = { error: "Returned promise will never resolve\n" };

for (const sandbox of ["vm", "process"] as const)
  describe(`under ${sandbox}`, () => {
    let d: Awaited<ReturnType<typeof deployment>>;
    beforeAll(async () => {
      d = await deployment(sandbox);
    }, 30_000);
    // The close waits for every mutation still running: one held forever would hold it too.
    afterAll(() => d?.stop());

    test("a query or mutation that can never resolve fails at once, with the message alone", async () => {
      const start = performance.now();
      expect(await d.call("query", "never")).toEqual(NEVER);
      expect(await d.call("query", "neverSync")).toEqual(NEVER);
      expect(await d.call("query", "neverAfterRead")).toEqual(NEVER);
      expect(await d.call("mutation", "neverWrites")).toEqual(NEVER);
      expect(performance.now() - start).toBeLessThan(1000);
      // The mutation failed: its write is not committed.
      expect(await d.call("query", "count")).toEqual({ value: 3 });
    });

    test("a nested call that never resolves fails in its caller, which can catch it", async () => {
      expect(await d.call("query", "nested")).toEqual({
        // The caller's frames cut (what follows is its call site's).
        error: "Uncaught Error: Returned promise will never resolve\n",
      });
      expect(await d.call("query", "nestedCaught")).toEqual({
        value: { name: "Error", message: "Returned promise will never resolve\n", after: 3 },
      });
    });

    test("its permit is released: more of them than permits, then a query that answers", async () => {
      const all = await Promise.all(Array.from({ length: 40 }, () => d.call("query", "never")));
      expect(all).toEqual(Array.from({ length: 40 }, () => NEVER));
      expect(await d.call("query", "count")).toEqual({ value: 3 });
    });

    test("reads chained one after the other, nested calls and crypto.subtle are not taken for it", async () => {
      expect(await d.call("query", "chained")).toEqual({ value: { seen: [1, 2, 3], all: 3, last: 3 } });
      expect(await d.call("mutation", "nestedChain")).toEqual({ value: { a: [1, 2, 3], stale: [1, 2, 3] } });
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(8 * 1024 * 1024)))];
      expect(await d.call("query", "digest")).toEqual({ value: digest.slice(0, 4) });
    });
  });

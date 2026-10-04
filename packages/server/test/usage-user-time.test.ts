// User execution time (STUDY-71, DV-252), as Convex's: a query's or mutation's is its wall time minus its
// paused time (store calls), an action's its wall time (Convex pauses an action's clock only at start).
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";

const STORE_MS = 60;
const BUSY_MS = 40;
/** Spin for `ms` of real time (`performance.now` is frozen inside queries and mutations, as Convex's). */
const busy = (ms: number) => {
  const end = Bun.nanoseconds() + ms * 1e6;
  while (Bun.nanoseconds() < end) {}
};

async function setup() {
  const store = await MemoryPersistence.open(null, { durable: false });
  let slow = false;
  // Every document read waits STORE_MS once `slow` is on: time the function spends paused.
  const get = store.get.bind(store);
  store.get = (async (...a: Parameters<typeof get>) => {
    if (slow) await Bun.sleep(STORE_MS);
    return get(...a);
  }) as unknown as typeof store.get;
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), store).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 1 }));
  slow = true;
  const runs: { path: string; executionTime: number; userExecutionTime: number }[] = [];
  const functions = new Functions(engine).register("m", {
    reads: query(async ({ db }) => (await db.get(id as never)) && null),
    spins: query(() => {
      busy(BUSY_MS);
      return null;
    }),
    readsAndWrites: mutation(async ({ db }) => {
      await db.get(id as never);
      busy(BUSY_MS);
      await db.patch(id as never, { n: 2 });
    }),
    waits: action(async () => {
      await Bun.sleep(STORE_MS);
      return null;
    }),
  });
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") runs.push({ path: p.identifier, ...p });
    },
  } as unknown as FunctionLog;
  const run = async (kind: "query" | "mutation" | "action", path: string) => {
    if (kind === "query") await functions.runQuery(path, {});
    else if (kind === "mutation") await functions.runMutation(path, {});
    else await functions.runAction(path, {});
    return runs.at(-1)!;
  };
  return { run };
}

test("a query's store time is not user time; its own work is", async () => {
  const { run } = await setup();
  const reads = await run("query", "m:reads");
  expect(reads.executionTime).toBeGreaterThanOrEqual((STORE_MS - 5) / 1000);
  expect(reads.userExecutionTime).toBeLessThan(STORE_MS / 2 / 1000);
  const spins = await run("query", "m:spins");
  expect(spins.userExecutionTime).toBeGreaterThanOrEqual((BUSY_MS - 1) / 1000);
  expect(spins.userExecutionTime).toBeLessThanOrEqual(spins.executionTime);
});

test("a mutation's user time is its work between store calls", async () => {
  const { run } = await setup();
  const r = await run("mutation", "m:readsAndWrites");
  expect(r.executionTime).toBeGreaterThanOrEqual((STORE_MS + BUSY_MS - 5) / 1000);
  expect(r.userExecutionTime).toBeGreaterThanOrEqual((BUSY_MS - 1) / 1000);
  expect(r.userExecutionTime).toBeLessThan((BUSY_MS + STORE_MS / 2) / 1000);
});

test("an action's user time is its wall time, waits included, as Convex's", async () => {
  const { run } = await setup();
  const r = await run("action", "m:waits");
  expect(r.userExecutionTime).toBe(r.executionTime);
  expect(r.userExecutionTime).toBeGreaterThanOrEqual((STORE_MS - 5) / 1000);
});

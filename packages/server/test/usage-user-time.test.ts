// User execution time (STUDY-71, DV-252), as Convex's: a query's or mutation's is its wall time minus its
// paused time (store calls), an action's its wall time (Convex pauses an action's clock only at start).
// The time is virtual (STUDY-132): the store "takes" STORE_MS and a function "works" BUSY_MS by moving the test
// runtime's clock, so the times are exact however loaded the machine is (on the real clock, a query that did
// nothing read 31.6 ms of user time in the coverage job, over a 30 ms bound).
import { expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
import { v } from "@bunvex/values";
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";

const STORE_MS = 60;
const BUSY_MS = 40;

async function setup() {
  const rt = new TestRuntime();
  /** The function's own work for `ms`: no store call or timer interrupts it. */
  const busy = (ms: number) => rt.blockFor(ms);
  const store = await MemoryPersistence.open(null, { durable: false });
  let slow = false;
  // Every document read waits STORE_MS once `slow` is on: time the function spends paused.
  const get = store.get.bind(store);
  store.get = (async (...a: Parameters<typeof get>) => {
    if (slow) await rt.sleep(STORE_MS);
    return get(...a);
  }) as unknown as typeof store.get;
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), store, { runtime: rt }).init();
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
      await rt.sleep(STORE_MS);
      return null;
    }),
  });
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") runs.push({ path: p.identifier, ...p });
    },
  } as unknown as FunctionLog;
  const run = async (kind: "query" | "mutation" | "action", path: string) => {
    // The time moves through every store wait the function makes.
    if (kind === "query") await rt.runUntilSettled(functions.runQuery(path, {}));
    else if (kind === "mutation") await rt.runUntilSettled(functions.runMutation(path, {}));
    else await rt.runUntilSettled(functions.runAction(path, {}));
    return runs.at(-1)!;
  };
  return { run, engine };
}

test("a query's store time is not user time; its own work is", async () => {
  const { run, engine } = await setup();
  const reads = await run("query", "m:reads");
  expect(reads.executionTime).toBe(STORE_MS / 1000);
  expect(reads.userExecutionTime).toBe(0);
  const spins = await run("query", "m:spins");
  expect(spins.userExecutionTime).toBe(BUSY_MS / 1000);
  expect(spins.executionTime).toBe(BUSY_MS / 1000);
  await engine.close();
});

test("a mutation's user time is its work between store calls", async () => {
  const { run, engine } = await setup();
  const r = await run("mutation", "m:readsAndWrites");
  expect(r.executionTime).toBeGreaterThanOrEqual((STORE_MS + BUSY_MS) / 1000);
  // Counting the store's wait would give at least BUSY_MS + STORE_MS.
  expect(r.userExecutionTime).toBe(BUSY_MS / 1000);
  await engine.close();
});

test("an action's user time is its wall time, waits included, as Convex's", async () => {
  const { run, engine } = await setup();
  const r = await run("action", "m:waits");
  expect(r.executionTime).toBe(STORE_MS / 1000);
  expect(r.userExecutionTime).toBe(r.executionTime);
  await engine.close();
});

// A read made without recording it (`Tx.unrecorded`: the run state's and the variables' caches when they are cold)
// records nothing, the table mapping included: the transaction's next recorded use of a table reads the table mapping
// then, as it would have with the cache warm. Found by STUDY-194 2b's differential check, where a worker's cache and
// the main thread's were in different states and the same query's read sets differed.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

async function engine() {
  const e = await new Engine(
    defineSchema({ t: defineTable({ x: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  await e.mutation(async (db) => {
    await db.insert("t", { x: 1 });
  });
  return e;
}

/** A query's read set: the run state read as every function does, then table `t`. */
const reads = (e: Engine) =>
  e.query(async (db) => {
    await e.backendState.read(db);
    await db.query("t").collect();
    return JSON.stringify(db.reads, (_, x) => (x instanceof Uint8Array ? [...x] : x));
  });

test("the same read set whether the run state's cache is cold or warm", async () => {
  const e = await engine();
  const cold = await reads(e);
  const warm = await reads(e);
  expect(cold).toBe(warm);
});

test("a table first used in an unrecorded read still reads the table mapping when used again", async () => {
  const e = await engine();
  const tablesIndex = (e.catalog.table("_tables").indexes.get("by_creation_time") ?? e.catalog.table("_tables").byId)
    .id;
  const read = await e.query(async (db) => {
    await db.unrecorded(() => db.query("t").first());
    await db.query("t").first();
    return db.reads.map((i) => i.index);
  });
  expect(read).toContain(tablesIndex);
});

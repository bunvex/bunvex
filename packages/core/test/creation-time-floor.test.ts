import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine, transactionStart } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

// A transaction's first _creationTime is the clock floored at its snapshot (Convex's
// `CreationTime::for_transaction`): after a restart with the clock behind, commit timestamps resume from the
// store, ahead of the clock (STUDY-06 D9), and a new document must still sort after the ones it could read.
describe("_creationTime and Date.now() are floored at the snapshot", () => {
  test("transactionStart: the clock, never below the snapshot rounded up to the ms, never the last one", () => {
    expect(transactionStart(5_000_000, 9_000.5, 0)).toBe(9_000.5);
    expect(transactionStart(9_000_001, 5_000, 0)).toBe(9_001);
    expect(transactionStart(9_000_000, 5_000, 0)).toBe(9_000);
    const again = transactionStart(9_000_001, 5_000, 9_001);
    expect(again).toBeGreaterThan(9_001);
    expect(Math.floor(again)).toBe(9_001);
  });

  test("a restart whose stored timestamps are ahead of the clock: new documents and Date.now() follow them", async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const ahead = (Date.now() + 10_000) * 1000; // the last run's clock was 10 s ahead (µs)
    const realMaxTs = p.maxTs.bind(p);
    p.maxTs = () => Math.max(realMaxTs(), ahead);
    const e = await new Engine(defineSchema({ items: defineTable(v.any()) }), p).init();
    const { created, now } = await e.mutation(async (db) => {
      const id = await db.insert("items", { n: 1 });
      return { created: (await db.get("items", id))!._creationTime as number, now: Date.now() };
    });
    const floor = Math.ceil(ahead / 1000);
    expect(created).toBeGreaterThanOrEqual(floor);
    expect(now).toBeGreaterThanOrEqual(floor);
    expect(created).toBeGreaterThanOrEqual(now);
    // A later transaction never goes below what it read (Convex promises >=, not >: two transactions in the
    // same ms tie, and the creation-time index breaks ties by _id).
    const { first, second } = await e.mutation(async (db) => {
      const [doc] = await db.query("items").collect();
      const id = await db.insert("items", { n: 2 });
      return { first: doc!._creationTime as number, second: (await db.get("items", id))!._creationTime as number };
    });
    expect(first).toBe(created);
    expect(second).toBeGreaterThanOrEqual(first);
    await e.close();
  });
});

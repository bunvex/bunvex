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
    expect(transactionStart(5_000_000_000n, 9_000.5, 0)).toBe(9_000.5);
    expect(transactionStart(9_000_000_001n, 5_000, 0)).toBe(9_001);
    expect(transactionStart(9_000_000_000n, 5_000, 0)).toBe(9_000);
    const again = transactionStart(9_000_000_001n, 5_000, 9_001);
    expect(again).toBeGreaterThan(9_001);
    expect(Math.floor(again)).toBe(9_001);
  });

  test("a restart whose stored timestamps are ahead of the clock: new documents and Date.now() follow them", async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const ahead = BigInt(Date.now() + 10_000) * 1_000_000n; // the last run's clock was 10 s ahead (ns)
    const realMaxTs = p.maxTs.bind(p);
    p.maxTs = () => {
      const m = realMaxTs();
      return m > ahead ? m : ahead;
    };
    const e = await new Engine(defineSchema({ items: defineTable(v.any()) }), p).init();
    const { created, now } = await e.mutation(async (db) => {
      const id = await db.insert("items", { n: 1 });
      return { created: (await db.get("items", id))!._creationTime as number, now: Date.now() };
    });
    const floor = Number((ahead + 999_999n) / 1_000_000n);
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

  test("a transaction starts after every _creationTime the one before it handed out, not only after its start", async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    // the floor dominates, mid-millisecond: both transactions' snapshots round up to the same ms
    const ahead = BigInt(Date.now() + 10_000) * 1_000_000n + 500_000n;
    const realMaxTs = p.maxTs.bind(p);
    p.maxTs = () => {
      const m = realMaxTs();
      return m > ahead ? m : ahead;
    };
    const e = await new Engine(defineSchema({ items: defineTable(v.any()) }), p).init();
    // the first hands out many creation times; the second must start after all of them
    await e.mutation(async (db) => {
      for (let n = 0; n < 100; n++) await db.insert("items", { n });
    });
    await e.mutation(async (db) => {
      await db.insert("items", { n: 100 });
    });
    const docs = await e.query((db) => db.query("items").collect());
    expect(docs.map((d) => d.n)).toEqual(Array.from({ length: 101 }, (_, n) => n));
    await e.close();
  });
});

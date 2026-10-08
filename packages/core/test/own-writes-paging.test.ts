// A read over the transaction's own writes pages through the snapshot and the pending writes together, and must
// neither skip a committed document nor return one twice. Convex's backend did both until get-convex/
// convex-backend#59211 (5 Oct 2026, its issue #585): it merged the pending writes of the whole interval into each
// snapshot page, so a `take(n)` after an insert and a delete returned the new document in place of committed
// ones (the nightly differential run found it, #504). bunvex fetches past the removals and cuts at the limit;
// these tests hold it there, across page boundaries (the stream's first page is 64 rows).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ a: defineTable(v.any()).index("by_k", ["k"]) });
const open = async () => new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();

test("#504: after an insert and a delete, take(2) is the first two documents by creation time", async () => {
  const e = await open();
  const [r0, r1, r2] = await e.mutation(async (db) => [
    await db.insert("a", {}),
    await db.insert("a", {}),
    await db.insert("a", {}),
  ]);
  await e.mutation(async (db) => db.delete(r2!));
  const [r5] = await e.mutation(async (db) => [await db.insert("a", {}), await db.insert("a", {})]);
  const read = await e.mutation(async (db) => {
    await db.insert("a", {});
    await db.delete(r1!);
    return (await db.query("a").take(2)).map((d) => d._id);
  });
  expect(read).toEqual([r0, r5]);
  await e.close();
});

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("inside a mutation, take(n) and paginate over own patches, deletes and inserts match the committed result", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed);
    const e = await open();
    const n = 50 + Math.floor(r() * 200);
    const ids = await e.mutation(async (db) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(await db.insert("a", { k: Math.floor(r() * 20) }));
      return out;
    });
    const take = 1 + Math.floor(r() * 120);
    const size = 1 + Math.floor(r() * 70);
    const inside = await e.mutation(async (db) => {
      for (const id of ids) {
        const x = r();
        if (x < 0.15) await db.delete(id);
        else if (x < 0.35) await db.patch(id, { k: Math.floor(r() * 20) });
      }
      for (let i = Math.floor(r() * 30); i > 0; i--) await db.insert("a", { k: Math.floor(r() * 20) });
      const byTime = (await db.query("a").take(take)).map((d) => d._id);
      const byKey = (
        await db
          .query("a")
          .withIndex("by_k", (q) => q.gte("k", 5))
          .take(take)
      ).map((d) => d._id);
      // One paginated query per function (as Convex): its first page.
      const page = (await db.query("a").withIndex("by_k").paginate({ numItems: size, cursor: null })).page.map(
        (d) => d._id,
      );
      return { byTime, byKey, page };
    });
    const after = await e.query(async (db) => ({
      byTime: (await db.query("a").take(take)).map((d) => d._id),
      byKey: (
        await db
          .query("a")
          .withIndex("by_k", (q) => q.gte("k", 5))
          .take(take)
      ).map((d) => d._id),
      page: (await db.query("a").withIndex("by_k").take(size)).map((d) => d._id),
    }));
    expect({ seed, ...inside }).toEqual({ seed, ...after });
    for (const ids of [inside.byTime, inside.byKey, inside.page]) expect(new Set(ids).size).toBe(ids.length); // none twice
    await e.close();
  }
});

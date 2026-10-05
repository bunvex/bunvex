// What a query returns is the function's own: mutating it changes nothing in the transaction, as `get`'s copy
// and as Convex (values cross into the function's runtime). A query over the transaction's own writes used to
// hand out the written version itself, so a mutation of the result was written too, past the validators.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

test("mutating a query's result over the transaction's own writes changes neither the write nor its index", async () => {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_t", ["t"]) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const inside = await e.mutation(async (db) => {
    await db.insert("items", { t: "a", n: 1 });
    for (const read of [
      () =>
        db
          .query("items")
          .withIndex("by_t", (q) => q.eq("t", "a"))
          .collect(),
      () => db.query("items").collect(),
      async () => [await db.query("items").withIndex("by_t").first()],
    ]) {
      const [doc] = (await read()) as Record<string, unknown>[];
      doc!.n = 999;
      doc!.t = "b";
    }
    return (await db.query("items").collect()).map((d) => [d.t, d.n]);
  });
  expect(inside).toEqual([["a", 1]]);
  const stored = await e.query((db) => db.query("items").collect());
  expect(stored.map((d) => [d.t, d.n])).toEqual([["a", 1]]);
  expect(
    await e.query((db) =>
      db
        .query("items")
        .withIndex("by_t", (q) => q.eq("t", "a"))
        .collect(),
    ),
  ).toHaveLength(1);
  await e.close();
});

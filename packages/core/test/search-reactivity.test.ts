// Search reactivity (STUDY-45 PR 3), as Convex's `QueryReads`: a query's terms and filters invalidate its
// cached result and subscriptions on a written version with ANY of its terms or ANY of its filters; a
// mutation's search conflicts (OCC) only with a version that has EVERY filter and one of the terms.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({
  messages: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  other: defineTable(v.any()),
});

async function memory() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  return e;
}
const add = (e: Engine, doc: Record<string, unknown>) => e.mutation((db) => db.insert("messages", doc));

test("a cached search re-runs after a write with one of its terms or one of its filters, not otherwise", async () => {
  const e = await memory();
  await add(e, { body: "apple pie", channel: "a" });
  let runs = 0;
  const run = () =>
    e.query(async (db) => {
      runs++;
      return (
        await db
          .query("messages")
          .withSearchIndex("search_body", (q) => q.search("body", "apple tar").eq("channel", "a"))
          .collect()
      ).length;
    }, "search");
  expect(await run()).toBe(1);
  expect(await run()).toBe(1);
  expect(runs).toBe(1);
  // Unrelated: another table, and a document with none of the terms in another channel.
  await e.mutation((db) => db.insert("other", { body: "apple" }));
  await add(e, { body: "banana", channel: "b" });
  await run();
  expect(runs).toBe(1);
  // A term (the last, as a prefix: "tart"), in another channel: re-run (Convex's subscription rule).
  await add(e, { body: "tart", channel: "b" });
  await run();
  expect(runs).toBe(2);
  // The filter alone, without any term: re-run too.
  await add(e, { body: "cherry", channel: "a" });
  await run();
  expect(runs).toBe(3);
  await e.close();
});

/** A mutation that searches, waits for `gate`, then writes: what runs meanwhile may conflict with it. */
async function racing(e: Engine, meanwhile: (e: Engine) => Promise<unknown>) {
  let runs = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const searched = Promise.withResolvers<void>();
  const m = e.mutation(async (db: Tx) => {
    runs++;
    // Only the best match is read (by id): other documents can conflict through the search alone.
    await db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", "apple").eq("channel", "a"))
      .first();
    searched.resolve();
    await gate;
    await db.insert("other", { done: true });
  });
  await searched.promise;
  await meanwhile(e);
  open();
  await m;
  return runs;
}

test("a mutation's search conflicts only with a version that has every filter and a term (Convex's OCC rule)", async () => {
  const e = await memory();
  // A term, another channel: no conflict.
  expect(await racing(e, (e) => add(e, { body: "apple", channel: "b" }))).toBe(1);
  // The channel, no term: no conflict.
  expect(await racing(e, (e) => add(e, { body: "pear", channel: "a" }))).toBe(1);
  // Both: the mutation conflicts and runs again.
  expect(await racing(e, (e) => add(e, { body: "apple", channel: "a" }))).toBe(2);
  // A document that leaves the results (only its old version matched), though not the one read: a conflict.
  await add(e, { body: "apple apple apple", channel: "a" });
  const id = await add(e, { body: "apple crumble", channel: "a" });
  expect(await racing(e, (e) => e.mutation((db) => db.patch("messages", id, { body: "plum" })))).toBe(2);
  await e.close();
});

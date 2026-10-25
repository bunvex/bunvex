// A patch or replace that leaves the document as it was writes nothing (Convex's `patch_inner` / `replace_inner`,
// STUDY-187 §2.10): the mutation commits nothing, the queries that read the document stay valid, and a schema the
// document no longer matches is not checked. Against Convex's binary: packages/differential/test/noop-writes.test.ts.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

async function setup() {
  const engine = await new Engine(
    defineSchema({ b: defineTable({ x: v.number(), y: v.optional(v.array(v.any())) }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const { value: id, ts } = await engine.mutationWithTs((db) => db.insert("b", { x: 2, y: [1, { z: "s" }] }));
  return { engine, id: id as string, ts };
}

test("a patch or replace with the document's own values commits nothing", async () => {
  const { engine, id, ts } = await setup();
  for (const body of [
    (db: Tx) => db.patch("b", id, { x: 2 }),
    (db: Tx) => db.patch("b", id, {}),
    (db: Tx) => db.patch(id, { y: [1, { z: "s" }] }),
    (db: Tx) => db.replace("b", id, { y: [1, { z: "s" }], x: 2 }),
  ]) {
    const r = await engine.mutationWithTs(body);
    expect(r.ts).toBe(ts);
  }
  expect((await engine.mutationWithTs((db) => db.patch("b", id, { x: 3 }))).ts).toBeGreaterThan(ts);
});

test("compared with the transaction's own version: back to the stored value after a change is a write", async () => {
  const { engine, id, ts } = await setup();
  const r = await engine.mutationWithTs(async (db) => {
    await db.patch("b", id, { x: 3 });
    await db.patch("b", id, { x: 2 });
  });
  expect(r.ts).toBeGreaterThan(ts);
  // After an insert in the same transaction, a patch with its values is not a second write; the insert stays.
  const { value: fresh } = await engine.mutationWithTs(async (db) => {
    const n = await db.insert("b", { x: 5 });
    await db.patch("b", n, { x: 5 });
    return n;
  });
  expect(await engine.query((db) => db.get("b", fresh as string))).toMatchObject({ x: 5 });
});

test("-0 is not 0, and an integer is not a float", async () => {
  const engine = await new Engine(
    defineSchema({ c: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const { value: id, ts } = await engine.mutationWithTs((db) => db.insert("c", { x: 0, n: 1 }));
  const a = await engine.mutationWithTs((db) => db.patch("c", id as string, { x: -0 }));
  expect(a.ts).toBeGreaterThan(ts);
  const b = await engine.mutationWithTs((db) => db.patch("c", id as string, { n: 1n }));
  expect(b.ts).toBeGreaterThan(a.ts);
});

test("a query that read the document is not invalidated by it", async () => {
  const { engine: e, id } = await setup();
  const r = await e.queryTracked((db) => db.get("b", id));
  await e.mutation((db) => db.patch("b", id, { x: 2 }));
  expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(false);
  await e.mutation((db) => db.patch("b", id, { x: 4 }));
  expect(e.committer.changedBetween(r.reads, r.ts, e.committer.visibleTs)).toBe(true);
});

test("a patch that changes a value is still checked against the schema", async () => {
  const { engine: e, id } = await setup();
  await e.mutation((db) => db.patch("b", id, { x: 2 }));
  await expect(e.mutation((db) => db.patch("b", id, { x: "two" as never }))).rejects.toThrow(
    /does not match the schema/,
  );
});

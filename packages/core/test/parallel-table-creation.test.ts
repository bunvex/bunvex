// Inserts that create tables, run at once in one mutation (`Promise.all`): Convex's syscalls run one at a time in
// the transaction, so the second insert into a new table sees the table the first created, and two new tables get
// different numbers. Before the fix each parallel insert created its own table, and all but one were lost.
import { afterEach, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

async function engine() {
  const e = await new Engine(
    defineSchema({ a: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  engines.push(e);
  return e;
}

const tablesNamed = (e: Engine, name: string) =>
  e.query(async (db) => db.asSystem(async () => (await db.query("_tables").collect()).filter((t) => t.name === name)));

test("parallel inserts into one new table create it once, and every document lands", async () => {
  const e = await engine();
  const ids = await e.mutation((db) => Promise.all([1, 2, 3].map((k) => db.insert("c", { k }))));
  const docs = await e.query((db) => db.query("c").collect());
  expect(docs.map((d) => d._id).sort()).toEqual([...ids].sort());
  expect(docs.map((d) => d.k).sort()).toEqual([1, 2, 3]);
  expect(await tablesNamed(e, "c")).toHaveLength(1);
});

test("parallel inserts into two new tables give them different numbers", async () => {
  const e = await engine();
  await e.mutation((db) => Promise.all([db.insert("x", { n: 1 }), db.insert("y", { n: 2 }), db.insert("x", { n: 3 })]));
  const [x] = await tablesNamed(e, "x");
  const [y] = await tablesNamed(e, "y");
  expect(await tablesNamed(e, "x")).toHaveLength(1);
  expect(x!.number).not.toBe(y!.number);
  expect((await e.query((db) => db.query("x").collect())).map((d) => d.n).sort()).toEqual([1, 3]);
  expect((await e.query((db) => db.query("y").collect())).map((d) => d.n)).toEqual([2]);
});

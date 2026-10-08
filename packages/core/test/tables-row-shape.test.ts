// `_tables` rows as Convex writes them (STUDY-134 group 1): `number` an int64, as Convex's
// `SerializedTableMetadata`. Each kind of row bunvex writes — a system table's, a schema table's, one a write
// created, an import's hidden table — is compared with a row of a Convex deployment's `_tables`.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { indexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

const schema = defineSchema({ things: defineTable(v.any()).index("by_s", ["s"]) });

test("every _tables row has Convex's shape: number an int64", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p).init();
  await e.indexesReady();
  // A table a write creates, and an import's hidden table.
  await e.mutation((db) => db.insert("made", { a: 1 }));
  await e.createHiddenTable("imported", {});
  const rows = (await e.query((db) => db.asSystem(() => db.query("_tables").collect()))) as Record<string, unknown>[];
  const convex = indexRows("_tables");
  const byName = new Map(rows.map((r) => [r.name as string, r]));
  for (const name of ["_index_backfills", "_modules", "things", "made", "imported"]) {
    const row = byName.get(name);
    expect(row).toBeDefined();
    // `tablet` is bunvex's table identity, which waits on the persistence layout (STUDY-133, DV-428).
    for (const c of convex) expect(shapeDiff(stored(row), c, ["tablet"])).toEqual([]);
  }
  expect(byName.get("things")!.number).toBe(10001n);
  await e.close();
});

test("the numbers read back are the catalog's, after a restart too", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p).init();
  await e.indexesReady();
  await e.mutation((db) => db.insert("made", { a: 1 }));
  const before = Object.fromEntries([...e.catalog.tables.values()].map((t) => [t.name, t.number]));
  await e.close();
  const again = await new Engine(schema, p).init();
  const after = Object.fromEntries([...again.catalog.tables.values()].map((t) => [t.name, t.number]));
  expect(after).toEqual(before);
  expect(after.things).toBe(10001);
  expect(after.made).toBe(10002);
  // A new table after the restart takes the next free number: the stored ones were read as numbers.
  await again.mutation((db) => db.insert("later", { a: 1 }));
  expect(again.catalog.table("later").number).toBe(10003);
  await again.close();
});

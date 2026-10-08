// An import's hidden table and its copied indexes, as Convex's `create_empty_table` (STUDY-134, DV-430): each
// ENABLED index of the table it replaces is copied as `Backfilling` (`copy_indexes_to_table`), the table is
// backfilled and the copies enabled before the import writes (`backfill_and_enable_indexes_on_table`); a table
// still backfilling an index cannot be replaced (`InvalidImport`).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { INDEX_BACKFILLS_TABLE, INDEX_TABLE } from "../src/catalog.ts";
import { Engine, ImportBackfillingError } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { indexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

type Row = Record<string, unknown>;
const identity: string[] = [];
const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const open = async (s = schema, opts = {}) => {
  const p = await MemoryPersistence.open(null, { durable: false });
  return { p, e: await new Engine(s, p, opts).init() };
};

/** Every revision of the `_index` row `name` of tablet `tablet`, oldest first, as stored. */
async function history(p: MemoryPersistence, e: Engine, tablet: string, name: string): Promise<Row[]> {
  const index = e.catalog.table(INDEX_TABLE).id;
  const out: Row[] = [];
  for (const r of p.readDocumentLog(0n, e.committer.visibleTs, 1e6)) {
    if (r.table !== index || r.deleted) continue;
    const json = JSON.parse((await p.get(index, r.id, r.ts))!.json) as Row;
    if (json.table_id === tablet && json.descriptor === name) out.push(json);
  }
  return out;
}
const state = (r: Row) => {
  const o = (r.config as Row).onDiskState as Row;
  return o.type === "Backfilling" ? `Backfilling(${(o.backfillState as Row).retentionStarted})` : o.type;
};

test("a copied index starts Backfilling and is enabled before the table is handed back, in Convex's rows", async () => {
  const { p, e } = await open();
  await e.mutation((db) => db.insert("items", { n: 1 }));
  const hidden = await e.createHiddenTable("items", { copyIndexesOf: "items" });
  // Returned with its copy enabled: the import writes into it and reads it at once.
  expect([...hidden.indexes.keys()].sort()).toEqual(["by_creation_time", "by_id", "by_n"]);
  expect(hidden.pending).toEqual([]);
  const revs = await history(p, e, hidden.id, "by_n");
  expect(revs.map(state)).toEqual(["Backfilling(false)", "Backfilling(true)", "Backfilled2", "Enabled"]);
  const convex = indexRows("_index").filter((r) => r.descriptor === "by_s_n");
  for (const [i, r] of revs.entries()) expect(shapeDiff(r, convex[i], identity)).toEqual([]);
  // Its backfill's row, as Convex's: the empty table counted.
  const rowId = (await e.query((db) => db.asSystem(() => db.query(INDEX_TABLE).collect()))).find(
    (r) => r.table_id === hidden.id && r.descriptor === "by_n",
  )!._id;
  const backfill = (await e.query((db) => db.asSystem(() => db.query(INDEX_BACKFILLS_TABLE).collect()))).find(
    (r) => r.indexId === rowId,
  );
  expect(shapeDiff(stored(backfill), indexRows("_index_backfills")[1])).toEqual([]);
  expect(backfill!.totalDocs).toBe(0n);
  // The import's writes, then the activation: the copy serves queries.
  await e.mutation((db) => db.asSystem(() => db.importInsert(hidden, { n: 7 })));
  await e.activateTables([hidden.id]);
  const found = await e.query((db) =>
    db
      .query("items")
      .withIndex("by_n", (q) => q.eq("n", 7))
      .collect(),
  );
  expect(found).toHaveLength(1);
  await e.close();
});

test("only enabled indexes are copied: a staged one is not", async () => {
  const staged = defineSchema({
    items: defineTable(v.any())
      .index("by_n", ["n"])
      .index("by_m", { fields: ["m"], staged: true }),
  });
  const { e } = await open(staged);
  await e.indexesReady();
  const hidden = await e.createHiddenTable("items", { copyIndexesOf: "items" });
  expect([...hidden.indexes.keys()].sort()).toEqual(["by_creation_time", "by_id", "by_n"]);
  await e.close();
});

test("a table still backfilling an index cannot be replaced: Convex's InvalidImport", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const plain = defineSchema({ items: defineTable(v.any()) });
  let e = await new Engine(plain, p).init();
  await e.mutation(async (db) => {
    for (let i = 0; i < 2000; i++) await db.insert("items", { n: i });
  });
  await e.close();
  // 100 entries a second: the backfill outlasts the attempt.
  e = await new Engine(schema, p, { indexBackfill: { chunkSize: 10, chunkRate: 10 } }).init();
  const attempt = e.createHiddenTable("items", { copyIndexesOf: "items" });
  await expect(attempt).rejects.toBeInstanceOf(ImportBackfillingError);
  await expect(attempt).rejects.toMatchObject({
    code: "InvalidImport",
    message: "items is still backfilling indexes, so it cannot be replaced. Wait for indexes to complete backfilling",
  });
  // Nothing was created.
  expect(e.catalog.hidden.size).toBe(0);
  await e.close();
});

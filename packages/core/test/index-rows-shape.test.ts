// `_index` rows of database indexes and `_index_backfills` rows as Convex writes them (STUDY-134 group 2):
// `config: {type: "database", fields, onDiskState, persistenceIndexId}`, `by_id`'s fields empty, a user index
// backfilled even on a new table (`Backfilling` → retention started → `Backfilled2` → `Enabled`), and its
// backfill's row kept, in int64s. Each revision is compared with the same revision of a Convex deployment's
// rows (the fixture `convex-rows/_index.json`: the push of one table with an index and a search index).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { INDEX_BACKFILLS_TABLE, INDEX_TABLE, indexMeta } from "../src/catalog.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { indexRows, shapeDiff, stored } from "./convex-rows/shape.ts";

const schema = defineSchema({
  things: defineTable(v.any())
    .index("by_s_n", ["s", "n"])
    .searchIndex("search_s", { searchField: "s", filterFields: ["b"] }),
});
// bunvex's identity fields and Convex's (STUDY-133, DV-428).
const identity: string[] = [];

function blobs(): SearchSegmentStore {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    put: async (d) => {
      const key = `k${++n}`;
      map.set(key, d);
      return key;
    },
    get: async (k) => map.get(k) ?? null,
    delete: async (k) => {
      map.delete(k);
    },
  };
}

type Row = Record<string, unknown>;
const system = <T>(e: Engine, table: string) =>
  e.query((db) => db.asSystem(() => db.query(table).collect())) as Promise<T>;

/** Every revision of the `_index` row named `name` of table `things`, oldest first, as stored. */
async function history(p: MemoryPersistence, e: Engine, name: string): Promise<Row[]> {
  const tablet = e.catalog.table("things").id;
  const index = e.catalog.table(INDEX_TABLE).id;
  const out: Row[] = [];
  for (const r of p.readDocumentLog(0n, e.committer.visibleTs, 1e6)) {
    if (r.table !== index || r.deleted) continue;
    const json = JSON.parse((await p.get(index, r.id, r.ts))!.json) as Row;
    if (json.table_id === tablet && json.descriptor === name) out.push(json);
  }
  return out;
}

test("a new table's index goes through Convex's states, each revision in Convex's shape", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p, { searchStorage: blobs() }).init();
  await e.searchReady();
  const convex = indexRows("_index");
  const convexOf = (d: string) => convex.filter((r) => r.descriptor === d);

  const byS = await history(p, e, "by_s_n");
  const states = byS.map((r) => {
    const o = (r.config as Row).onDiskState as Row;
    return o.type === "Backfilling" ? `Backfilling(${(o.backfillState as Row).retentionStarted})` : o.type;
  });
  expect(states).toEqual(["Backfilling(false)", "Backfilling(true)", "Backfilled2", "Enabled"]);
  const convexByS = convexOf("by_s_n");
  expect(convexByS).toHaveLength(4);
  for (const [i, r] of byS.entries()) expect(shapeDiff(r, convexByS[i], identity)).toEqual([]);
  expect((byS[0]!.config as Row).fields).toEqual(["s", "n", "_creationTime"]);
  // Convex's nanoseconds, as its fixture's.
  const lowerBound = (r: Row) =>
    ((((r.config as Row).onDiskState as Row).backfillState as Row).indexCreatedLowerBound as { $integer: string })
      .$integer;
  const ns = (b64: string) => Buffer.from(b64, "base64").readBigInt64LE();
  expect(ns(lowerBound(convexByS[0]!))).toBeGreaterThan(10n ** 18n);
  expect(ns(lowerBound(byS[0]!))).toBeGreaterThan(10n ** 18n);

  // The system indexes: enabled from the start; `by_id`'s fields empty.
  for (const name of ["by_id", "by_creation_time"]) {
    const revs = await history(p, e, name);
    expect(revs).toHaveLength(1);
    expect(shapeDiff(revs[0], convexOf(name)[0], identity)).toEqual([]);
  }
  expect(((await history(p, e, "by_id"))[0]!.config as Row).fields).toEqual([]);
  await e.close();
});

test("_index_backfills rows of a new table: the database index's with its cursor, the search index's without", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p, { searchStorage: blobs() }).init();
  await e.searchReady();
  const rows = await system<Row[]>(e, INDEX_BACKFILLS_TABLE);
  const indexRows = await system<Row[]>(e, INDEX_TABLE);
  const idOf = (name: string) =>
    indexRows.find((r) => r.descriptor === name && r.table_id === e.catalog.table("things").id)!._id;
  const db = rows.find((r) => r.indexId === idOf("by_s_n"));
  const search = rows.find((r) => r.indexId === idOf("search_s"));
  const [convexSearch, convexDb] = indexRows("_index_backfills");
  expect(shapeDiff(stored(db), convexDb)).toEqual([]);
  // The table summaries are still being built when the engine starts: the search index's total is unknown
  // (null, as Convex's while its summaries bootstrap); a push's has it (below).
  expect(shapeDiff(stored(search), convexSearch, ["totalDocs"])).toEqual([]);
  expect(db!.numDocsIndexed).toBe(0n);
  expect(db!.totalDocs).toBe(0n);
  expect((db!.cursor as Row).cursor).toBeNull();
  expect((db!.cursor as Row).snapshotTs).toBeGreaterThan(10n ** 18n); // nanoseconds, as Convex's
  expect(search!.cursor).toBeNull();
  await e.close();
});

test("a push's index on a table with documents: the rows, its backfill's count, read back after a restart", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const plain = defineSchema({ things: defineTable(v.any()) });
  let e = await new Engine(plain, p, { storedSchema: true, searchStorage: blobs() }).init();
  await e.mutation(async (db) => {
    for (let i = 0; i < 30; i++) await db.insert("things", { s: `s${i % 3}`, n: i });
  });
  await e.summariesReady();
  // A push (Convex's start_push / finish_push): the existing table's index is backfilled by the worker.
  const { schemaId } = await e.startSchemaPush(schema);
  for (let i = 0; (await e.schemaPushStatus(schemaId)).type !== "complete"; i++) {
    if (i > 500) throw new Error("the push did not complete");
    await Bun.sleep(10);
  }
  await e.commitSchemaPush(schemaId, async () => {});
  const t = e.catalog.table("things");
  // `by_id`'s key is the id, in memory as before.
  expect(t.byId.fields).toEqual(["_id"]);
  expect(t.indexes.get("by_s_n")!.fields).toEqual(["s", "n", "_creationTime"]);
  const rows = await e.query((db) =>
    db
      .query("things")
      .withIndex("by_s_n", (q) => q.eq("s", "s1"))
      .collect(),
  );
  expect(rows).toHaveLength(10);
  const revisions = await history(p, e, "by_s_n");
  expect(revisions.map((r) => ((r.config as Row).onDiskState as Row).type)).toEqual([
    "Backfilling",
    "Backfilling",
    "Backfilled2",
    "Enabled",
  ]);
  const meta = (await system<Row[]>(e, INDEX_TABLE)).filter((r) => r.descriptor === "by_s_n").map(indexMeta);
  expect(meta.map((m) => [m.state, m.indexId === t.indexes.get("by_s_n")!.id])).toEqual([["enabled", true]]);
  // The backfills' rows: the table's count from the summaries, the documents indexed, kept after the backfill.
  await e.searchReady();
  const backfills = await system<Row[]>(e, INDEX_BACKFILLS_TABLE);
  const progress = backfills.find((r) => r.indexId === meta[0]!._id)!;
  expect(progress.totalDocs).toBe(30n);
  expect(shapeDiff(stored(progress), indexRows("_index_backfills")[1])).toEqual([]);
  const searchId = (await system<Row[]>(e, INDEX_TABLE)).find((r) => r.descriptor === "search_s")!._id;
  const searchProgress = backfills.find((r) => r.indexId === searchId)!;
  expect([searchProgress.totalDocs, searchProgress.numDocsIndexed]).toEqual([30n, 30n]);
  expect(shapeDiff(stored(searchProgress), indexRows("_index_backfills")[0])).toEqual([]);
  await e.close();
  // A restart reads the rows back into the same catalog, with nothing left to backfill.
  e = await new Engine(plain, p, { storedSchema: true }).init();
  expect(e.indexWorker).toBeNull();
  expect(e.catalog.table("things").indexes.get("by_s_n")!.id).toBe(t.indexes.get("by_s_n")!.id);
  await e.close();
});

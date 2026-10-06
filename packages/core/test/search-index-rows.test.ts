// Search and vector indexes' `_index` rows (STUDY-111 PR 6), as Convex's: one per index of the schema (staged
// ones included), `config` in Convex's serialized `IndexConfig::Text` / `IndexConfig::Vector` shape, its
// `onDiskState` following the index from backfilling to snapshotted with the segment list; gone with the index.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

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

const full = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind", "author"] })
    .searchIndex("search_title", { searchField: "title", staged: true })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2, filterFields: ["kind"] })
    .index("by_kind", ["kind"]),
});

/** The search and vector rows of `_index`, by name, without their ids. */
async function rows(e: Engine) {
  const all = (await e.query((db) =>
    db.asSystem(() =>
      (db as unknown as { query(t: string): { collect(): Promise<unknown[]> } }).query("_index").collect(),
    ),
  )) as Record<string, unknown>[];
  const out: Record<string, Record<string, unknown>> = {};
  const isDatabase = (r: Record<string, unknown>) => (r.config as { type: string }).type === "database";
  for (const r of all) if (!isDatabase(r)) out[r.name as string] = r.config as Record<string, unknown>;
  return { search: out, database: all.filter(isDatabase).length };
}

test("one row per search and vector index, in Convex's shape, from backfilling to snapshotted", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(full, p, { searchStorage: blobs() }).init();
  await e.searchReady();
  await Bun.sleep(10);
  // A staged index is built too, then kept Convex's `Backfilled2 { snapshot, staged }`.
  expect(((await rows(e)).search.search_title!.onDiskState as { state: string }).state).toBe("backfilled2");
  await e.mutation((db) => db.insert("notes", { body: "hello", kind: "a", author: "x", title: "t", v: [1, 0] }));
  await e.close();
  const e2 = await new Engine(full, p, { searchStorage: blobs() }).init();
  await e2.searchReady();
  const { search, database } = await rows(e2);
  expect(Object.keys(search).sort()).toEqual(["by_v", "search_body", "search_title"]);
  // The text index: Convex's `Search` config, its filter fields a sorted set, snapshotted with its segments.
  const body = search.search_body!;
  expect(body.type).toBe("search");
  expect(body.searchField).toBe("body");
  expect(body.filterFields).toEqual(["author", "kind"]);
  const state = body.onDiskState as Record<string, unknown>;
  expect(state.state).toBe("snapshotted");
  expect(state.version).toBe(2);
  expect(typeof state.ts).toBe("number");
  const data = state.data as { data_type: string; segments: Record<string, unknown>[] };
  expect(data.data_type).toBe("MultiSegment");
  expect(Object.keys(data.segments[0]!).sort()).toEqual([
    "alive_bitset_key",
    "deleted_terms_table_key",
    "id",
    "id_tracker_key",
    "num_deleted_documents",
    "num_indexed_documents",
    "segment_key",
    "size_bytes_total",
  ]);
  expect(data.segments[0]!.num_indexed_documents).toBe(1);
  // The vector index: Convex's `Vector` config.
  const vec = search.by_v!;
  expect([vec.type, vec.vectorField, vec.dimensions, vec.filterFields]).toEqual(["vector", "v", 2, ["kind"]]);
  const vstate = vec.onDiskState as { state: string; data: { segments: Record<string, unknown>[] } };
  expect(vstate.state).toBe("snapshotted");
  expect(Object.keys(vstate.data.segments[0]!).sort()).toEqual([
    "deleted_bitset_key",
    "id",
    "id_tracker_key",
    "num_deleted",
    "num_vectors",
    "segment_key",
  ]);
  const staged = search.search_title!.onDiskState as { state: string; staged: boolean; snapshot: { version: number } };
  expect([staged.state, staged.staged, staged.snapshot.version]).toEqual(["backfilled2", true, 2]);
  // The database indexes' rows are as before: by_id, by_creation_time and by_kind for `notes`, and the rest.
  expect(database).toBeGreaterThan(3);
  await e2.close();

  // An index the schema drops loses its row; a new one gets a row, backfilling, then snapshotted.
  const changed = defineSchema({
    notes: defineTable(v.any())
      .searchIndex("search_other", { searchField: "other" })
      .vectorIndex("by_v", { vectorField: "v", dimensions: 2, filterFields: ["kind"] }),
  });
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const e3 = await new Engine(changed, p, { searchStorage: blobs(), beforeSearchBackfillPage: () => held }).init();
  await Bun.sleep(20);
  const during = await rows(e3);
  expect(Object.keys(during.search).sort()).toEqual(["by_v", "search_other"]);
  expect(during.search.search_other!.onDiskState).toEqual({ state: "backfilling", staged: false });
  release();
  await e3.searchReady();
  expect(((await rows(e3)).search.search_other!.onDiskState as { state: string }).state).toBe("snapshotted");
  await e3.close();
});

test("without a segment store the rows are kept: snapshotted, with no segments", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(full, p).init();
  await e.searchReady();
  await Bun.sleep(10);
  const { search } = await rows(e);
  expect(Object.keys(search).sort()).toEqual(["by_v", "search_body", "search_title"]);
  expect(search.search_body!.onDiskState).toEqual({
    state: "snapshotted",
    data: { data_type: "MultiSegment", segments: [] },
    ts: 0,
    version: 2,
  });
  await e.close();
});

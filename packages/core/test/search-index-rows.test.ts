// Search and vector indexes' `_index` rows (STUDY-111 PR 6, STUDY-133 PR 9), as Convex's: one per index of the
// schema (staged ones included), `config` in Convex's serialized `IndexConfig::Text` / `IndexConfig::Vector` shape
// with every integer an Int64, its `onDiskState` always `backfilling` (Convex cannot read bunvex's segments: the
// Convex binary builds the index itself, Q5); bunvex's state, from backfilling to snapshotted with the segment
// list, is in the `search_index_segments` global; gone with the index.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { readSearchIndexStates } from "../src/engine.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import type { TabletId } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import {
  indexRow,
  type IndexRowWrite,
  type IndexSegmentsState,
  readSavedStates,
  SEGMENTS_GLOBAL,
  type SearchIndexRow,
  SearchSegmentsState,
  stateKey,
  stateToRow,
} from "../src/search-segments.ts";

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
  for (const r of all) if (!isDatabase(r)) out[r.descriptor as string] = r.config as Record<string, unknown>;
  return { search: out, database: all.filter(isDatabase).length };
}

/** No JSON number anywhere: Convex reads its integers as Int64 and refuses a float64 (STUDY-133 §12 M5). */
function numbersIn(x: unknown, path = "config"): string[] {
  if (typeof x === "number") return [path];
  if (x && typeof x === "object" && !(x instanceof ArrayBuffer))
    return Object.entries(x).flatMap(([k, v]) => numbersIn(v, `${path}.${k}`));
  return [];
}

/** bunvex's states (the global), as full rows by index name. */
async function states(p: MemoryPersistence) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of (await readSearchIndexStates(p)).indexes) out[s.name] = stateToRow(s).config;
  return out;
}

test("one row per search and vector index, in Convex's shape, backfilling; the state in the global", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(full, p, { searchStorage: blobs() }).init();
  await e.searchReady();
  await Bun.sleep(10);
  // A staged index is built too, then kept Convex's `Backfilled2 { snapshot, staged }` (in the global).
  expect(((await states(p)).search_title!.onDiskState as { state: string }).state).toBe("backfilled2");
  await e.mutation((db) => db.insert("notes", { body: "hello", kind: "a", author: "x", title: "t", v: [1, 0] }));
  await e.close();
  const e2 = await new Engine(full, p, { searchStorage: blobs() }).init();
  await e2.searchReady();
  const { search, database } = await rows(e2);
  expect(Object.keys(search).sort()).toEqual(["by_v", "search_body", "search_title"]);
  // The rows: Convex's configs, `backfilling` (staged kept), every integer an Int64.
  const body = search.search_body!;
  expect([body.type, body.searchField, body.filterFields]).toEqual(["search", "body", ["author", "kind"]]);
  expect(body.onDiskState).toEqual({ state: "backfilling", staged: false });
  expect(search.search_title!.onDiskState).toEqual({ state: "backfilling", staged: true });
  const vec = search.by_v!;
  expect([vec.type, vec.vectorField, vec.dimensions, vec.filterFields]).toEqual(["vector", "v", 2n, ["kind"]]);
  expect(vec.onDiskState).toEqual({
    state: "backfilling",
    segments: [],
    table_scan_cursor: null,
    last_segment_ts: null,
    staged: false,
  });
  for (const c of Object.values(search)) expect(numbersIn(c)).toEqual([]);
  // The states: the text index snapshotted with its segments, Convex's segment fields.
  const st = await states(p);
  const state = st.search_body!.onDiskState as Record<string, unknown>;
  expect(state.state).toBe("snapshotted");
  expect(state.version).toBe(2);
  expect(typeof state.ts).toBe("bigint");
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
  const vstate = st.by_v!.onDiskState as { state: string; data: { segments: Record<string, unknown>[] } };
  expect(vstate.state).toBe("snapshotted");
  expect(Object.keys(vstate.data.segments[0]!).sort()).toEqual([
    "deleted_bitset_key",
    "id",
    "id_tracker_key",
    "num_deleted",
    "num_vectors",
    "segment_key",
  ]);
  const staged = st.search_title!.onDiskState as { state: string; staged: boolean; snapshot: { version: number } };
  expect([staged.state, staged.staged, staged.snapshot.version]).toEqual(["backfilled2", true, 2]);
  // The database indexes' rows are as before: by_id, by_creation_time and by_kind for `notes`, and the rest.
  expect(database).toBeGreaterThan(3);
  await e2.close();

  // An index the schema drops loses its row and its state; a new one gets a row, backfilling, and a state.
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
  expect((await rows(e3)).search.search_other!.onDiskState).toEqual({ state: "backfilling", staged: false });
  expect(Object.keys(await states(p)).sort()).toEqual(["by_v", "search_other"]);
  expect(((await states(p)).search_other!.onDiskState as { state: string }).state).toBe("snapshotted");
  await e3.close();
});

test("without a segment store the rows are kept: backfilling, in Convex's shape", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(full, p).init();
  await e.searchReady();
  await Bun.sleep(10);
  const { search } = await rows(e);
  expect(Object.keys(search).sort()).toEqual(["by_v", "search_body", "search_title"]);
  expect(search.search_body!.onDiskState).toEqual({ state: "backfilling", staged: false });
  await e.close();
});

describe("the states a start restores (STUDY-133 PR 9)", () => {
  const text: IndexSegmentsState = {
    kind: "text",
    tablet: "tab" as TabletId,
    name: "search_body",
    def: { searchField: "body", filterFields: [] } as never,
    ts: 5n,
    segments: [{ segment: "s1", deletes: "d1", docs: 3, deleted: 0, bytes: 10, id: "u1" }],
    staged: false,
  };
  const key = stateKey("text", text.tablet, text.name);
  const withId = (row: SearchIndexRow) => ({ ...row, _id: "row1" }) as Record<string, unknown>;
  const fresh = () => {
    const writes: IndexRowWrite[][] = [];
    const globals = new Map<string, unknown>();
    const store = {
      getGlobal: (k: string) => globals.get(k) ?? null,
      setGlobal: (k: string, v: unknown) => globals.set(k, v),
    };
    const state = new SearchSegmentsState(store as never, null, async (w) => {
      writes.push(w);
      return w.filter((x) => !x._id).map((_, i) => `new${i}`);
    });
    return { state, writes, globals };
  };

  test("a store from before the global: the rows' states are kept, then each row is rewritten as Convex's", async () => {
    const { state, writes, globals } = fresh();
    state.load([withId(stateToRow(text))], null);
    expect(state.get("text", text.tablet, text.name)).toEqual(text);
    await state.rewriteRows();
    expect(writes).toEqual([[{ _id: "row1", row: indexRow(text) }]]);
    const saved = readSavedStates(globals.get(SEGMENTS_GLOBAL));
    expect(saved?.get(key)).toEqual({ rowId: "row1", state: text });
    // Nothing changed: nothing written again.
    await state.rewriteRows();
    expect(writes).toHaveLength(1);
  });

  test("a saved state is used only with the row bunvex wrote for it", () => {
    const saved = new Map([[key, { rowId: "row1", state: text }]]);
    const own = fresh();
    own.state.load([withId(indexRow(text))], saved);
    expect(own.state.get("text", text.tablet, text.name)).toEqual(text);
    // Convex built it since (its own snapshot): not bunvex's state any more, the index is built again.
    const rebuilt = fresh();
    rebuilt.state.load([withId({ ...indexRow(text), config: { ...stateToRow(text).config } })], saved);
    expect(rebuilt.state.get("text", text.tablet, text.name)).toBeUndefined();
    // Another row (the index was dropped and created again): not its state either.
    const other = fresh();
    other.state.load([{ ...indexRow(text), _id: "row2" } as Record<string, unknown>], saved);
    expect(other.state.get("text", text.tablet, text.name)).toBeUndefined();
  });
});

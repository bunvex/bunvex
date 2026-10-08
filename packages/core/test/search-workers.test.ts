// The search index workers' periodic part (STUDY-111 PR 7), as Convex's: an idle index is fast-forwarded in
// `_index_worker_metadata`, so a start replays nothing older and document retention does not overtake it; a memory
// part older than the checkpoint age is flushed; no search blob is ever deleted (DV-370, as Convex).
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { readSearchIndexStates } from "../src/engine.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { internalIdOf } from "../src/internal-id.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { tsGlobal } from "../src/persistence-globals.ts";

const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body" })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
  logs: defineTable(v.any()),
});

function blobs(): SearchSegmentStore & { map: Map<string, { data: Uint8Array; at: number }> } {
  const map = new Map<string, { data: Uint8Array; at: number }>();
  let n = 0;
  return {
    map,
    put: async (d) => {
      const key = `k${++n}`;
      map.set(key, { data: d, at: Date.now() });
      return key;
    },
    get: async (k) => map.get(k)?.data ?? null,
    delete: async (k) => {
      map.delete(k);
    },
  };
}

/** Manual ticks: no timer, no debounce. */
const MANUAL = { pollIntervalMs: 2 ** 30, minCommits: 0, maxCheckpointAgeMs: 3_600_000 };
const NEVER = { textSoftLimitBytes: 2 ** 40, vectorSoftLimitBytes: 2 ** 40 };

async function open(p: MemoryPersistence, store: SearchSegmentStore, workers = MANUAL) {
  const e = await new Engine(schema, p, {
    searchStorage: store,
    searchSegmentLimits: NEVER,
    searchWorkers: workers,
  }).init();
  await e.searchReady();
  return e;
}

async function crash(e: Engine) {
  e.committer.fail(new Error("simulated crash"));
  await e.close().catch(() => {});
}

const hello = async (e: Engine) =>
  (
    await e.query((db) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", "hello"))
        .collect(),
    )
  ).length;

/** The `_index_worker_metadata` rows: each index's fast-forward ts, by metadata type. */
async function forwarded(e: Engine) {
  const rows = (await e.query((db) =>
    db.asSystem(() =>
      (db as unknown as { query(t: string): { collect(): Promise<unknown[]> } })
        .query("_index_worker_metadata")
        .collect(),
    ),
  )) as { index_id: string; index_metadata: { metadata_type: string; metadata: { fast_forward_ts: bigint } } }[];
  return Object.fromEntries(
    rows.map((r) => [r.index_metadata.metadata_type, r.index_metadata.metadata.fast_forward_ts]),
  );
}

test("an idle index is fast-forwarded; a start replays nothing older and retention does not overtake it", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e1 = await open(p, store);
  await e1.mutation((db) => db.insert("notes", { body: "hello", v: [1, 0] }));
  // While the indexes hold the write in memory, they are not idle.
  await e1.searchWorkersTick();
  expect(e1.searchStats.fastForwards).toBe(0);
  await e1.close(); // flushed: each state is current at the newest commit (bunvex's state is a global, no commit)

  const e2 = await open(p, store);
  expect(await forwarded(e2)).toEqual({}); // nothing newer to fast-forward to
  const rowsTs = (await readSearchIndexStates(p)).indexes.map((s) => s.ts).reduce((a, b) => (b > a ? b : a));
  expect(rowsTs).toBeLessThanOrEqual(e2.committer.visibleTs);
  // Writes to another table move the clock on; the idle indexes follow it.
  for (let i = 0; i < 3; i++) await e2.mutation((db) => db.insert("logs", { i }));
  await e2.searchWorkersTick();
  expect(e2.searchStats.fastForwards).toBe(2);
  const second = await forwarded(e2);
  expect(Object.keys(second).sort()).toEqual(["text_search", "vector_search"]);
  expect(second.text_search).toBeGreaterThan(rowsTs);
  await crash(e2);

  // Keyed by the `_index` row's internal id, as Convex's `InternalId` string (STUDY-133 §12 M7), and the rows
  // a start loaded are patched, not duplicated.
  const again = await open(p, store);
  await again.mutation((db) => db.insert("logs", { i: 3 }));
  await again.searchWorkersTick();
  const rows = (await again.query((db) =>
    db.asSystem(async () => ({
      workers: await (db as any).query("_index_worker_metadata").collect(),
      indexes: await (db as any).query("_index").collect(),
    })),
  )) as { workers: { index_id: string }[]; indexes: { _id: string }[] };
  expect(rows.workers).toHaveLength(2);
  const internal = new Set(rows.indexes.map((r) => internalIdOf(r._id)));
  for (const w of rows.workers) {
    expect(w.index_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(internal.has(w.index_id)).toBe(true);
  }
  await crash(again);

  // Retention past the segments' ts but not the fast-forward's: the segments are used, nothing replayed.
  await p.setGlobal("document_min_snapshot_ts", tsGlobal(second.text_search!));
  const e3 = await open(p, store);
  expect([e3.searchStats.fromSegments, e3.searchStats.replayed]).toEqual([2, 0]);
  expect(await hello(e3)).toBe(1);
  await e3.close();
});

test("a memory part older than the checkpoint age is flushed", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await open(p, store, { ...MANUAL, maxCheckpointAgeMs: 0 });
  await e.mutation((db) => db.insert("notes", { body: "hello", v: [1, 0] }));
  const before = e.searchStats.flushes;
  await e.searchWorkersTick();
  await e.searchFlushed();
  expect(e.searchStats.flushes).toBe(before + 2);
  for (const x of e.searchIndexes.all()) expect(x.index.changed.size).toBe(0);
  await e.close();
});

test("no search blob is deleted, as Convex: not an unnamed one a crash left, nor a replaced one", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e1 = await open(p, store);
  await e1.mutation((db) => db.insert("notes", { body: "hello", v: [1, 0] }));
  await e1.close();
  store.map.set("orphan", { data: new Uint8Array(8), at: Date.now() - 3_600_000 });
  const before = new Set(store.map.keys());
  const e2 = await open(p, store);
  await e2.mutation(async (db) => db.patch((await db.query("notes").first())!._id, { body: "hello again" }));
  await e2.close(); // a flush that replaces deletes blobs
  for (const k of before) expect(store.map.has(k)).toBe(true);
  const e3 = await open(p, store);
  expect(await hello(e3)).toBe(1);
  await e3.close();
});

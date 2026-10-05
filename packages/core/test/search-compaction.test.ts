// The compactor of search and vector segments (STUDY-111 PR 5), as Convex's: which segments it merges
// (`find_segments_to_compact`), and merging while flushes land — their deletes carried into the merged segment
// and stored with it — with the answers of indexing the table, before and after a crash.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { readSearchIndexStates } from "../src/engine.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type SearchCompactionConfig, segmentsToCompact } from "../src/search-segments.ts";

const CONFIG: SearchCompactionConfig = {
  smallSegmentBytes: 100,
  minSegments: 3,
  maxSegments: 10,
  maxSegmentBytes: 1000,
  maxDeletedFraction: 0.2,
};
const seg = (size: number, docs = 10, deleted = 0) => ({ size, docs, deleted });

test("which segments are merged: Convex's rules", () => {
  // Fewer than three small segments: nothing.
  expect(segmentsToCompact([seg(10), seg(20)], CONFIG)).toBeNull();
  // Three or more small ones: the smallest first.
  expect(segmentsToCompact([seg(30), seg(10), seg(20), seg(500)], CONFIG)!.sort()).toEqual([0, 1, 2]);
  // At most ten.
  expect(
    segmentsToCompact(
      Array.from({ length: 14 }, () => seg(5)),
      CONFIG,
    ),
  ).toHaveLength(10);
  // Large ones only when three of them fit in the maximum size.
  expect(segmentsToCompact([seg(400), seg(400), seg(400)], CONFIG)).toBeNull();
  expect(segmentsToCompact([seg(300), seg(300), seg(300), seg(600)], CONFIG)!.sort()).toEqual([0, 1, 2]);
  // A large segment more than 20 % deleted is rewritten alone; a small one waits to be merged.
  expect(segmentsToCompact([seg(500, 10, 3), seg(500, 10, 1)], CONFIG)).toEqual([0]);
  expect(segmentsToCompact([seg(500, 10, 2)], CONFIG)).toBeNull();
  expect(segmentsToCompact([seg(50, 10, 9)], CONFIG)).toBeNull();
  // Random among the candidates, as Convex's shuffle.
  const reversed = segmentsToCompact(
    Array.from({ length: 12 }, (_, i) => seg(i + 1)),
    CONFIG,
    (xs) => xs.reverse(),
  );
  expect(reversed).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
});

const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
});

function blobs(): SearchSegmentStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    map,
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

/** A flush at every commit. */
const EVERY = {
  textSoftLimitBytes: 1,
  vectorSoftLimitBytes: 1,
  textHardLimitBytes: 2 ** 40,
  vectorHardLimitBytes: 2 ** 40,
};
const note = (i: number) => ({ body: `note ${i} ${i % 3 ? "hello" : "world"}`, kind: `k${i % 2}`, v: [i % 5, 1] });

async function answers(e: Engine) {
  const text: Record<string, unknown[]> = {};
  for (const word of ["hello", "world", "note", "changed", "1"])
    text[word] = (
      await e.query((db) =>
        db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", word))
          .collect(),
      )
    ).map((d) => d._id);
  return { text, vector: e.vectorSearch("notes", "by_v", { vector: [1, 0.5], limit: 256 }) };
}

async function scanned(p: MemoryPersistence) {
  const e = await new Engine(schema, p).init();
  await e.searchReady();
  const a = await answers(e);
  await e.close();
  return a;
}

type State = { indexes: { kind: string; segments: { segment: string; deletes: string | null }[] }[] };

test("one segment per commit: the compactor keeps their number down; every named blob is stored, none deleted", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await new Engine(schema, p, { searchStorage: store, searchSegmentLimits: EVERY }).init();
  await e.searchReady();
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push((await e.mutation((db) => db.insert("notes", note(i)))) as string);
    if (i % 5 === 4) await e.mutation((db) => db.patch(ids[i - 2] as never, { body: `changed ${i}` }));
    await e.searchCompacted();
  }
  expect(e.searchStats.compactions).toBeGreaterThan(5);
  const state = (await readSearchIndexStates(p)) as State;
  for (const s of state.indexes) expect(s.segments.length).toBeLessThan(5);
  const named = new Set(state.indexes.flatMap((s) => s.segments.flatMap((r) => [r.segment, r.deletes])));
  // Every blob the state names is stored; the compacted ones stay too (no search blob is deleted, DV-370).
  for (const k of named) if (k !== null) expect(store.map.has(k)).toBe(true);
  expect(store.map.size).toBeGreaterThan(named.size);
  const got = await answers(e);
  await e.close();
  expect(got).toEqual(await scanned(p));
  const back = await new Engine(schema, p, { searchStorage: store }).init();
  await back.searchReady();
  expect(await answers(back)).toEqual(got);
  await back.close();
});

test("a compaction while flushes land: their deletes are carried into the merged segment and stored with it", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  let e!: Engine;
  let release!: () => void;
  let held = false;
  let calls = 0;
  let stopLater!: () => void;
  const later = new Promise<void>((r) => {
    stopLater = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const ids: string[] = [];
  e = new Engine(schema, p, {
    searchStorage: store,
    searchSegmentLimits: EVERY,
    // The first compaction waits between its build and its commit; later ones never commit (so what the crash
    // below finds stored is the first one's work).
    beforeSearchCompactionCommit: () => {
      if (calls++ >= 2) return later; // the text and the vector index's first
      held = true;
      return hold;
    },
  });
  await e.init();
  await e.searchReady();
  for (let i = 0; i < 3; i++) {
    ids.push((await e.mutation((db) => db.insert("notes", note(i)))) as string);
    await e.searchFlushed();
  }
  // Three segments: a compaction starts and waits. Meanwhile documents in them change and are deleted, and
  // flushes store those deletes in the segments being merged.
  for (let i = 0; i < 3; i++) {
    await e.mutation(async (db) => {
      await db.patch(ids[0] as never, { body: `changed ${i}`, v: [0.3, i] });
      if (i === 1) await db.delete(ids[1] as never);
      ids.push((await db.insert("notes", note(10 + i))) as string);
    });
    await e.searchFlushed();
  }
  expect(held).toBe(true);
  release();
  while (e.searchStats.compactions < 2) await Bun.sleep(5); // the text index's and the vector index's
  await e.searchFlushed();
  const got = await answers(e);
  expect(got).toEqual(await scanned(p));
  // A crash: what is stored (the merged segments, their carried deletes) answers the same.
  e.committer.fail(new Error("simulated crash"));
  stopLater();
  await e.close().catch(() => {});
  const back = await new Engine(schema, p, { searchStorage: store, searchSegmentLimits: EVERY }).init();
  await back.searchReady();
  expect(back.searchStats.replayed).toBe(0);
  expect(await answers(back)).toEqual(got);
  await back.close();
});

test("a large segment more than 20 % deleted is rewritten; one with nothing left is dropped", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await new Engine(schema, p, {
    searchStorage: store,
    // Every segment is large, and three never fit: only deletes compact.
    searchCompaction: { smallSegmentBytes: 0, maxSegmentBytes: 1 },
  }).init();
  await e.searchReady();
  const ids = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push((await db.insert("notes", note(i))) as string);
    return out;
  });
  await e.close(); // one segment per index
  const e2 = await new Engine(schema, p, {
    searchStorage: store,
    searchCompaction: { smallSegmentBytes: 0, maxSegmentBytes: 1 },
  }).init();
  await e2.searchReady();
  await e2.mutation(async (db) => {
    for (const id of ids.slice(0, 5)) await db.delete(id as never);
  });
  await e2.close(); // the deletes stored with the segment: 25 % deleted
  const e3 = await new Engine(schema, p, {
    searchStorage: store,
    searchCompaction: { smallSegmentBytes: 0, maxSegmentBytes: 1 },
  }).init();
  await e3.searchReady();
  await e3.searchCompacted();
  for (const x of [...e3.searchIndexes.all(), ...e3.vectorIndexes.all()]) {
    expect(x.index.segments).toHaveLength(1);
    expect([x.index.segments[0]!.segment.numDocs, x.index.segments[0]!.deletes.count]).toEqual([15, 0]);
  }
  // Every document deleted: the segments are dropped without being read.
  await e3.mutation(async (db) => {
    for (const id of ids.slice(5)) await db.delete(id as never);
  });
  await e3.close();
  const e4 = await new Engine(schema, p, { searchStorage: store }).init();
  await e4.searchReady();
  await e4.searchCompacted();
  for (const x of [...e4.searchIndexes.all(), ...e4.vectorIndexes.all()]) expect(x.index.segments).toHaveLength(0);
  // Their blobs stay (DV-370).
  expect(store.map.size).toBeGreaterThan(0);
  await e4.close();
});

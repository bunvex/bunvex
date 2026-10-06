// Segments read from disk (STUDY-111 PR 9): mapped from the store's own files, or from a local cache of a store
// that has none, with the same answers as segments held in memory, across flushes, compactions and restarts.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { readSearchIndexStates } from "../src/engine.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SegmentFiles } from "../src/search-segments.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-search-disk-"));
  dirs.push(d);
  return d;
};

const schema = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
});

/** Blobs in memory, as an S3 store: no local files. */
function memoryBlobs(): SearchSegmentStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    map,
    put: async (d) => {
      const key = `k${++n}`;
      map.set(key, d.slice());
      return key;
    },
    get: async (k) => map.get(k) ?? null,
    delete: async (k) => {
      map.delete(k);
    },
  };
}

/** Blobs as files in a directory, as the local store keeps them, with their paths. */
function fileBlobs(dir: string): SearchSegmentStore {
  mkdirSync(dir, { recursive: true });
  return {
    put: async (d) => {
      const key = crypto.randomUUID();
      await Bun.write(join(dir, key), d);
      return key;
    },
    get: async (k) => {
      const f = Bun.file(join(dir, k));
      return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    delete: async (k) => rmSync(join(dir, k), { force: true }),
    localPath: (k) => join(dir, k),
  };
}

/** Flush at every commit, compact with Convex's rules. */
const EVERY = { textSoftLimitBytes: 1, vectorSoftLimitBytes: 1 };
const note = (i: number) => ({ body: `note ${i} ${i % 3 ? "hello" : "world"}`, kind: `k${i % 2}`, v: [i % 5, 1] });

async function answers(e: Engine) {
  const text: Record<string, unknown[]> = {};
  for (const word of ["hello", "world", "note", "changed"])
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

async function workload(e: Engine) {
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    ids.push((await e.mutation((db) => db.insert("notes", note(i)))) as string);
    if (i % 4 === 3) await e.mutation((db) => db.patch(ids[i - 2] as never, { body: `changed ${i}` }));
    if (i % 7 === 6) await e.mutation((db) => db.delete(ids[i - 5] as never));
    await e.searchCompacted();
  }
}

test("segments mapped from the store's files: the answers of segments in memory, after a restart too", async () => {
  const dir = tmp();
  const store = fileBlobs(join(dir, "blobs"));
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p, { searchStorage: store, searchSegmentLimits: EVERY }).init();
  await e.searchReady();
  await workload(e);
  expect(e.searchSegmentsMapped).toBeGreaterThan(10);
  expect(e.searchStats.compactions).toBeGreaterThan(0);
  const got = await answers(e);
  await e.close();
  // The same store read into memory (no local paths), and indexing the table: the same answers.
  const inMemory = await new Engine(schema, p, { searchStorage: { ...store, localPath: undefined } }).init();
  await inMemory.searchReady();
  expect(inMemory.searchSegmentsMapped).toBe(0);
  expect(await answers(inMemory)).toEqual(got);
  await inMemory.close();
  const back = await new Engine(schema, p, { searchStorage: store }).init();
  await back.searchReady();
  expect(back.searchStats.fromSegments).toBe(2);
  expect(back.searchSegmentsMapped).toBeGreaterThan(0);
  expect(await answers(back)).toEqual(got);
  await back.close();
  const scanned = await new Engine(schema, p).init();
  await scanned.searchReady();
  expect(await answers(scanned)).toEqual(got);
  await scanned.close();
});

/** The segment blobs the `_index` rows name. */
async function namedSegments(p: MemoryPersistence) {
  return (await readSearchIndexStates(p)).indexes.flatMap((s) => s.segments.map((r) => r.segment)).sort();
}

test("a store with no local files: segments cached as files and mapped from there, the cache holding those in use", async () => {
  const cache = join(tmp(), "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "left-by-a-previous-process"), "x");
  const store = memoryBlobs();
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p, {
    searchStorage: store,
    searchSegmentLimits: EVERY,
    searchCacheDir: cache,
  }).init();
  await e.searchReady();
  // The cache starts empty, as Convex's (a directory per process).
  expect(existsSync(join(cache, "left-by-a-previous-process"))).toBe(false);
  await workload(e);
  expect(e.searchStats.compactions).toBeGreaterThan(0);
  expect(e.searchSegmentsMapped).toBeGreaterThan(10);
  const got = await answers(e);
  await e.close();
  // The cache holds the segments the indexes name, and no replaced one; the store keeps every blob (DV-370).
  const named = await namedSegments(p);
  expect(named.length).toBeGreaterThan(0);
  expect(readdirSync(cache).sort()).toEqual(named);
  expect(store.map.size).toBeGreaterThan(named.length);
  // A start downloads them into the cache again and maps them: the same answers.
  const back = await new Engine(schema, p, { searchStorage: store, searchCacheDir: cache }).init();
  await back.searchReady();
  expect(back.searchStats.fromSegments).toBe(2);
  expect(back.searchSegmentsMapped).toBe(named.length);
  expect(readdirSync(cache).sort()).toEqual(named);
  expect(await answers(back)).toEqual(got);
  await back.close();
});

test("a mapped segment is a private mapping: writing to it never changes the stored blob", async () => {
  const dir = join(tmp(), "blobs");
  const store = fileBlobs(dir);
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(schema, p, { searchStorage: store, searchSegmentLimits: EVERY }).init();
  await e.searchReady();
  await e.mutation((db) => db.insert("notes", note(1)));
  await e.searchCompacted();
  await e.close();
  const [key] = await namedSegments(p);
  const before = readFileSync(join(dir, key!));
  const mapped = (await new SegmentFiles(store, null).map(key!))!;
  mapped.fill(0);
  expect(readFileSync(join(dir, key!)).equals(before)).toBe(true);
});

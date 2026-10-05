// Persisted search segments (STUDY-111 PR 3): the flusher writes a memory part over its soft limit as a segment;
// a start loads the segments and replays only the log since their ts, crash or not, with the answers of
// indexing the tables; a state it cannot trust is not used; a dropped index's blobs and replaced deletes are
// deleted.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, type SearchSnapshotStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { SEARCH_SEGMENTS_GLOBAL } from "../src/search-segments.ts";
import { fileBlobs } from "./fixtures/segments-blobs.ts";

const schemaWith = (filterFields: string[], vector = true) =>
  defineSchema({
    notes: vector
      ? defineTable(v.any())
          .searchIndex("search_body", { searchField: "body", filterFields })
          .vectorIndex("by_v", { vectorField: "v", dimensions: 2 })
      : defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields }),
  });
const schema = schemaWith(["kind"]);

function blobs(): SearchSnapshotStore & { map: Map<string, Uint8Array> } {
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

/** Flush at every commit (a soft limit of one byte), or never (a huge one). */
const EVERY = { textSoftLimitBytes: 1, vectorSoftLimitBytes: 1 };
const NEVER = { textSoftLimitBytes: 2 ** 40, vectorSoftLimitBytes: 2 ** 40 };

async function open(p: MemoryPersistence, store?: SearchSnapshotStore, limits = NEVER, s = schema) {
  const e = await new Engine(s, p, store ? { searchSnapshots: store, searchSegmentLimits: limits } : {}).init();
  await e.searchReady();
  return e;
}

/** A crash: the committer stops (as when the process dies), so the close writes nothing more. */
async function crash(e: Engine) {
  e.committer.fail(new Error("simulated crash"));
  await e.close().catch(() => {});
}

const note = (i: number) => ({ body: `note ${i} ${i % 3 ? "hello" : "world"}`, kind: `k${i % 2}`, v: [i % 5, 1] });

/** What searches answer: text hits for a few queries (with a filter), and vector neighbours. */
async function answers(e: Engine) {
  const text: Record<string, unknown[]> = {};
  for (const word of ["hello", "world", "note", "again", "1"])
    text[word] = (
      await e.query((db) =>
        db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", word))
          .collect(),
      )
    ).map((d) => d._id);
  text.filtered = (
    await e.query((db) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", "hello").eq("kind", "k1"))
        .collect(),
    )
  ).map((d) => d._id);
  const vector = e.vectorSearch("notes", "by_v", { vector: [1, 0.5], limit: 50 });
  return { text, vector };
}

test("over its soft limit a memory part is flushed; after a crash a start replays only the writes since", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e1 = await open(p, store, EVERY);
  const ids = await e1.mutation(async (db) => {
    const out = [];
    for (let i = 0; i < 20; i++) out.push(await db.insert("notes", note(i)));
    return out;
  });
  await e1.searchFlushed();
  expect(e1.searchStats.flushes).toBeGreaterThanOrEqual(2); // a text and a vector segment
  const state = (await p.getGlobal(SEARCH_SEGMENTS_GLOBAL)) as { indexes: { kind: string; ts: number }[] };
  expect(state.indexes.map((s) => s.kind).sort()).toEqual(["text", "vector"]);
  await crash(e1);

  // A run that writes without flushing (its limit is never reached), then crashes.
  const e2 = await open(p, store, NEVER);
  expect(e2.searchStats.fromSegments).toBe(2);
  await e2.mutation(async (db) => {
    await db.patch(ids[0] as never, { body: "world again", v: [0.9, 0.1] });
    await db.delete(ids[1] as never);
    await db.insert("notes", { body: "hello again", kind: "k1", v: [1, 0.1] });
  });
  const expected = await answers(e2);
  await crash(e2);

  const e3 = await open(p, store, NEVER);
  expect(e3.searchStats.fromSegments).toBe(2);
  // Only the three documents written since the flush, for each of the two indexes.
  expect(e3.searchStats.replayed).toBe(6);
  expect(await answers(e3)).toEqual(expected);
  await e3.close();

  // A clean shutdown flushed: the next start replays nothing.
  const e4 = await open(p, store, NEVER);
  expect([e4.searchStats.fromSegments, e4.searchStats.replayed]).toEqual([2, 0]);
  expect(await answers(e4)).toEqual(expected);
  await e4.close();
  // The same answers as indexing the tables.
  const scanned = await open(p);
  expect(scanned.searchStats.fromSegments).toBe(0);
  expect(await answers(scanned)).toEqual(expected);
  await scanned.close();
});

test("flushes with deletes: no blob is deleted (as Convex), the answers unchanged", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await open(p, store, EVERY);
  const ids = await e.mutation(async (db) => {
    const out = [];
    for (let i = 0; i < 10; i++) out.push(await db.insert("notes", note(i)));
    return out;
  });
  await e.searchFlushed();
  for (let i = 0; i < 4; i++) {
    await e.mutation((db) => db.patch(ids[i] as never, { body: `changed ${i} hello` }));
    await e.searchFlushed();
  }
  const expected = await answers(e);
  // Every blob the state names is stored, and the replaced deletes are kept too (DV-370: as Convex).
  const state = (await p.getGlobal(SEARCH_SEGMENTS_GLOBAL)) as {
    indexes: { segments: { segment: string; deletes: string | null }[] }[];
  };
  const named = new Set(state.indexes.flatMap((s) => s.segments.flatMap((r) => [r.segment, r.deletes])));
  for (const k of named) if (k !== null) expect(store.map.has(k)).toBe(true);
  expect(store.map.size).toBeGreaterThan(named.size);
  expect(state.indexes[0]!.segments.some((r) => r.deletes)).toBe(true);
  await e.close();
  const back = await open(p, store);
  expect(back.searchStats.fromSegments).toBe(2);
  expect(await answers(back)).toEqual(expected);
  await back.close();
});

test("a state not trusted is not used: changed definition, outside retention, missing or unreadable blob", async () => {
  const seeded = async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const store = blobs();
    const e = await open(p, store);
    await e.mutation(async (db) => {
      for (let i = 0; i < 5; i++) await db.insert("notes", note(i));
    });
    const expected = await answers(e);
    await e.close();
    return { p, store, expected };
  };

  // A changed definition: that index is indexed from its table; the other loads.
  const a = await seeded();
  const changed = await open(a.p, a.store, NEVER, schemaWith([]));
  expect(changed.searchStats.fromSegments).toBe(1);
  expect(
    (
      await changed.query((db) =>
        db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", "hello"))
          .collect(),
      )
    ).length,
  ).toBe(a.expected.text.hello!.length);
  await changed.close();

  const b = await seeded();
  await b.p.setGlobal("document_min_snapshot_ts", Number.MAX_SAFE_INTEGER);
  const old = await open(b.p, b.store);
  expect(old.searchStats.fromSegments).toBe(0);
  expect(await answers(old)).toEqual(b.expected);
  await old.close();

  const c = await seeded();
  c.store.map.clear();
  const missing = await open(c.p, c.store);
  expect(missing.searchStats.fromSegments).toBe(0);
  expect(await answers(missing)).toEqual(c.expected);
  await missing.close();

  const d = await seeded();
  for (const k of d.store.map.keys()) d.store.map.set(k, new Uint8Array(64));
  const unreadable = await open(d.p, d.store);
  expect(unreadable.searchStats.fromSegments).toBe(0);
  expect(await answers(unreadable)).toEqual(d.expected);
  await unreadable.close();

  // A store that never wrote a state.
  const fresh = await MemoryPersistence.open(null, { durable: false });
  const none = await open(fresh, a.store);
  expect(none.searchStats.fromSegments).toBe(0);
  await none.close();
});

test("a dropped index's state is removed; its blobs are kept, as Convex", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await open(p, store);
  await e.mutation((db) => db.insert("notes", note(1)));
  await e.close();
  // An index built from its table is ready once stored as a segment.
  const built = await open(p, undefined);
  await built.close();
  const rebuilt = await open(p, store, NEVER, schemaWith(["owner"]));
  const named = (await p.getGlobal(SEARCH_SEGMENTS_GLOBAL)) as { indexes: { def: { filterFields: string[] } }[] };
  expect(named.indexes.some((s) => s.def.filterFields?.[0] === "owner")).toBe(true);
  await rebuilt.close();
  const before = [...store.map.keys()];
  const textOnly = await open(p, store, NEVER, schemaWith(["kind"], false));
  await textOnly.close();
  const state = (await p.getGlobal(SEARCH_SEGMENTS_GLOBAL)) as { indexes: { kind: string }[] };
  expect(state.indexes.map((s) => s.kind)).toEqual(["text"]);
  for (const k of before) expect(store.map.has(k)).toBe(true);
});

test("a commit landing while a start replays the log is kept", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e1 = await open(p, store);
  const id = await e1.mutation((db) => db.insert("notes", { body: "first", kind: "k0", v: [1, 0] }));
  await e1.close();
  // A run that changes the document after the flush, then crashes: the next start replays it.
  const crashed = await open(p, store);
  await crashed.mutation((db) => db.patch(id as never, { body: "before" }));
  await crash(crashed);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const e2 = await new Engine(schema, p, {
    searchSnapshots: store,
    searchSegmentLimits: NEVER,
    beforeSearchBackfillPage: () => held,
  }).init();
  // Before the replay: its version of the document is older than this commit's.
  await e2.mutation((db) => db.patch(id as never, { body: "after" }));
  release();
  await e2.searchReady();
  expect(e2.searchStats.fromSegments).toBe(2);
  const hits = async (word: string) =>
    (
      await e2.query((db) =>
        db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", word))
          .collect(),
      )
    ).length;
  expect([await hits("first"), await hits("before"), await hits("after")]).toEqual([0, 0, 1]);
  await e2.close();
});

test("a process killed after a flush: the next start loads the segments and replays only the writes since", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-segments-"));
  try {
    const path = join(dir, "store.sqlite");
    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "fixtures/segments-child.ts"), path, join(dir, "blobs")],
      {
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (b) => {
        out += b;
        if (out.includes("written")) {
          child.kill("SIGKILL");
          resolve();
        }
      });
      child.on("exit", (code) => (code === null ? resolve() : reject(new Error(`child exited ${code}: ${out}`))));
    });
    await new Promise((r) => child.on("close", r));
    expect(readdirSync(join(dir, "blobs")).length).toBeGreaterThan(0);
    const e = await new Engine(schema, new SqlitePersistence(path, { durable: true }), {
      searchSnapshots: fileBlobs(join(dir, "blobs")),
    }).init();
    await e.searchReady();
    expect(e.searchStats.fromSegments).toBe(2);
    // The child wrote 30 documents after its flush (each index replays them), not the 200 before.
    expect(e.searchStats.replayed).toBe(60);
    const loaded = await answers(e);
    await e.close();
    const scanned = await new Engine(schema, new SqlitePersistence(path, { durable: true })).init();
    await scanned.searchReady();
    expect(await answers(scanned)).toEqual(loaded);
    expect(loaded.vector.length).toBe(50);
    await scanned.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a write while a ready index's memory part is at its hard limit is refused until a flush (DV-228)", async () => {
  const s = defineSchema({
    notes: defineTable(v.any())
      .searchIndex("search_body", { searchField: "body" })
      .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
    other: defineTable(v.any()),
  });
  const p = await MemoryPersistence.open(null, { durable: false });
  const limits = { ...NEVER, textHardLimitBytes: 1500, vectorHardLimitBytes: 10_000_000 };
  const e = await new Engine(s, p, { searchSnapshots: blobs(), searchSegmentLimits: limits }).init();
  await e.searchReady();
  const text = () => e.searchIndexes.all()[0]!.index;
  while (text().memoryBytes < 1500) await e.mutation((db) => db.insert("notes", note(1)));
  const refused = await e.mutation((db) => db.insert("notes", note(2))).catch((x) => x);
  expect(refused).toMatchObject({ code: "TextIndexTooLarge" });
  expect(refused.message).toStartWith("Too many writes to notes.search_body. Spread your writes out over time");
  // Other tables are not refused.
  await e.mutation((db) => db.insert("other", { x: 1 }));
  // The refusal woke the flusher: once it has flushed, writes go through.
  await e.searchFlushed();
  expect(text().memoryBytes).toBe(0);
  await e.mutation((db) => db.insert("notes", note(3)));
  await e.close();

  // The vector limit, the same way.
  const q = await MemoryPersistence.open(null, { durable: false });
  const v2 = await new Engine(s, q, {
    searchSnapshots: blobs(),
    searchSegmentLimits: { ...NEVER, textHardLimitBytes: 10_000_000, vectorHardLimitBytes: 500 },
  }).init();
  await v2.searchReady();
  const vec = () => v2.vectorIndexes.all()[0]!.index;
  while (vec().memoryBytes < 500) await v2.mutation((db) => db.insert("notes", note(1)));
  await expect(v2.mutation((db) => db.insert("notes", note(2)))).rejects.toMatchObject({ code: "VectorIndexTooLarge" });
  await v2.close();

  // Without a segment store there is nothing to flush into: never refused.
  const r = await MemoryPersistence.open(null, { durable: false });
  const plain = await new Engine(s, r, { searchSegmentLimits: { ...limits, textHardLimitBytes: 1 } }).init();
  for (let i = 0; i < 5; i++) await plain.mutation((db) => db.insert("notes", note(i)));
  await plain.close();
});

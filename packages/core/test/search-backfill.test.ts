// The paged backfill of a search or vector index (STUDY-111 PR 4), as Convex's incremental backfill: a segment
// per step of the table read at a fresh ts, the earlier pages' changes taken from the log, the cursor stored so a
// restart resumes from it; the answers are those of indexing the table at once, whatever was written meanwhile.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { readSearchIndexStates } from "../src/engine.ts";
import { defineSchema, defineTable, Engine, type SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const indexed = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body", filterFields: ["kind"] })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
});
const plain = defineSchema({ notes: defineTable(v.any()) });

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

/** Small steps: a few documents' worth each, so the table takes many. */
const SMALL = {
  textSoftLimitBytes: 400,
  vectorSoftLimitBytes: 160,
  textHardLimitBytes: 2 ** 40,
  vectorHardLimitBytes: 2 ** 40,
};

const note = (i: number) => ({ body: `note ${i} ${i % 3 ? "hello" : "world"}`, kind: `k${i % 2}`, v: [i % 5, 1] });

/** A store with `n` notes and no search index yet. */
async function seeded(n: number) {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(plain, p).init();
  const ids = await e.mutation(async (db) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push((await db.insert("notes", note(i))) as string);
    return out;
  });
  await e.close();
  return { p, ids };
}

async function answers(e: Engine) {
  const text: Record<string, unknown[]> = {};
  for (const word of ["hello", "world", "note", "changed", "new", "1"])
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
  return { text, vector: e.vectorSearch("notes", "by_v", { vector: [1, 0.5], limit: 256 }) };
}

/** The answers of indexing the table at once, in memory (no store). */
async function scanned(p: MemoryPersistence) {
  const e = await new Engine(indexed, p).init();
  await e.searchReady();
  const a = await answers(e);
  await e.close();
  return a;
}

test("a new index is built in steps, with writes between them, and answers as indexing the table", async () => {
  const { p, ids } = await seeded(120);
  let e!: Engine;
  let page = 0;
  let next = 1000;
  // Between pages: change documents already read and not yet read, delete some, insert others.
  const hook = async () => {
    page++;
    if (!e || page % 2) return;
    await e.mutation(async (db) => {
      await db.patch(ids[page % 120] as never, { body: `changed ${page}`, v: [0.1, page] });
      await db.patch(ids[(page * 7 + 60) % 120] as never, { body: `changed far ${page}`, kind: "k1" });
      if (page % 6 === 0) await db.delete(ids[(page * 13) % 120] as never).catch(() => {});
      await db.insert("notes", { body: `new ${next}`, kind: "k0", v: [1, 1] });
      next++;
    });
  };
  e = new Engine(indexed, p, {
    searchStorage: blobs(),
    searchSegmentLimits: SMALL,
    // No compaction, to see the steps' segments.
    searchCompaction: { minSegments: 1e9, maxDeletedFraction: 1 },
    beforeSearchBackfillPage: hook,
  });
  await e.init();
  await e.searchReady();
  expect(e.searchStats.backfillSteps).toBeGreaterThan(10);
  const state = (await readSearchIndexStates(p)) as {
    indexes: { kind: string; segments: unknown[]; backfill?: unknown }[];
  };
  for (const s of state.indexes) {
    expect(s.segments.length).toBeGreaterThan(3);
    expect(s.backfill).toBeUndefined(); // ready
  }
  const got = await answers(e);
  await e.close();
  expect(got).toEqual(await scanned(p));
});

test("a build interrupted by a crash resumes from its cursor; meanwhile searches answer IndexBackfillingError", async () => {
  const { p } = await seeded(150);
  const store = blobs();
  // The first run stops for good after its third step, then crashes.
  let e1!: Engine;
  let stepped!: () => void;
  const third = new Promise<void>((r) => {
    stepped = r;
  });
  e1 = new Engine(indexed, p, {
    searchStorage: store,
    searchSegmentLimits: SMALL,
    beforeSearchBackfillPage: () => {
      if (e1?.searchStats.backfillSteps >= 3) {
        stepped();
        return new Promise(() => {});
      }
      return Promise.resolve();
    },
  });
  await e1.init();
  await third;
  const state = (await readSearchIndexStates(p)) as { indexes: { backfill?: { cursor: string } }[] };
  expect(state.indexes.some((s) => typeof s.backfill?.cursor === "string")).toBe(true);
  e1.committer.fail(new Error("simulated crash"));
  await e1.close().catch(() => {});
  // Writes between the runs, to documents the crashed run had read: the resumed build takes them from the log.
  // (A run of the same schema whose build never gets to read a page, so the state is the crashed run's.)
  const between = await new Engine(indexed, p, {
    searchStorage: store,
    searchSegmentLimits: SMALL,
    beforeSearchBackfillPage: () => new Promise(() => {}),
  }).init();
  await between.mutation(async (db) => {
    const first = await db.query("notes").take(20);
    for (const d of first) await db.patch(d._id, { body: "changed between runs", v: [9, 1] });
    await db.delete(first[0]!._id);
  });
  await between.close();

  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const e2 = new Engine(indexed, p, {
    searchStorage: store,
    searchSegmentLimits: SMALL,
    beforeSearchBackfillPage: () => held,
  });
  await e2.init();
  await Bun.sleep(20);
  // Never ready before: Convex's answer for a backfilling index, not the bootstrapping one.
  await expect(
    e2.query((db) =>
      db
        .query("notes")
        .withSearchIndex("search_body", (q) => q.search("body", "hello"))
        .collect(),
    ),
  ).rejects.toMatchObject({ code: "IndexBackfillingError" });
  release();
  await e2.searchReady();
  expect(e2.searchStats.resumed).toBe(2);
  // It read only what the first run had not.
  expect(e2.searchStats.backfilled).toBeLessThan(2 * 150);
  const got = await answers(e2);
  await e2.close();
  expect(got).toEqual(await scanned(p));
});

test("an empty table's index is ready at once, with no segments", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const e = await new Engine(indexed, p, { searchStorage: blobs(), searchSegmentLimits: SMALL }).init();
  await e.searchReady();
  const state = (await readSearchIndexStates(p)) as { indexes: { segments: unknown[] }[] };
  expect(state.indexes.map((s) => s.segments.length)).toEqual([0, 0]);
  await e.mutation((db) => db.insert("notes", note(1)));
  expect((await answers(e)).text.hello).toHaveLength(1);
  await e.close();
});

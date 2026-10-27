// A push's new search and vector indexes are written and built during the push, as Convex's (STUDY-195 §2):
// `startSchemaPush` writes their `_index` rows, backfilling, in its own commit; they are built while the push waits
// (`schemaPushStatus` stays in progress, a search meanwhile is `IndexBackfillingError`); the commit enables them
// as they are, so a search right after it finds every document. With and without a segment store.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { IndexBackfillingError } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import type { SearchSegmentStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

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

const plain = defineSchema({ notes: defineTable(v.any()) });
const indexed = defineSchema({
  notes: defineTable(v.any())
    .searchIndex("search_body", { searchField: "body" })
    .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
});

const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await f()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out");
};

/** An engine with `notes` and 300 documents, its search backfill paused until `release()`. */
async function setup(withStore: boolean) {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  const pause = () => {
    gate = new Promise<void>((r) => {
      open = r;
    });
  };
  const e = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    storedSchema: true,
    ...(withStore ? { searchStorage: blobs() } : {}),
    beforeSearchBackfillPage: async () => {
      if (gate) await gate;
    },
  }).init();
  const p = await e.startSchemaPush(plain);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
  await e.mutation(async (db) => {
    for (let i = 0; i < 300; i++) await db.insert("notes", { body: i % 3 ? "hello there" : "goodbye", v: [i, 1] });
  });
  return {
    e,
    pause,
    release: () => {
      gate = null;
      open();
    },
  };
}

const search = (e: Engine) =>
  e.query(
    async (db) =>
      (
        await db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", "hello"))
          .collect()
      ).length,
  );

/** The `_index` rows of search and vector indexes, by name, at the latest commit. */
const rows = (e: Engine) =>
  e.query(async (db) =>
    db.asSystem(async () =>
      (await db.query("_index").collect())
        .filter((r) => ["search", "vector"].includes((r.config as { type: string }).type))
        .map((r) => r.descriptor as string)
        .sort(),
    ),
  );

for (const withStore of [false, true])
  describe(withStore ? "with a segment store" : "without a segment store", () => {
    test("the rows in the push's commit; in progress while built; a search meanwhile is backfilling", async () => {
      const t = await setup(withStore);
      t.pause();
      const p = await t.e.startSchemaPush(indexed);
      // The rows are there as the push's commit is, before any build.
      expect(await rows(t.e)).toEqual(["by_v", "search_body"]);
      const status = await t.e.schemaPushStatus(p.schemaId);
      expect(status).toMatchObject({ type: "inProgress" });
      await expect(search(t.e)).rejects.toBeInstanceOf(IndexBackfillingError);
      await expect(search(t.e)).rejects.toThrow(
        "Index notes.search_body is currently backfilling and not available to query yet.",
      );
      expect(() => t.e.vectorSearch("notes", "by_v", { vector: [1, 1] })).toThrow(IndexBackfillingError);
      t.release();
      await until(async () => (await t.e.schemaPushStatus(p.schemaId)).type === "complete");
      // Built, but not enabled before the commit (Convex's pending index).
      await expect(search(t.e)).rejects.toBeInstanceOf(IndexBackfillingError);
      await t.e.commitSchemaPush(p.schemaId, async () => {});
      // Enabled by the commit, as built: every document, at once.
      expect(await search(t.e)).toBe(200);
      expect(t.e.vectorSearch("notes", "by_v", { vector: [1, 0], limit: 3 })).toHaveLength(3);
      expect(await rows(t.e)).toEqual(["by_v", "search_body"]);
      await t.e.close();
    });

    test("writes during the push reach the pending index", async () => {
      const t = await setup(withStore);
      const p = await t.e.startSchemaPush(indexed);
      await t.e.mutation((db) => db.insert("notes", { body: "hello late", v: [9, 9] }));
      await until(async () => (await t.e.schemaPushStatus(p.schemaId)).type === "complete");
      await t.e.mutation(async (db) => {
        const late = await db
          .query("notes")
          .filter((q) => q.eq(q.field("body"), "goodbye"))
          .first();
        await db.patch(late!._id, { body: "hello again" });
      });
      await t.e.commitSchemaPush(p.schemaId, async () => {});
      expect(await search(t.e)).toBe(202);
      await t.e.close();
    });

    test("a push that replaces the pending one without the index drops it and its row", async () => {
      const t = await setup(withStore);
      t.pause();
      await t.e.startSchemaPush(indexed);
      expect(await rows(t.e)).toEqual(["by_v", "search_body"]);
      const again = await t.e.startSchemaPush(plain);
      t.release();
      await until(async () => (await t.e.schemaPushStatus(again.schemaId)).type === "complete");
      await t.e.searchIndexRowsWritten();
      expect(await rows(t.e)).toEqual([]);
      await t.e.commitSchemaPush(again.schemaId, async () => {});
      await expect(search(t.e)).rejects.toThrow("Index notes.search_body not found.");
      await t.e.close();
    });
  });

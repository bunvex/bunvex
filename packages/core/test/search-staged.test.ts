// Staged search and vector indexes (STUDY-111 PR 8), as Convex's: built in the background like any index, kept
// `Backfilled { staged }` (searches answer `IndexStagedError`), and enabled at once when a push un-stages them.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { IndexStagedError } from "../src/catalog.ts";
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

const schemaWith = (staged: boolean) =>
  staged
    ? defineSchema({
        notes: defineTable(v.any())
          .searchIndex("search_body", { searchField: "body", staged: true })
          .vectorIndex("by_v", { vectorField: "v", dimensions: 2, staged: true }),
      })
    : defineSchema({
        notes: defineTable(v.any())
          .searchIndex("search_body", { searchField: "body" })
          .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
      });

const until = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await f()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out");
};

async function push(e: Engine, schema: Parameters<Engine["startSchemaPush"]>[0]) {
  const p = await e.startSchemaPush(schema);
  await until(async () => (await e.schemaPushStatus(p.schemaId)).type === "complete");
  await e.commitSchemaPush(p.schemaId, async () => {});
}

const search = (e: Engine) =>
  e.query((db) =>
    db
      .query("notes")
      .withSearchIndex("search_body", (q) => q.search("body", "hello"))
      .collect(),
  );

/** The search rows' `onDiskState`, by index name. */
async function states(e: Engine) {
  const rows = (await e.query((db) =>
    db.asSystem(() =>
      (db as unknown as { query(t: string): { collect(): Promise<unknown[]> } }).query("_index").collect(),
    ),
  )) as { descriptor: string; config?: { onDiskState: Record<string, unknown> } }[];
  return Object.fromEntries(rows.filter((r) => r.config).map((r) => [r.descriptor, r.config!.onDiskState]));
}

test("a staged index is built and kept Backfilled { staged }; un-staging it enables it at once", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await new Engine(defineSchema({}), p, { searchStorage: store, storedSchema: true }).init();
  await push(e, defineSchema({ notes: defineTable(v.any()) }));
  await e.mutation(async (db) => {
    for (let i = 0; i < 30; i++) await db.insert("notes", { body: i % 2 ? "hello" : "world", v: [i, 1] });
  });

  await push(e, schemaWith(true));
  await e.searchReady();
  // Built in the background, then Convex's `Backfilled2 { snapshot, staged }`.
  const staged = await states(e);
  for (const name of ["search_body", "by_v"]) {
    expect(staged[name]!.state).toBe("backfilled2");
    expect(staged[name]!.staged).toBe(true);
    expect((staged[name]!.snapshot as { data: { segments: unknown[] } }).data.segments.length).toBeGreaterThan(0);
  }
  for (const x of [...e.searchIndexes.all(), ...e.vectorIndexes.all()])
    expect([x.staged, x.ready]).toEqual([true, true]);
  await expect(search(e)).rejects.toBeInstanceOf(IndexStagedError);
  expect(() => e.vectorSearch("notes", "by_v", { vector: [1, 0] })).toThrow(IndexStagedError);
  // Writes keep it current while staged.
  await e.mutation((db) => db.insert("notes", { body: "hello again", v: [1, 0] }));

  // Un-staged by a push: enabled at once, from what was built (no new build).
  const steps = e.searchStats.backfillSteps;
  await push(e, schemaWith(false));
  expect(e.searchStats.backfillSteps).toBe(steps);
  expect(await search(e)).toHaveLength(16);
  expect(e.vectorSearch("notes", "by_v", { vector: [1, 0], limit: 256 })).toHaveLength(31);
  await until(async () => (await states(e)).search_body!.state === "snapshotted");
  expect((await states(e)).by_v!.state).toBe("snapshotted");

  // Staged again: it stays built, `Backfilled2` again.
  await push(e, schemaWith(true));
  await until(async () => (await states(e)).search_body!.state === "backfilled2");
  expect(e.searchStats.backfillSteps).toBe(steps);
  await e.close();

  // A start loads a staged index's segments too.
  const e2 = await new Engine(defineSchema({}), p, { searchStorage: store, storedSchema: true }).init();
  await e2.searchReady();
  expect(e2.searchStats.fromSegments).toBe(2);
  for (const x of e2.searchIndexes.all()) expect([x.staged, x.ready]).toEqual([true, true]);
  await e2.close();
});

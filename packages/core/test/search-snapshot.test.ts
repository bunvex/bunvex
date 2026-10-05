// Search index snapshots (STUDY-96): written at a clean shutdown, restored at start with the log since — the
// same results as indexing the tables — and refused (the tables are indexed instead) when they cannot be
// trusted: another store, a changed definition, outside retention, unreadable.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { defineSchema, defineTable, Engine, SEARCH_SNAPSHOT_GLOBAL, type SearchSnapshotStore } from "../src/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";

const schemaWith = (filterFields: string[]) =>
  defineSchema({
    notes: defineTable(v.any())
      .searchIndex("search_body", { searchField: "body", filterFields })
      .vectorIndex("by_v", { vectorField: "v", dimensions: 2 }),
  });
const schema = schemaWith(["kind"]);

/** Blobs in memory, as the server's `search` use case keeps them. */
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

async function open(p: MemoryPersistence, store?: SearchSnapshotStore, s = schema) {
  const e = await new Engine(s, p, store ? { searchSnapshots: store } : {}).init();
  await e.searchReady();
  return e;
}

/** What searches answer: text hits for each word, vector neighbours. */
async function answers(e: Engine) {
  const text: Record<string, unknown[]> = {};
  for (const word of ["hello", "world", "again"])
    text[word] = (
      await e.query((db) =>
        db
          .query("notes")
          .withSearchIndex("search_body", (q) => q.search("body", word))
          .collect(),
      )
    ).map((d) => d._id);
  const vector = e.vectorSearch("notes", "by_v", { vector: [1, 0], limit: 10 }).map((h) => h._id);
  return { text, vector };
}

test("a restart restores the indexes from the snapshot and the log since: the answers of indexing the tables", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e1 = await open(p, store);
  const ids = await e1.mutation(async (db) => [
    await db.insert("notes", { body: "hello world", kind: "a", v: [1, 0] }),
    await db.insert("notes", { body: "hello there", kind: "b", v: [0, 1] }),
    await db.insert("notes", { body: "plain", kind: "a", v: [0.5, 0.5] }),
  ]);
  await e1.close(); // a clean shutdown: the snapshot
  expect(store.map.size).toBe(1);

  // A run that writes and then crashes: no snapshot of its own (it has none to write to).
  const e2 = await open(p);
  await e2.mutation(async (db) => {
    await db.patch(ids[0] as never, { body: "world again", v: [0.9, 0.1] });
    await db.delete(ids[1] as never);
    await db.insert("notes", { body: "hello again", kind: "c", v: [1, 0.1] });
  });
  const expected = await answers(e2);
  await e2.close();

  const e3 = await open(p, store);
  expect(e3.searchStats.restored).toBe(2);
  expect(await answers(e3)).toEqual(expected);
  await e3.close();
  // Its own clean shutdown replaced the snapshot.
  expect(store.map.size).toBe(1);
  const scanned = await open(p);
  expect(scanned.searchStats.restored).toBe(0);
  expect(await answers(scanned)).toEqual(expected);
  await scanned.close();
});

const seeded = async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const store = blobs();
  const e = await open(p, store);
  await e.mutation((db) => db.insert("notes", { body: "hello world", kind: "a", v: [1, 0] }));
  await e.close();
  return { p, store };
};

test("refused, the tables indexed instead: another store, unreadable, outside retention", async () => {
  // A store that never wrote it (the snapshot's token is not the store's).
  const { store } = await seeded();
  const fresh = await MemoryPersistence.open(null, { durable: false });
  const other = await open(fresh, store);
  expect(other.searchStats.restored).toBe(0);
  await other.close();

  const a = await seeded();
  for (const k of a.store.map.keys()) a.store.map.set(k, new Uint8Array([1, 2, 3]));
  const unreadable = await open(a.p, a.store);
  expect(unreadable.searchStats.restored).toBe(0);
  expect((await answers(unreadable)).text.hello).toHaveLength(1);
  await unreadable.close();

  const b = await seeded();
  await b.p.setGlobal("document_min_snapshot_ts", Number.MAX_SAFE_INTEGER);
  const old = await open(b.p, b.store);
  expect(old.searchStats.restored).toBe(0);
  await old.close();

  // The store points at the blob, but under another token (another snapshot's).
  const d = await seeded();
  const mark = (await d.p.getGlobal(SEARCH_SNAPSHOT_GLOBAL)) as { key: string };
  await d.p.setGlobal(SEARCH_SNAPSHOT_GLOBAL, { key: mark.key, token: "another" });
  const mismatched = await open(d.p, d.store);
  expect(mismatched.searchStats.restored).toBe(0);
  await mismatched.close();

  const c = await seeded();
  await c.p.setGlobal(SEARCH_SNAPSHOT_GLOBAL, null);
  const unmarked = await open(c.p, c.store);
  expect(unmarked.searchStats.restored).toBe(0);
  await unmarked.close();
});

test("an index whose definition changed is indexed from its table; the others restore", async () => {
  const { p, store } = await seeded();
  const e = await open(p, store, schemaWith([]));
  expect(e.searchStats.restored).toBe(1); // the vector index only
  expect((await answers(e)).text.hello).toHaveLength(1);
  await e.close();
});

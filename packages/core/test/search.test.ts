// Full-text search in the engine (STUDY-45 PR 2): `withSearchIndex` with Convex's checks and messages, the
// index kept up to date by commits and backfilled at start, a transaction's snapshot and own writes, `eq`
// filters by value (int64 ≠ float64, a missing field), pagination, the 1024 limit, staged indexes.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { IndexBackfillingError, IndexStagedError } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const schema = defineSchema({
  messages: defineTable(v.any())
    .index("by_channel", ["channel"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["channel", "n"] })
    .searchIndex("search_title", { searchField: "title", staged: true }),
});

async function memory() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.searchReady();
  return e;
}
const add = (e: Engine, doc: Record<string, unknown>) => e.mutation((db) => db.insert("messages", doc));
const bodies = (docs: Record<string, unknown>[]) => docs.map((d) => d.body);
const search = (db: Tx, text: string, eqs: [string, unknown][] = []) =>
  db.query("messages").withSearchIndex("search_body", (q) => {
    let b = q.search("body", text);
    for (const [f, value] of eqs) b = b.eq(f, value);
    return b;
  });

test("results in relevance order, kept up to date by every commit", async () => {
  const e = await memory();
  await add(e, { body: "the quick brown fox", channel: "a" });
  await add(e, { body: "quick quick quick", channel: "b" });
  const id = await add(e, { body: "a slow brown dog", channel: "a" });
  await add(e, { body: "nothing here", channel: "a" });
  expect(bodies(await e.query((db) => search(db, "quick brown").collect()))).toEqual([
    "the quick brown fox",
    "quick quick quick",
    "a slow brown dog",
  ]);
  // Filters, `take`, `first`, a post-filter.
  expect(bodies(await e.query((db) => search(db, "quick brown", [["channel", "a"]]).collect()))).toEqual([
    "the quick brown fox",
    "a slow brown dog",
  ]);
  // Same length, one occurrence each: a tie, broken by `_creationTime`, newest first.
  expect((await e.query((db) => search(db, "brown").first()))?.body).toBe("a slow brown dog");
  expect(
    bodies(
      await e.query((db) =>
        search(db, "brown")
          .filter((q) => q.eq(q.field("channel"), "b"))
          .take(1),
      ),
    ),
  ).toEqual([]);
  // Updated and deleted documents follow.
  await e.mutation((db) => db.patch("messages", id, { body: "a slow red dog" }));
  await e.mutation(async (db) => {
    const [fox] = await search(db, "fox").collect();
    await db.delete("messages", fox!._id as string);
  });
  expect(bodies(await e.query((db) => search(db, "brown").collect()))).toEqual([]);
  // The last term matches as a prefix too; an empty query finds nothing.
  expect(bodies(await e.query((db) => search(db, "qui").collect()))).toEqual(["quick quick quick"]);
  expect(await e.query((db) => search(db, "").collect())).toEqual([]);
  await e.close();
});

test("a transaction searches its snapshot plus its own writes", async () => {
  const e = await memory();
  await add(e, { body: "apple" });
  const before = e.committer.visibleTs;
  await add(e, { body: "apple pie" });
  // At the earlier snapshot, the later document does not exist.
  expect(bodies(await e.query((db) => search(db, "apple").collect(), undefined, undefined, undefined, before))).toEqual(
    ["apple"],
  );
  // A document changed after the snapshot is found by its old text there.
  const changing = await add(e, { body: "orange" });
  const beforeChange = e.committer.visibleTs;
  await e.mutation((db) => db.patch("messages", changing, { body: "lemon" }));
  expect(
    bodies(await e.query((db) => search(db, "orange").collect(), undefined, undefined, undefined, beforeChange)),
  ).toEqual(["orange"]);
  expect(bodies(await e.query((db) => search(db, "orange").collect()))).toEqual([]);
  const seen = await e.mutation(async (db) => {
    await db.insert("messages", { body: "apple apple apple" });
    return bodies(await search(db, "apple").collect());
  });
  expect(seen).toContain("apple apple apple");
  expect(seen).toHaveLength(3);
  await e.close();
});

test("eq compares values as Convex: int64 is not float64; undefined matches a missing field", async () => {
  const e = await memory();
  await add(e, { body: "x", n: 1n });
  await add(e, { body: "x", n: 1 });
  await add(e, { body: "x" });
  const by = (value: unknown) => e.query((db) => search(db, "x", [["n", value]]).collect());
  expect((await by(1n)).map((d) => d.n)).toEqual([1n]);
  expect((await by(1)).map((d) => d.n)).toEqual([1]);
  expect((await by(undefined)).map((d) => "n" in d)).toEqual([false]);
  await e.close();
});

test("Convex's checks and messages", async () => {
  const e = await memory();
  const q = (f: (db: Tx) => Promise<unknown>) => e.query(f);
  await expect(q((db) => search(db, "x").order("desc").collect())).rejects.toThrow(
    "Search queries must always be in relevance order. Can not set order manually.",
  );
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (b) => b.search("title", "x"))
        .collect(),
    ),
  ).rejects.toThrow(
    'Search query against messages.search_body contains a search filter against "title", which doesn\'t match the indexed `searchField` "body".',
  );
  await expect(q((db) => search(db, "x", [["author", "a"]]).collect())).rejects.toThrow(
    'Search query against messages.search_body contains an equality filter on "author" but that field isn\'t indexed for filtering in `filterFields`.',
  );
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (b) => b.eq("channel", "a"))
        .collect(),
    ),
  ).rejects.toThrow(
    'Search query against messages.search_body does not contain any search filters. You must include a search filter like `q.search(""body"", searchText)`.',
  );
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (b) => b.search("body", "a").search("body", "b"))
        .collect(),
    ),
  ).rejects.toThrow('contains multiple search filters against "body". Only one is allowed.');
  const nine = Array.from({ length: 9 }, () => ["channel", "a"] as [string, unknown]);
  await expect(q((db) => search(db, "x", nine).collect())).rejects.toThrow(
    "Search query against messages.search_body has too many filter conditions. Max: 8 Actual: 9",
  );
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("by_channel", (b) => b.search("body", "x"))
        .collect(),
    ),
  ).rejects.toThrow("Index messages.by_channel is not a search index");
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("nope", (b) => b.search("body", "x"))
        .collect(),
    ),
  ).rejects.toThrow("Index messages.nope not found.");
  await expect(q((db) => db.query("messages").withIndex("search_body").collect())).rejects.toThrow(
    "Index messages.search_body is not a database index",
  );
  await expect(
    q((db) =>
      db
        .query("messages")
        .withSearchIndex("search_title", (b) => b.search("title", "x"))
        .collect(),
    ),
  ).rejects.toBeInstanceOf(IndexStagedError);
  expect(() =>
    e.query((db) =>
      db
        .query("messages")
        .withSearchIndex("search_body", (b) => {
          b.search("body", "x");
          return b.search("body", "y");
        })
        .collect(),
    ),
  ).toThrow("SearchFilterBuilder has already been used!");
  await e.close();
});

test("pagination; at most 1024 candidates", async () => {
  const e = await memory();
  await e.mutation(async (db) => {
    for (let i = 0; i < 1030; i++) await db.insert("messages", { body: `word ${i}` });
  });
  const seen = new Set<unknown>();
  let cursor: string | null = null;
  for (let i = 0; i < 2; i++) {
    const r = await e.query((db) => search(db, "word").paginate({ numItems: 400, cursor }));
    expect(r.page).toHaveLength(400);
    expect(r.isDone).toBe(false);
    for (const d of r.page) seen.add(d._id);
    cursor = r.continueCursor;
  }
  expect(seen.size).toBe(800);
  // The third page would read past the 1024 candidates, as Convex's: an error.
  const third = cursor;
  await expect(e.query((db) => search(db, "word").paginate({ numItems: 400, cursor: third }))).rejects.toThrow(
    "Search query scanned too many documents",
  );
  await expect(e.query((db) => search(db, "word").collect())).rejects.toThrow(
    "Search query scanned too many documents (fetched 1024).",
  );
  expect(await e.query((db) => search(db, "word").take(10))).toHaveLength(10);
  await e.close();
});

test("a restart backfills the index; queries meanwhile get IndexBackfillingError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-search-"));
  dirs.push(dir);
  // The backfill waits for `release` before its first page: the test runs while it is pending.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const open = (hold = false) =>
    new Engine(schema, new SqlitePersistence(join(dir, "db.sqlite"), { durable: true }), {
      ...(hold ? { beforeSearchBackfillPage: () => held } : {}),
    }).init();
  const first = await open();
  await first.mutation(async (db) => {
    for (let i = 0; i < 5000; i++) await db.insert("messages", { body: i === 7 ? "needle" : `hay ${i}` });
  });
  // The document the backfill reads last (by id): changed while the backfill runs, before it gets there.
  const last = (await first.query((db) => db.query("messages").withIndex("by_id").order("desc").first()))!;
  await first.close();
  const e = await open(true);
  await expect(e.query((db) => search(db, "needle").collect())).rejects.toBeInstanceOf(IndexBackfillingError);
  // Writes while the backfill runs are not lost, nor overwritten by its older copies.
  await add(e, { body: "needle too" });
  await e.mutation((db) => db.patch("messages", last._id as string, { body: "changed" }));
  release();
  await e.searchReady();
  expect(bodies(await e.query((db) => search(db, "needle").collect())).sort()).toEqual(["needle", "needle too"]);
  expect(bodies(await e.query((db) => search(db, "changed").collect()))).toEqual(["changed"]);
  // Its old text ("hay <n>") is gone from the index: its number no longer finds it (other numbers may
  // match it as a prefix).
  const byNumber = await e.query((db) => search(db, (last.body as string).split(" ")[1]!).collect());
  expect(byNumber.some((d) => d._id === last._id)).toBe(false);
  await e.close();
});

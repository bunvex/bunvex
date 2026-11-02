// A transaction's count and text search may be answered later (STUDY-194 §10.1, PR 2b commit 0a): a worker asks
// the main thread, which holds the table summaries and the search indexes. The answers, the read set and the
// errors are the same as when they are answered in the same turn.
import { expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import type { SearchIndexEntry, SearchIndexes } from "../src/search-indexes.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import { TableSummariesUnavailableError } from "../src/table-summaries.ts";
import type { Tx } from "../src/tx.ts";

const schema = defineSchema({
  t: defineTable(v.any()),
  messages: defineTable(v.any()).searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
});

async function engine() {
  const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
  await e.summariesReady();
  await e.searchReady();
  return e;
}

/** The transaction's count and search, answered a turn later, as a worker's are. */
function later(db: Tx) {
  const count = db.tableCount!;
  db.tableCount = async (tablet, snapshot) => {
    await Promise.resolve();
    return count(tablet, snapshot);
  };
  const indexes = db.searchIndexes as SearchIndexes;
  db.searchRunner = async (e, q, snapshot, pending) => {
    await Promise.resolve();
    const entry = e as SearchIndexEntry;
    return { hits: await indexes.search(entry, q, snapshot, pending), indexedBytes: entry.index.indexedBytes };
  };
  return db;
}

test("a count answered later is the same count, with its own writes and the same read set", async () => {
  const run = async (async_: boolean) => {
    const e = await engine();
    await e.mutation(async (db) => {
      await db.insert("t", { x: 1 });
      await db.insert("t", { x: 2 });
    });
    return e.mutation(async (db) => {
      if (async_) later(db);
      const before = await db.query("t").count();
      await db.insert("t", { x: 3 });
      return [before, await db.query("t").count(), db.reads.length];
    });
  };
  const now = await run(false);
  expect(now.slice(0, 2)).toEqual([2, 3]);
  expect(await run(true)).toEqual(now);
});

test("a count answered later that fails fails the same way as in the same turn", async () => {
  const e = await engine();
  const failing = (async_: boolean) =>
    e.query(async (db) => {
      db.tableCount = async_
        ? async () => {
            await Promise.resolve();
            throw new TableSummariesUnavailableError();
          }
        : () => {
            throw new TableSummariesUnavailableError();
          };
      try {
        return await db.query("t").count();
      } catch (err) {
        return err instanceof TableSummariesUnavailableError ? "unavailable" : String(err);
      }
    }, `fail-${async_}`);
  expect(await failing(false)).toBe("unavailable");
  expect(await failing(true)).toBe("unavailable");
});

test("a search answered later finds the same documents in the same order, with the same read set", async () => {
  const e = await engine();
  await e.mutation(async (db) => {
    for (const body of ["apple pie", "apple tart", "banana", "apple"])
      await db.insert("messages", { body, channel: "a" });
  });
  const run = (async_: boolean) =>
    e.query(async (db) => {
      if (async_) later(db);
      const docs = await db
        .query("messages")
        .withSearchIndex("search_body", (q) => q.search("body", "apple").eq("channel", "a"))
        .take(10);
      return {
        bodies: docs.map((d) => d.body),
        reads: JSON.stringify(db.reads, (_k, x) => (typeof x === "bigint" ? `${x}` : x)),
      };
    }, `search-${async_}`);
  const now = await run(false);
  expect(now.bodies.length).toBe(3);
  expect(await run(true)).toEqual(now);
});

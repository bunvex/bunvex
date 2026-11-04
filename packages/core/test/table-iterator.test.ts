// The table iterator (Convex's `TableIterator`, crates/table_iteration/src/table_iterator.rs, STUDY-205): a
// snapshot read page by page, each page at a recent ts, after the index window has passed the snapshot, with
// writes going on between pages. Each table read must equal the snapshot, in `by_id` order.
import { afterEach, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { OutOfRetentionError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import type { RetentionOptions } from "../src/retention.ts";
import { type Doc, defineSchema, defineTable } from "../src/schema.ts";
import { TableIterator } from "../src/table-iterator.ts";

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
});

/** The loops wait; the test moves the windows. */
const manual = (documentDelayMs: number): RetentionOptions => ({
  background: false,
  indexDelayMs: 0,
  documentDelayMs,
  advanceEveryMs: 3_600_000,
  documentEveryMs: 3_600_000,
  checkpointEveryMs: 0,
});

async function open(documentDelayMs = 3_600_000) {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()), other: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { retention: manual(documentDelayMs) },
  ).init();
  engines.push(e);
  return e;
}

const byId = (e: Engine, table: string, at?: bigint) =>
  e.query(
    (db) =>
      db
        .query(table)
        .withIndex("by_id" as never)
        .collect(),
    undefined,
    undefined,
    undefined,
    at,
  ) as Promise<Doc[]>;

test("pages after the index window passed the snapshot: the snapshot, in id order, with writes between pages", async () => {
  const e = await open();
  for (let n = 0; n < 20; n++) await e.mutation((db) => db.insert("items", { n }));
  for (let n = 0; n < 7; n++) await e.mutation((db) => db.insert("other", { n }));
  const at = e.committer.visibleTs;
  const items = await byId(e, "items", at);
  const other = await byId(e, "other", at);
  const t = (name: string) => e.catalog.tables.get(name)!;
  const it = new TableIterator(e, at, [t("items"), t("other")], 3);

  const r = e.retention!;
  let round = 0;
  /** Between pages: change a document already read, one not read yet, delete one, insert one, in both tables. */
  const writes = async () => {
    const now = await byId(e, "items");
    const k = round++;
    const ids = now.map((d) => d._id);
    await e.mutation((db) => db.patch(ids[k % ids.length] as never, { n: 100 + k }));
    await e.mutation((db) => db.patch(ids[(k * 7 + 5) % ids.length] as never, { n: 200 + k }));
    await e.mutation((db) => db.delete(ids[(k * 3 + 11) % ids.length] as never));
    await e.mutation((db) => db.insert("items", { n: 300 + k }));
    const others = await byId(e, "other");
    if (others.length > 2) await e.mutation((db) => db.delete(others[1]!._id as never));
    await e.mutation((db) => db.patch(others[0]!._id as never, { n: 400 + k }));
    await e.mutation((db) => db.insert("other", { n: 500 + k }));
    // The index window passes everything, and its deleter prunes what it can.
    await r.advance();
    await r.deleteIndexes();
  };
  await writes();
  // A read at the snapshot itself is refused now.
  await expect(byId(e, "items", at)).rejects.toBeInstanceOf(OutOfRetentionError);

  const read = async (name: string) => {
    const out: Doc[] = [];
    for await (const page of it.pages(t(name))) {
      expect(page.length).toBeGreaterThan(0);
      out.push(...page);
      await writes();
    }
    return out;
  };
  expect(await read("items")).toEqual(items);
  expect(await read("other")).toEqual(other);
  expect(round).toBeGreaterThan(8);
});

test("a snapshot the document window passed is refused", async () => {
  const e = await open(0);
  await e.mutation((db) => db.insert("items", { n: 1 }));
  const at = e.committer.visibleTs;
  // Nothing of `items` changes after it: it is refused before any of its documents is read.
  await e.mutation((db) => db.insert("other", { n: 2 }));
  const r = e.retention!;
  await r.advance();
  await r.deleteIndexes();
  await r.advance();
  expect(r.minDocumentTs).toBeGreaterThan(at);
  const it = new TableIterator(e, at, [e.catalog.tables.get("items")!], 3);
  const pages = it.pages(e.catalog.tables.get("items")!);
  await expect(pages.next()).rejects.toThrow(
    `Document snapshot timestamp out of leader retention window: ${at} < ${r.minDocumentTs}`,
  );
});

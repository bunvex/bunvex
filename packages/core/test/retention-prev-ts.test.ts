// Retention by `prev_ts` (STUDY-133 PR 10, Convex's `expired_index_entries` / `expired_documents`): the index
// pass re-derives each replaced version's keys from the document log's revision pairs; the document pass deletes
// the replaced versions and a delete's tombstone.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { Engine } from "../src/engine.ts";
import { internalIdBytes, internalIdOf } from "../src/internal-id.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import type { RetentionOptions } from "../src/retention.ts";
import { type Doc, defineSchema, defineTable, indexKey, type SchemaDefinition } from "../src/schema.ts";

const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const plain = defineSchema({ items: defineTable(v.any()) });
const manual: RetentionOptions = {
  background: false,
  indexDelayMs: 0,
  documentDelayMs: 0,
  advanceEveryMs: 3_600_000,
  documentEveryMs: 3_600_000,
  checkpointEveryMs: 0,
  documentRatePerSec: 1e9,
};
const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open(schema: SchemaDefinition, path = ":memory:") {
  const p = new SqlitePersistence(path, { durable: false });
  const e = await new Engine(schema, p, { retention: manual }).init();
  engines.push(e);
  return { e, db: (p as unknown as { db: import("bun:sqlite").Database }).db };
}

type Row = { ts: bigint; deleted: number };
const indexRows = (db: import("bun:sqlite").Database, index: string, key: Uint8Array) =>
  (
    db
      .query(`select ts, deleted from indexes where index_id = ? and key = ? order by ts`)
      .safeIntegers(true)
      .all(internalIdBytes(index), key) as Row[]
  ).map((r) => ({ ts: r.ts, deleted: Number(r.deleted) }));
const docRows = (db: import("bun:sqlite").Database, id: string) =>
  (
    db
      .query(`select ts, deleted from documents where id = ? order by ts`)
      .safeIntegers(true)
      .all(internalIdBytes(internalIdOf(id))) as Row[]
  ).map((r) => ({ ts: r.ts, deleted: Number(r.deleted) }));

const byN = (e: Engine) => {
  const t = e.catalog.table("items");
  return t.indexes.get("by_n") ?? t.pending.find((i) => i.name === "by_n")!;
};
const all = (e: Engine) =>
  e.query(async (db) => ({
    all: await db.query("items").collect(),
    byN: await db
      .query("items")
      .withIndex("by_n", (q) => q.gte("n", 0))
      .collect(),
  }));

/** A commit after the others, so the window passes every version before it (a pass prunes below the window). */
const later = (e: Engine) => e.mutation((d) => d.insert("items", { n: -100 }));

describe("retention by prev_ts", () => {
  test("a moved key's replaced entry and tombstone are pruned; an unchanged key keeps its live entry", async () => {
    const { e, db } = await open(indexed);
    const a = (await e.mutation((d) => d.insert("items", { n: 1 }))) as string;
    const b = (await e.mutation((d) => d.insert("items", { n: 5 }))) as string;
    const a1 = (await e.query((d) => d.get(a))) as Doc;
    await e.mutation((d) => d.patch(a, { n: 2 })); // the key moves
    const a2 = (await e.query((d) => d.get(a))) as Doc;
    await e.mutation((d) => d.patch(a, { x: 1 })); // the key stays
    const a3 = (await e.query((d) => d.get(a))) as Doc;
    const bDoc = (await e.query((d) => d.get(b))) as Doc;
    const ix = byN(e);
    const k1 = indexKey(ix, a1);
    const k2 = indexKey(ix, a2);
    expect(indexRows(db, ix.id, k1).length).toBe(2); // the entry and its tombstone
    expect(indexRows(db, ix.id, k2).length).toBe(2); // two versions of one key
    await later(e);
    const before = await all(e);
    const r = e.retention!;
    await r.advance();
    await r.deleteIndexes();
    expect(indexRows(db, ix.id, k1)).toEqual([]);
    const tsOf = async (id: string) =>
      (await e.persistence.get(e.catalog.table("items").id, internalIdOf(id), r.minIndexTs))!.ts;
    expect(indexRows(db, ix.id, k2)).toEqual([{ ts: await tsOf(a), deleted: 0 }]);
    expect(indexKey(ix, a3)).toEqual(k2);
    expect(indexRows(db, ix.id, indexKey(ix, bDoc))).toEqual([{ ts: await tsOf(b), deleted: 0 }]);
    expect(await all(e)).toEqual(before);
  });

  test("a backfilled index (entries at each document's own ts) is pruned the same way after an update", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunvex-retention-prev-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const first = await open(plain, path);
    const id = (await first.e.mutation((d) => d.insert("items", { n: 1 }))) as string;
    await first.e.mutation((d) => d.insert("items", { n: 7 }));
    await first.e.close();
    engines.splice(engines.indexOf(first.e), 1);
    const { e, db } = await open(indexed, path);
    await e.indexesReady();
    const ix = byN(e);
    const old = (await e.query((d) => d.get(id))) as Doc;
    const k1 = indexKey(ix, old);
    // The backfill wrote the entry at the document's own ts, below the index's creation.
    expect(indexRows(db, ix.id, k1)).toEqual([{ ts: docRows(db, id)[0]!.ts, deleted: 0 }]);
    await e.mutation((d) => d.patch(id, { n: 3 }));
    await later(e);
    const before = await all(e);
    await e.retention!.advance();
    await e.retention!.deleteIndexes();
    expect(indexRows(db, ix.id, k1)).toEqual([]);
    expect(await all(e)).toEqual(before);
  });

  test("the document pass deletes replaced versions and a delete's tombstone, and keeps the live version", async () => {
    const { e, db } = await open(indexed);
    const a = (await e.mutation((d) => d.insert("items", { n: 1 }))) as string;
    await e.mutation((d) => d.patch(a, { n: 2 }));
    await e.mutation((d) => d.patch(a, { n: 3 }));
    const c = (await e.mutation((d) => d.insert("items", { n: 9 }))) as string;
    await e.mutation((d) => d.delete(c));
    expect(docRows(db, a).length).toBe(3);
    expect(docRows(db, c).length).toBe(2);
    const live = docRows(db, a)[2]!;
    await later(e);
    const r = e.retention!;
    await r.advance();
    await r.deleteIndexes();
    await r.advance(); // the document window follows the recorded index cursor
    await r.deleteDocuments();
    expect(docRows(db, a)).toEqual([live]);
    expect(docRows(db, c)).toEqual([]);
    expect(((await e.query((d) => d.get(a))) as Doc).n).toBe(3);
  });

  test("a version whose predecessor was already pruned is skipped, without an error", async () => {
    const { e } = await open(indexed);
    const a = (await e.mutation((d) => d.insert("items", { n: 1 }))) as string;
    await e.mutation((d) => d.patch(a, { n: 2 }));
    await e.mutation((d) => d.patch(a, { n: 3 }));
    await later(e);
    const r = e.retention!;
    await r.advance();
    // A document window ahead of the index cursor (a store another version wrote): the predecessors go first.
    r.minDocumentTs = r.minIndexTs;
    await r.deleteDocuments();
    await r.deleteIndexes();
    expect(r.indexCursor).toBe(r.minIndexTs - 1n);
    expect(r.stats.errors).toBe(0);
    expect(((await e.query((d) => d.get(a))) as Doc).n).toBe(3);
  });
});

// Retention and a backfill in progress (Convex's `retention_started`, crates/database/src/retention.rs
// `accumulate_index_document`, and `IndexWorker::backfill_tablet`'s `run_retention`): the index deleter skips an
// index while a backfill scans its table, and catches up on it once the scan is done, before it is published. A
// scan writes each document's entries at the version's own ts, possibly after the deleter passed a later version
// of it: pruned meanwhile, that version's tombstone would be gone and the scan's entry would stay.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { INDEX_TABLE, indexMeta, indexStatePatch } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import type { IndexEntryAt } from "../src/persistence/index.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import type { RetentionOptions } from "../src/retention.ts";
import { defineSchema, defineTable, type EngineSchema } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const dirs: string[] = [];
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plain = defineSchema({ items: defineTable(v.any()) });
const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
/** The loops wait; the test drives the passes. */
const manual: RetentionOptions = {
  background: false,
  indexDelayMs: 0,
  documentDelayMs: 3_600_000,
  advanceEveryMs: 3_600_000,
  documentEveryMs: 3_600_000,
  checkpointEveryMs: 0,
};
const repeatableTs = { commitDelayMs: 3_600_000, idleMs: 3_600_000 };

async function open(path: string, schema: EngineSchema, wrap?: (p: SqlitePersistence) => void) {
  const p = new SqlitePersistence(path, { durable: false });
  wrap?.(p);
  const e = await new Engine(schema, p, { retention: manual, repeatableTs }).init();
  engines.push(e);
  return { e, db: (p as unknown as { db: import("bun:sqlite").Database }).db };
}

test("a version deleted while the backfill scans its table stays out of the new index after retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backfill-retention-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  let gone: string;
  {
    const { e } = await open(path, plain);
    gone = (await e.mutation((db) => db.insert("items", { n: 1 }))) as string;
    await e.mutation((db) => db.insert("items", { n: 2 }));
    await e.close();
  }
  // The scan reads its chunk, then waits before writing it (a rate limit, a slow store).
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const { e, db } = await open(path, indexed, (p) => {
    const write = p.writeIndexEntries.bind(p);
    p.writeIndexEntries = async (entries: IndexEntryAt[]) => {
      reached.resolve();
      await gate.promise;
      return write(entries);
    };
  });
  await reached.promise;
  // After the scan's snapshot: the delete maintains the index, a tombstone at its own ts.
  await e.mutation((db) => db.delete(gone as never));
  for (let i = 0; i < 2; i++) await e.mutation((db) => db.insert("other", { i }));
  // The index window passes the delete, and the index deleter runs while the scan still holds its chunk.
  const r = e.retention!;
  await r.advance();
  await r.deleteIndexes();
  // It skipped the index being scanned: the delete's tombstone there is the one left (the others' went).
  const tombstones = () => (db.query("select count(*) as n from indexes where deleted = 1").get() as { n: number }).n;
  expect(tombstones()).toBe(1);
  gate.resolve();
  await e.indexesReady();

  const byN = await e.query(async (db) =>
    (
      await db
        .query("items")
        .withIndex("by_n" as never)
        .collect()
    ).map((d) => d.n),
  );
  expect(byN).toEqual([2]);
  // And the catch-up pruned what the deleter skipped: the deleted document's entry and its tombstone.
  expect(tombstones()).toBe(0);
}, 30_000);

test("a backfill whose retention has started is not scanned again: it catches up and finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backfill-retention-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  {
    const { e } = await open(path, plain);
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await e.close();
  }
  // Stopped after `retentionStarted` was committed, before the backfill finished.
  {
    const p = new SqlitePersistence(path, { durable: false });
    const e = await new Engine(indexed, p, {
      retention: manual,
      repeatableTs,
      indexBackfill: { enabled: false },
    }).init();
    await (e as unknown as { runMutation(b: (db: Tx) => Promise<void>, system: boolean): Promise<void> }).runMutation(
      async (db) => {
        for (const row of await db.query(INDEX_TABLE).collect()) {
          const m = indexMeta(row as Record<string, unknown>);
          if (m.name === "by_n") await db.patch(INDEX_TABLE, m._id, indexStatePatch(m, { retentionStarted: true }));
        }
      },
      true,
    );
    await e.close();
  }
  const { e } = await open(path, indexed);
  await e.indexesReady();
  expect(e.indexWorker!.stats.docsIndexed).toBe(0);
}, 30_000);

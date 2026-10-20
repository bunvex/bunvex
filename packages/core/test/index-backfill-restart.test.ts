// A backfill that starts over (STUDY-174 S1, I-17): its checkpoint's snapshot fell out of retention while it was
// stopped, so it walks the table again from the start at a new snapshot. Its progress starts over with it, as
// Convex's `initialize_backfill` (crates/database/src/bootstrap_model/index_backfills/mod.rs: a fresh start replaces
// the row with `num_docs_indexed: 0`): `numDocsIndexed` never passes the table's count.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { backfillMeta, INDEX_BACKFILLS_TABLE } from "../src/catalog.ts";
import { Engine, type IndexBackfillOptions } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { tsGlobal } from "../src/persistence-globals.ts";
import { RETENTION_GLOBALS } from "../src/retention.ts";
import { defineSchema, defineTable, type EngineSchema } from "../src/schema.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const plain = defineSchema({ items: defineTable(v.any()) });
const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

async function open(path: string, schema: EngineSchema, indexBackfill?: IndexBackfillOptions) {
  return new Engine(schema, await MemoryPersistence.open(path, { durable: false }), { indexBackfill }).init();
}

async function readProgress(e: Engine) {
  const row = (await (e as unknown as { runMutation(b: unknown, system: boolean): Promise<unknown> }).runMutation(
    async (db: { query(t: string): { first(): Promise<unknown> } }) => db.query(INDEX_BACKFILLS_TABLE).first(),
    true,
  )) as Record<string, unknown> | null;
  return row && backfillMeta(row);
}

test("a backfill that starts over at a new snapshot counts its documents from 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backfill-restart-"));
  dirs.push(dir);
  const path = join(dir, "log");
  const N = 3000;
  {
    const e = await open(path, plain);
    await e.mutation(async (db) => {
      for (let i = 0; i < N; i++) await db.insert("items", { n: i % 97 });
    });
    await e.close();
  }
  // A slow first pass (1 000 entries/s, a checkpoint every 50 ms), stopped after its first checkpoint.
  let snapshotTs: bigint;
  let above: bigint;
  {
    const e = await open(path, indexed, { chunkSize: 100, chunkRate: 10, progressIntervalMs: 50 });
    for (let i = 0; i < 400 && (e.indexWorker?.stats.checkpoints ?? 0) === 0; i++) await Bun.sleep(5);
    const before = await readProgress(e);
    expect(before!.numDocsIndexed).toBeGreaterThan(0);
    expect(before!.numDocsIndexed).toBeLessThan(N);
    snapshotTs = before!.cursor!.snapshotTs;
    await e.close(); // the stop checkpoints what it indexed since
    above = e.committer.visibleTs; // the checkpoints are commits after the snapshot
    expect(above).toBeGreaterThan(snapshotTs);
  }
  // Retention moved past the checkpoint's snapshot meanwhile.
  {
    const p = await MemoryPersistence.open(path, { durable: false });
    await p.setGlobal(RETENTION_GLOBALS.minIndexTs, tsGlobal(above));
    await p.close();
  }
  const e = await open(path, indexed, { chunkRate: null });
  await e.indexesReady();
  // It started over: every document indexed again, at a newer snapshot.
  expect(e.indexWorker!.stats.docsIndexed).toBe(N);
  const after = await readProgress(e);
  expect(after!.cursor!.snapshotTs).toBeGreaterThan(snapshotTs);
  expect(after!.numDocsIndexed).toBe(N);
  expect(after!.totalDocs).toBe(N);
  await e.close();
}, 30_000);

test("a backfill shorter than the progress interval records its count when it ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backfill-restart-"));
  dirs.push(dir);
  const path = join(dir, "log");
  const N = 2000;
  {
    const e = await open(path, plain);
    await e.mutation(async (db) => {
      for (let i = 0; i < N; i++) await db.insert("items", { n: i % 97 });
    });
    await e.close();
  }
  // No checkpoint falls inside the pass (1 s apart, Convex's default): the end of the pass records the count,
  // as Convex's `backfill_from_ts` flushes its last progress.
  const e = await open(path, indexed, { chunkSize: 100, chunkRate: null, progressIntervalMs: 60_000 });
  await e.indexesReady();
  expect(e.indexWorker!.stats.docsIndexed).toBe(N);
  const p = await readProgress(e);
  expect(p!.numDocsIndexed).toBe(N);
  expect(p!.totalDocs).toBe(N);
  await e.close();
}, 30_000);

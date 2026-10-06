// Background index backfill (STUDY-29): the engine opens without waiting, queries on an index being built
// fail as Convex's do, concurrent writes are never lost, and a crash mid-backfill resumes from its checkpoint.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { backfillMeta, INDEX_BACKFILLS_TABLE, INDEX_TABLE, indexMeta } from "../src/catalog.ts";
import { Engine, type IndexBackfillOptions } from "../src/engine.ts";
import { prefixEnd } from "../src/keyenc.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { type Doc, defineSchema, defineTable, indexKey, type SchemaDefinition } from "../src/schema.ts";
import { decodeDoc } from "../src/tx.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function logPath() {
  const dir = mkdtempSync(join(tmpdir(), "bunvex-backfill-"));
  dirs.push(dir);
  return join(dir, "log");
}

const plain = defineSchema({ items: defineTable(v.any()) });
const indexed = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
/** Slow enough to observe: `rate` × `chunk` entries a second. */
const scanDelay = { on: true };
const slow = (chunk = 100, rate = 10): IndexBackfillOptions => ({ chunkSize: chunk, chunkRate: rate });

async function open(
  path: string,
  schema: SchemaDefinition,
  indexBackfill?: IndexBackfillOptions,
  /** Delay every range scan (the backfill's reads; the writers below only use point reads): a chunk's
   *  snapshot then stays open long enough for concurrent writes to land in it. */
  scanDelayMs = 0,
) {
  const p = await MemoryPersistence.open(path, { durable: false });
  if (scanDelayMs > 0) {
    const scan = p.scan.bind(p);
    p.scan = (async (...a: Parameters<typeof scan>) => {
      if (scanDelay.on) await new Promise((r) => setTimeout(r, scanDelayMs));
      return scan(...a);
    }) as unknown as typeof p.scan;
  }
  return new Engine(schema, p, { indexBackfill }).init();
}

async function seed(path: string, n: number) {
  const e = await open(path, plain);
  for (let i = 0; i < n; i += 1000)
    await e.mutation(async (db) => {
      for (let j = i; j < Math.min(n, i + 1000); j++) await db.insert("items", { n: j % 97 });
    });
  await e.close();
}

/**
 * The index `items.by_n` at snapshot `ts`, checked against the table straight from persistence: every live
 * document has exactly one entry, at its key, joined to the document's current version (the exact-ts join),
 * and there is no other entry.
 */
async function audit(e: Engine, ts: bigint) {
  const t = e.catalog.table("items");
  const ix = t.indexes.get("by_n") ?? t.pending.find((p) => p.name === "by_n")!;
  const lo = new Uint8Array(0);
  const hi = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
  const docs = await e.persistence.scan(t.id, t.byId.id, lo, hi, ts, 1e9, false);
  const entries = await e.persistence.scan(t.id, ix.id, lo, hi, ts, 1e9, false);
  let wrong = 0;
  for (const d of docs) {
    const k = indexKey(ix, decodeDoc(d.json) as Doc);
    const at = await e.persistence.scan(t.id, ix.id, k, prefixEnd(k), ts, 10, false);
    if (at.length !== 1 || at[0]!.id !== d.id || at[0]!.ts !== d.ts) wrong++;
  }
  return { live: docs.length, entries: entries.length, unique: new Set(entries.map((x) => x.id)).size, wrong };
}

describe("background index backfill (STUDY-29)", () => {
  test("init returns before the backfill ends; queries on the index fail as Convex's until it is enabled", async () => {
    const path = logPath();
    await seed(path, 3000);
    const t0 = performance.now();
    const e = await open(path, indexed, slow()); // 1000 entries/s: about 3 s of backfill
    const initMs = performance.now() - t0;
    expect(initMs).toBeLessThan(1000);
    const byN = (db: Parameters<Parameters<Engine["query"]>[0]>[0]) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 5))
        .collect();
    // Convex's IndexBackfillingError, in a query and in a mutation.
    await expect(e.query(byN)).rejects.toThrow(
      "Index items.by_n is currently backfilling and not available to query yet.",
    );
    await expect(e.mutation(byN)).rejects.toMatchObject({ code: "IndexBackfillingError" });
    // Other reads and writes go on: the table and its other indexes serve as before.
    expect(await e.query((db) => db.query("items").take(5))).toHaveLength(5);
    await e.mutation((db) => db.insert("items", { n: 5 }));
    await e.indexesReady();
    const readyMs = performance.now() - t0;
    expect(readyMs).toBeGreaterThan(initMs * 2);
    expect(await e.query(byN)).toHaveLength(31 + 1); // 3000 docs, n = i % 97 → 31 with n = 5; plus one
    await e.close();
  }, 30_000);

  test("concurrent writers during a backfill: every live document has exactly one entry, at several snapshots", async () => {
    const path = logPath();
    await seed(path, 4000);
    const e = await open(path, indexed, { ...slow(400, 5), readSize: 100 }, 5);
    const ids: string[] = await e.query((db) => db.query("items").collect()).then((d) => d.map((x: Doc) => x._id));
    let stop = false;
    let ops = 0;
    // 16 writers: inserts, updates that move the key, deletes, and re-inserts, spread over the whole table.
    const writers = Array.from({ length: 16 }, async (_, w) => {
      let i = 0;
      while (!stop) {
        const r = (w * 7919 + i++ * 104729) % ids.length;
        const op = i % 4;
        await e.mutation(async (db) => {
          if (op === 0) ids.push(await db.insert("items", { n: (w + i) % 97 }));
          else {
            const id = ids[r];
            if (!id || !(await db.get("items", id))) return;
            if (op === 3) await db.delete("items", id);
            else await db.patch("items", id, { n: (r + i) % 97 });
          }
        });
        ops++;
        await new Promise((r) => setTimeout(r, 2));
      }
    });
    await e.indexesReady();
    const readyTs = e.committer.visibleTs;
    stop = true;
    await Promise.all(writers);
    expect(ops).toBeGreaterThan(200);
    if (process.env.BACKFILL_DEBUG) console.log({ ops, ...e.indexWorker!.stats });
    scanDelay.on = false;
    const snapshots = [readyTs, e.committer.visibleTs];
    // And more writes after the index is enabled.
    for (let i = 0; i < 50; i++) await e.mutation((db) => db.insert("items", { n: i }));
    snapshots.push(e.committer.visibleTs);
    for (const ts of snapshots) {
      const a = await audit(e, ts);
      expect(a).toEqual({ live: a.live, entries: a.live, unique: a.live, wrong: 0 });
    }
    // Through a query too.
    const sixes = await e.query((db) =>
      db
        .query("items")
        .withIndex("by_n", (q) => q.eq("n", 6))
        .collect(),
    );
    const live = await e.query((db) =>
      db
        .query("items")
        .filter((q) => q.eq(q.field("n"), 6))
        .collect(),
    );
    expect(sixes.map((d: Doc) => d._id).sort()).toEqual(live.map((d: Doc) => d._id).sort());
    await e.close();
  }, 60_000);

  test("a crash mid-backfill resumes from the checkpoint and finishes", async () => {
    const path = logPath();
    await seed(path, 6000);
    // A child process opens the store with the new index and is SIGKILLed after its first checkpoint.
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/backfill-child.ts"), path], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (b) => {
        out += b;
        if (out.includes("checkpoint")) {
          child.kill("SIGKILL");
          resolve();
        }
      });
      child.on("exit", (code) => (code === null ? resolve() : reject(new Error(`child exited ${code}: ${out}`))));
    });
    await new Promise((r) => child.on("close", r));
    const e = await open(path, indexed, slow(200, 1000));
    const before = await readProgress(e);
    expect(before?.cursor?.cursor).toBeString(); // the child got somewhere and recorded it
    expect(before!.numDocsIndexed).toBeGreaterThan(0);
    await e.indexesReady();
    // It resumed: this process indexed fewer documents than the table holds.
    expect(e.indexWorker!.stats.docsIndexed).toBeLessThan(6000);
    expect(e.indexWorker!.stats.docsIndexed).toBeGreaterThan(0);
    const a = await audit(e, e.committer.visibleTs);
    expect(a).toEqual({ live: 6000, entries: 6000, unique: 6000, wrong: 0 });
    // The checkpoint stays after the backfill, as Convex's `_index_backfills` row does.
    expect((await readProgress(e))?.cursor?.snapshotTs).toBeGreaterThan(0);
    await e.close();
  }, 60_000);

  test("a changed index keeps serving its old version until the new one is enabled, then swaps atomically", async () => {
    const path = logPath();
    {
      const e = await open(path, defineSchema({ items: defineTable(v.any()).index("by_n", ["a"]) }));
      await e.mutation(async (db) => {
        for (let i = 0; i < 2000; i++) await db.insert("items", { a: i, n: 2000 - i });
      });
      await e.close();
    }
    const e = await open(path, indexed, slow(100, 5));
    const first = () => e.query((db) => db.query("items").withIndex("by_n").first());
    // The old definition (on `a`) still answers, as Convex's enabled index does until the push finishes.
    expect(((await first()) as Doc).a).toBe(0);
    const sub = await e.queryTracked((db) => db.query("items").withIndex("by_n").first());
    await e.indexesReady();
    // The new definition (on `n`) answers, and the old result's reads were invalidated by the swap.
    expect(((await first()) as Doc).n).toBe(1);
    expect(e.committer.changedBetween(sub.reads, sub.ts, e.committer.visibleTs)).toBe(true);
    expect(e.catalog.table("items").pending).toEqual([]);
    await e.close();
  }, 30_000);

  test("a staged index is backfilled but never enabled; it does not hold readiness up", async () => {
    const path = logPath();
    await seed(path, 500);
    const staged = defineSchema({ items: defineTable(v.any()).index("by_n", { fields: ["n"], staged: true }) });
    let e = await open(path, staged);
    await e.indexesReady(); // nothing to wait for
    const q = () => e.query((db) => db.query("items").withIndex("by_n").collect());
    await expect(q()).rejects.toMatchObject({
      code: "IndexStagedError",
      message: "Index items.by_n is currently staged and not available to query until it is enabled.",
    });
    while ((await readState(e)) === "backfilling") await new Promise((r) => setTimeout(r, 20));
    expect(await readState(e)).toBe("backfilled");
    await expect(q()).rejects.toMatchObject({ code: "IndexStagedError" });
    await e.close();
    // Un-staged: enabled at once, without another backfill.
    e = await open(path, indexed);
    await e.indexesReady();
    expect(e.indexWorker).toBeNull();
    expect(await q()).toHaveLength(500);
    await e.close();
    // Staged again: back to backfilled (Convex's `disable_index`).
    e = await open(path, staged);
    await e.indexesReady();
    expect(await readState(e)).toBe("backfilled");
    await expect(q()).rejects.toMatchObject({ code: "IndexStagedError" });
    await e.close();
  }, 30_000);

  test("an index of a new table is backfilled before init returns; an unchanged schema starts no worker", async () => {
    const path = logPath();
    let e = await open(path, indexed);
    // As Convex's, the new table's index was backfilled (an empty pass), then enabled: no wait for it.
    expect(await e.query((db) => db.query("items").withIndex("by_n").collect())).toEqual([]);
    expect(await readState(e)).toBe("enabled");
    await e.close();
    e = await open(path, indexed);
    expect(e.indexWorker).toBeNull();
    await e.close();
  });

  test("a snapshot older than the commit that enabled an index cannot read it", async () => {
    const path = logPath();
    await seed(path, 300);
    const e = await open(path, indexed);
    const before = e.committer.visibleTs;
    await e.indexesReady();
    const r = await e.queryTracked((db) => db.query("items").withIndex("by_n").collect(), {}, before);
    expect(r.ok).toBe(false);
    expect(String((r as { error: unknown }).error)).toContain("currently backfilling");
    await e.close();
  });
});

async function readProgress(e: Engine) {
  const row = (await (e as unknown as { runMutation(b: unknown, system: boolean): Promise<unknown> }).runMutation(
    async (db: { query(t: string): { first(): Promise<unknown> } }) => db.query(INDEX_BACKFILLS_TABLE).first(),
    true,
  )) as Record<string, unknown> | null;
  return row && backfillMeta(row);
}

async function readState(e: Engine) {
  const rows = (await (e as unknown as { runMutation(b: unknown, system: boolean): Promise<unknown> }).runMutation(
    async (db: { query(t: string): { collect(): Promise<unknown> } }) => db.query(INDEX_TABLE).collect(),
    true,
  )) as Record<string, unknown>[];
  const row = rows.find((r) => r.descriptor === "by_n");
  return row && indexMeta(row).state;
}

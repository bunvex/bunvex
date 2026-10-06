// Retention (STUDY-33): the windows, both deleters, the checkpoints, and reads below the window.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v } from "@bunvex/values";
import { OutOfRetentionError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { SqlitePersistence } from "../src/persistence/sqlite.ts";
import { tsGlobal } from "../src/persistence-globals.ts";
import { RETENTION_GLOBALS, Retention, type RetentionOptions } from "../src/retention.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });
const engines: Engine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "bunvex-retention-"));
  dirs.push(d);
  return d;
};

/** The loops wait (a long interval); tests drive the passes themselves. */
const manual: RetentionOptions = {
  background: false,
  indexDelayMs: 0,
  documentDelayMs: 0,
  advanceEveryMs: 3_600_000,
  documentEveryMs: 3_600_000,
  checkpointEveryMs: 0,
  documentRatePerSec: 1e9,
};

async function open(path = ":memory:", retention: RetentionOptions = manual) {
  const p = new SqlitePersistence(path, { durable: false });
  const e = await new Engine(schema, p, { retention }).init();
  engines.push(e);
  return { e, p, db: (p as unknown as { db: import("bun:sqlite").Database }).db };
}

/** Every version and tombstone a store keeps beyond the newest live row of each key. */
function garbage(db: import("bun:sqlite").Database) {
  const n = (q: string) => (db.query(q).get() as { n: number }).n;
  return {
    oldDocs: n(`select count(*) as n from (select 1 from documents group by table_id, id having count(*) > 1)`),
    deadDocs: n(`select count(*) as n from documents where deleted = 1`),
    oldIdx: n(`select count(*) as n from (select 1 from indexes group by index_id, key having count(*) > 1)`),
    deadIdx: n(`select count(*) as n from indexes where deleted = 1`),
  };
}

/** Rewrites, key moves and deletes: plenty of superseded versions and tombstones. */
async function churn(e: Engine) {
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push((await e.mutation((db) => db.insert("items", { n: i }))) as string);
  for (let r = 0; r < 5; r++)
    for (const [i, id] of ids.entries()) await e.mutation((db) => db.patch(id, { n: i + r * 100, r }));
  for (const id of ids.slice(0, 10)) await e.mutation((db) => db.delete(id));
  // Created and deleted in one transaction: a tombstone with nothing before it.
  await e.mutation(async (db) => db.delete(await db.insert("items", { n: -1 })));
  return ids;
}

const answers = (e: Engine) =>
  e.query(async (db) => ({
    all: await db.query("items").collect(),
    byN: await db
      .query("items")
      .withIndex("by_n", (q) => q.gte("n", 100))
      .order("desc")
      .take(7),
  }));

describe("retention", () => {
  test("prunes every superseded version and tombstone below the window; answers at it are unchanged", async () => {
    const { e, db } = await open();
    await churn(e);
    const before = await answers(e);
    const g0 = garbage(db);
    expect(g0.oldDocs).toBeGreaterThan(0);
    expect(g0.deadIdx).toBeGreaterThan(0);
    const r = e.retention!;
    await r.advance();
    expect(r.minIndexTs).toBe(e.committer.visibleTs);
    await r.deleteIndexes();
    await r.deleteDocuments();
    expect(garbage(db)).toEqual({ oldDocs: 0, deadDocs: 0, oldIdx: 0, deadIdx: 0 });
    expect(await answers(e)).toEqual(before);
    expect(r.stats.indexRowsDeleted).toBeGreaterThan(0);
    expect(r.stats.documentRowsDeleted).toBeGreaterThan(0);
    // Writing on after pruning works, and a second round prunes what it superseded.
    const [id] = (await answers(e)).all.map((d) => d._id as string);
    await e.mutation((db) => db.patch(id, { n: 9999 }));
    await r.advance();
    await r.deleteIndexes();
    await r.deleteDocuments();
    expect(garbage(db)).toEqual({ oldDocs: 0, deadDocs: 0, oldIdx: 0, deadIdx: 0 });
    expect((await e.query((db) => db.get(id)))?.n).toBe(9999);
  });

  test("nothing at or above the window is pruned: it trails the newest commit by the delay", async () => {
    const { e, db } = await open(":memory:", { ...manual, indexDelayMs: 3_600_000, documentDelayMs: 3_600_000 });
    await churn(e);
    const g0 = garbage(db);
    await e.retention!.advance();
    await e.retention!.deleteIndexes();
    await e.retention!.deleteDocuments();
    expect(garbage(db)).toEqual(g0);
    expect(e.retention!.minIndexTs).toBe(e.committer.visibleTs - 3_600_000_000);
  });

  test("a transaction whose snapshot falls below the window fails its next read with OutOfRetention", async () => {
    const { e } = await open();
    const [id] = await churn(e);
    let release!: () => void;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    let runs = 0;
    const slow = e.query(async (db) => {
      runs++;
      await db.get(id);
      await gate;
      return db.query("items").collect();
    });
    await Bun.sleep(5);
    await e.mutation((db) => db.insert("items", { n: 5 })); // the window moves past the slow snapshot
    await e.retention!.advance();
    await e.retention!.deleteIndexes();
    release();
    const err = await slow.then(
      () => null,
      (x) => x,
    );
    expect(err).toBeInstanceOf(OutOfRetentionError);
    expect((err as Error).message).toMatch(/^Index snapshot timestamp out of leader retention window: \d+ < \d+$/);
    expect(runs).toBe(1); // not retried as an OCC conflict
    // A fresh transaction reads at the newest snapshot, inside the window.
    expect((await e.query((db) => db.query("items").collect())).length).toBeGreaterThan(0);
  });

  test("a read that raced a prune fails its check after the read (Convex's final validate_snapshot)", async () => {
    const { e, p } = await open();
    const id = (await churn(e))[20]; // a live one (churn deletes the first ten)
    // The store answers the first get of it only once the gate opens: the prune lands in the middle of the read.
    let release!: () => void;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    let entered!: () => void;
    const inRead = new Promise<void>((ok) => {
      entered = ok;
    });
    const get = p.get.bind(p);
    let held = false;
    p.get = ((table: number, docId: string, ts: number) => {
      if (docId !== id || held) return get(table, docId, ts);
      held = true;
      entered();
      return gate.then(() => get(table, docId, ts));
    }) as typeof p.get;
    const read = e.query((db) => db.get(id));
    await inRead;
    await e.mutation((db) => db.patch(id, { n: 777 }));
    await e.retention!.advance();
    await e.retention!.deleteIndexes();
    await e.retention!.deleteDocuments();
    release();
    expect(
      await read.then(
        () => null,
        (x) => x,
      ),
    ).toBeInstanceOf(OutOfRetentionError);
  });

  test("the windows only move forward, the document window never above the index window", async () => {
    const { e } = await open(":memory:", { ...manual, indexDelayMs: 1000, documentDelayMs: 0 });
    await churn(e);
    const r = e.retention!;
    await r.advance();
    expect(r.minIndexTs).toBe(e.committer.visibleTs - 1_000_000);
    expect(r.minDocumentTs).toBe(r.minIndexTs);
    const was = r.minIndexTs;
    r.opts.indexDelayMs = 10_000_000; // a longer delay never moves a window back
    await r.advance();
    expect(r.minIndexTs).toBe(was);
  });

  test("a window is recorded before it is used: a failed write leaves it where it was", async () => {
    const { e, p } = await open();
    await churn(e);
    const r = e.retention!;
    const set = p.setGlobal.bind(p);
    p.setGlobal = () => {
      throw new Error("store down");
    };
    const was = r.minIndexTs;
    await expect(r.advance()).rejects.toThrow("store down");
    expect(r.minIndexTs).toBe(was);
    p.setGlobal = set;
    await r.advance();
    expect(p.getGlobal(RETENTION_GLOBALS.minIndexTs)).toEqual(tsGlobal(r.minIndexTs));
    expect(p.getGlobal(RETENTION_GLOBALS.minDocumentTs)).toEqual(tsGlobal(r.minDocumentTs));
  });

  test("the windows and cursors are reloaded on restart", async () => {
    const path = join(tmp(), "db.sqlite");
    const a = await open(path);
    await churn(a.e);
    await a.e.retention!.advance();
    await a.e.retention!.deleteIndexes();
    await a.e.retention!.deleteDocuments();
    const saved = {
      minIndexTs: a.e.retention!.minIndexTs,
      minDocumentTs: a.e.retention!.minDocumentTs,
      indexCursor: a.e.retention!.indexCursor,
      documentCursor: a.e.retention!.documentCursor,
    };
    expect(saved.indexCursor).toBe(saved.minIndexTs);
    await a.e.close();
    engines.splice(engines.indexOf(a.e), 1);
    // A long delay on reopen: the recorded windows hold, they are not recomputed lower.
    const b = await open(path, { ...manual, indexDelayMs: 3_600_000, documentDelayMs: 3_600_000 });
    const r = b.e.retention!;
    expect({
      minIndexTs: r.minIndexTs,
      minDocumentTs: r.minDocumentTs,
      indexCursor: r.indexCursor,
      documentCursor: r.documentCursor,
    }).toEqual(saved);
  });

  test("the loops run on their own: churn while they prune, reads always answer as the model", async () => {
    const p = await MemoryPersistence.open(null, { durable: false });
    const e = await new Engine(schema, p, {
      retention: {
        indexDelayMs: 20,
        documentDelayMs: 40,
        advanceEveryMs: 5,
        documentEveryMs: 5,
        documentRatePerSec: 1e9,
      },
    }).init();
    engines.push(e);
    const model = new Map<string, number>();
    const ids: string[] = [];
    for (let step = 0; step < 600; step++) {
      const r = Math.random();
      if (r < 0.3 || ids.length < 5) {
        const n = Math.floor(Math.random() * 50);
        const id = (await e.mutation((db) => db.insert("items", { n }))) as string;
        ids.push(id);
        model.set(id, n);
      } else if (r < 0.8) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        if (!model.has(id)) continue;
        const n = Math.floor(Math.random() * 50);
        await e.mutation((db) => db.patch(id, { n }));
        model.set(id, n);
      } else {
        const id = ids[Math.floor(Math.random() * ids.length)];
        if (!model.has(id)) continue;
        await e.mutation((db) => db.delete(id));
        model.delete(id);
      }
      if (step % 50 === 49) {
        const got = await e.query(async (db) =>
          (await db.query("items").withIndex("by_n").collect()).map((d) => [d._id, d.n]),
        );
        const want = [...model].sort((x, y) => x[1] - y[1] || 0);
        expect(new Map(got as [string, number][])).toEqual(new Map(want));
        expect(got.map((x) => x[1])).toEqual(want.map((x) => x[1]));
        await Bun.sleep(30);
      }
    }
    await Bun.sleep(100);
    expect(e.retention!.stats.advances).toBeGreaterThan(0);
    expect(e.retention!.stats.indexRowsDeleted).toBeGreaterThan(0);
    expect(e.retention!.stats.documentRowsDeleted).toBeGreaterThan(0);
    expect(e.retention!.stats.errors).toBe(0);
    const { docs, idx } = p.auditRowCount();
    expect(docs).toBeLessThan(600);
    expect(idx).toBeLessThan(1800);
  });

  test("the document deleter keeps to its rate", async () => {
    const { e } = await open(":memory:", { ...manual, documentRatePerSec: 400, documentChunk: 50 });
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push((await e.mutation((db) => db.insert("items", { n: i }))) as string);
    for (const id of ids) await e.mutation((db) => db.patch(id, { n: -1 }));
    await e.retention!.advance();
    const t0 = performance.now();
    await e.retention!.deleteDocuments();
    // 200+ document versions at 400 a second take at least half a second.
    expect(performance.now() - t0).toBeGreaterThan(450);
    expect(e.retention!.stats.documentRowsDeleted).toBeGreaterThanOrEqual(100);
  });

  test("a pass stops at its cap and the next one continues where it stopped", async () => {
    const { e } = await open(":memory:", { ...manual, maxPerPass: 20 });
    await churn(e);
    const r = e.retention!;
    await r.advance();
    expect(await r.deleteIndexes()).toBe(true);
    expect(r.indexCursor).toBeLessThan(r.minIndexTs);
    while (await r.deleteIndexes());
    expect(r.indexCursor).toBe(r.minIndexTs);
  });

  test("Convex's defaults, and the delays from the environment in seconds", () => {
    const r = new Retention({} as never, {} as never);
    expect(r.opts).toMatchObject({
      indexDelayMs: 240_000,
      documentDelayMs: 14 * 86_400_000,
      advanceEveryMs: 30_000,
      indexChunk: 512,
      documentChunk: 256,
      maxPerPass: 10_000,
      documentRatePerSec: 256,
      documentEveryMs: 60_000,
      checkpointEveryMs: 300_000,
      maxBackoffMs: 60_000,
    });
    process.env.INDEX_RETENTION_DELAY = "60";
    process.env.DOCUMENT_RETENTION_DELAY = "172800";
    try {
      const r2 = new Retention({} as never, {} as never);
      expect(r2.opts.indexDelayMs).toBe(60_000);
      expect(r2.opts.documentDelayMs).toBe(172_800_000);
      process.env.INDEX_RETENTION_DELAY = "soon";
      expect(() => new Retention({} as never, {} as never)).toThrow(
        "INDEX_RETENTION_DELAY must be a number of seconds",
      );
    } finally {
      delete process.env.INDEX_RETENTION_DELAY;
      delete process.env.DOCUMENT_RETENTION_DELAY;
    }
  });

  test("close stops the loops", async () => {
    const { e } = await open(":memory:", { ...manual, background: true, advanceEveryMs: 1 });
    await churn(e);
    await Bun.sleep(20);
    const r = e.retention!;
    await e.close();
    engines.splice(engines.indexOf(e), 1);
    const n = r.stats.advances;
    await Bun.sleep(30);
    expect(r.stats.advances).toBe(n);
  });
});

// OCC retries and the OCC error, as Convex (STUDY-21): 4 retries (5 executions) with full-jitter backoff
// from 100 ms to 2 s, a wait for the conflicting write, and `OptimisticConcurrencyControlFailure`.
import { expect, test } from "bun:test";
import { Committer, ConflictError } from "../src/committer.ts";
import {
  Engine,
  OCC_INITIAL_BACKOFF_MS,
  OCC_MAX_BACKOFF_MS,
  OCC_MAX_RETRIES,
  OccError,
  occBackoffMs,
} from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { Schema } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

const schema = new Schema().table("counters", {});

test("Convex's budget: 4 retries, 100 ms doubling up to 2 s, full jitter", () => {
  expect([OCC_MAX_RETRIES, OCC_INITIAL_BACKOFF_MS, OCC_MAX_BACKOFF_MS]).toEqual([4, 100, 2000]);
  const top = [0, 1, 2, 3, 4, 5, 40].map((n) => occBackoffMs(n, 100, 2000, () => 1));
  expect(top).toEqual([100, 200, 400, 800, 1600, 2000, 2000]);
  expect(occBackoffMs(3, 100, 2000, () => 0)).toBe(0);
  expect(occBackoffMs(3, 100, 2000, () => 0.5)).toBe(400);
});

/**
 * A mutation on `id` that loses every race: each execution reads the counter, then waits while another
 * mutation (`m:other`) commits a write to it. Returns how many times it ran and what it threw.
 */
async function alwaysLoses(engine: Engine, id: string, source: string) {
  let runs = 0;
  const box: { wake: (() => void) | null } = { wake: null };
  let stop = false;
  const rival = (async () => {
    while (!stop) {
      const w = box.wake;
      if (!w) {
        await new Promise((r) => setImmediate(r));
        continue;
      }
      box.wake = null;
      await engine.mutation(async (db) => db.patch("counters", id, { n: Math.random() }), "m:other");
      w();
    }
  })();
  let error: unknown;
  try {
    await engine.mutation(async (db: Tx) => {
      runs++;
      await db.get("counters", id);
      await new Promise<void>((r) => (box.wake = r));
      await db.patch("counters", id, { n: -1 });
    }, source);
  } catch (e) {
    error = e;
  }
  stop = true;
  await rival;
  return { runs, error };
}

test("a mutation that always conflicts runs 5 times, then fails with Convex's OCC error", async () => {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    occInitialBackoffMs: 1,
    occMaxBackoffMs: 2,
  }).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  const { runs, error } = await alwaysLoses(engine, id, "m:bump");
  expect(runs).toBe(5);
  expect(engine.stats.retries).toBe(4);
  expect(error).toBeInstanceOf(OccError);
  const e = error as OccError;
  expect(e.code).toBe("OptimisticConcurrencyControlFailure");
  expect(e.message).toBe(
    `Documents read from or written to the "counters" table changed while this mutation was being run and on every subsequent retry. A call to "m:other" changed the document with ID "${id}".`,
  );
  expect(e.info).toMatchObject({ table: "counters", documentId: id, writeSource: "m:other" });
});

test("the same mutation on both sides is 'Another call to this mutation'; an unnamed writer is not cited", async () => {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    maxRetries: 0,
  }).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  const same = await alwaysLoses(engine, id, "m:other");
  expect((same.error as OccError).message).toEndWith(
    `retry. Another call to this mutation changed the document with ID "${id}".`,
  );
  const anon = await alwaysLoses(engine, id, undefined as never);
  expect((anon.error as OccError).message).toEndWith(
    'retry. A call to "m:other" changed the document with ID ' + `"${id}".`,
  );
});

test("maxRetries is honoured, and the default backoff really waits (100 ms scale)", async () => {
  const engine = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
    maxRetries: 1,
  }).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  const saved = Math.random;
  Math.random = () => 1; // the backoff draws its jitter outside the execution: take the full 100 ms
  const t0 = performance.now();
  let r: Awaited<ReturnType<typeof alwaysLoses>>;
  try {
    r = await alwaysLoses(engine, id, "m:bump");
  } finally {
    Math.random = saved;
  }
  expect(r.runs).toBe(2);
  expect(r.error).toBeInstanceOf(OccError);
  expect(performance.now() - t0).toBeGreaterThanOrEqual(95);
});

test("a conflict reports the write it lost to; waitForVisible resolves once that ts is visible", async () => {
  const p = await MemoryPersistence.open(null, { durable: false });
  const c = new Committer(p);
  const k = new Uint8Array([1]);
  const reads = [{ index: 9, lo: k, hi: new Uint8Array([2]) }];
  const ts1 = await c.commit({
    snapshot: 0,
    reads: [],
    docs: [],
    idx: [{ index: 9, key: k, id: "doc1" }],
    source: "m:w",
  });
  const lost = await c.commit({ snapshot: 0, reads, docs: [], idx: [] }).catch((e) => e);
  expect(lost).toBeInstanceOf(ConflictError);
  expect(lost.conflict).toEqual({ writeTs: ts1, index: 9, id: "doc1", source: "m:w" });
  await c.waitForVisible(ts1); // already visible: resolves at once
  let woke = false;
  const waiting = c.waitForVisible(ts1 + 1).then(() => (woke = true));
  await new Promise((r) => setImmediate(r));
  expect(woke).toBe(false);
  await c.commit({ snapshot: ts1, reads: [], docs: [], idx: [{ index: 9, key: k, id: "doc1" }] });
  await waiting;
  expect(woke).toBe(true);
});

test("a retry first waits for the write it lost to, so it does not lose to it again", async () => {
  const inner = await MemoryPersistence.open(null, { durable: false });
  const p = Object.create(inner) as typeof inner;
  let slow = false;
  p.flush = async () => {
    if (slow) await new Promise((r) => setTimeout(r, 30)); // the group that holds the winner is slow to flush
    return inner.flush();
  };
  const engine = await new Engine(schema, p).init();
  const id = await engine.mutation((db) => db.insert("counters", { n: 0 }));
  slow = true;
  let runs = 0;
  const bump = (count: boolean) => async (db: Tx) => {
    if (count) runs++;
    const d = (await db.get("counters", id)) as unknown as { n: number };
    await db.patch("counters", id, { n: d.n + 1 });
  };
  const saved = Math.random;
  Math.random = () => 0; // no backoff sleep: only the wait for the winner's write stands between retries
  try {
    // Both commit in one group: the first wins, the second conflicts with a write not yet visible.
    await Promise.all([engine.mutation(bump(false)), engine.mutation(bump(true))]);
  } finally {
    Math.random = saved;
  }
  expect(runs).toBe(2);
  expect(((await engine.query((db) => db.get("counters", id))) as unknown as { n: number }).n).toBe(2);
});

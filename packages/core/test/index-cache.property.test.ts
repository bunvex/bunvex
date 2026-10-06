// STUDY-136: the index cache against a model, under random interleavings of reads and commits — the
// counterpart of Convex's shuttle tests (crates/indexing/src/index_cache/shuttle_tests.rs), whose invariant
// is that a read never gets a stale page. Here a read is a `scan` at a snapshot whose persistence call stays
// pending until the scheduler resolves it, so commits, other reads of the same key and write-log purges land
// between a read's start and its fill. Every completed read must equal the model's scan at its snapshot.
import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Committer, Interval } from "../src/committer.ts";
import { IndexCache } from "../src/index-cache.ts";
import { runs } from "./property-runs.ts";

/** A write log as the committer keeps it, with a naive `changedBetween` (the real one is tested elsewhere). */
class FakeLog {
  visibleTs = 0n;
  purgedTs = 0n;
  writes: { ts: bigint; index: string; key: number }[] = [];
  changedBetween(reads: Interval[], from: bigint, to: bigint): boolean {
    if (to > this.visibleTs) throw new Error("past visible");
    if (from >= to) return false;
    if (from < this.purgedTs) return true;
    return this.writes.some(
      (w) =>
        w.ts > from && w.ts <= to && reads.some((r) => r.index === w.index && w.key >= r.lo[0]! && w.key < r.hi[0]!),
    );
  }
}

/** The store: per index, key → its versions (ts, value), oldest first. */
type Store = Map<string, Map<number, { ts: bigint; value: number }[]>>;
const scanAt = (store: Store, index: string, lo: number, hi: number, ts: bigint, limit: number) => {
  const out: [number, number][] = [];
  const keys = [...(store.get(index)?.keys() ?? [])].sort((a, b) => a - b);
  for (const k of keys) {
    if (k < lo || k >= hi) continue;
    const v = store
      .get(index)!
      .get(k)!
      .filter((x) => x.ts <= ts)
      .at(-1);
    if (v) out.push([k, v.value]);
    if (out.length === limit) break;
  }
  return out;
};

const op = fc.oneof(
  // A commit: one key of one index gets a new value.
  fc.record({
    t: fc.constant("commit" as const),
    index: fc.constantFrom("a", "b"),
    key: fc.integer({ min: 0, max: 7 }),
  }),
  // A read starts at a snapshot `back` commits behind the visible ts.
  fc.record({
    t: fc.constant("read" as const),
    index: fc.constantFrom("a", "b"),
    lo: fc.integer({ min: 0, max: 7 }),
    len: fc.integer({ min: 1, max: 4 }),
    limit: fc.integer({ min: 1, max: 3 }),
    back: fc.integer({ min: 0, max: 3 }),
  }),
  // One pending persistence read returns (which one: an index into the pending list).
  fc.record({ t: fc.constant("resolve" as const), which: fc.nat() }),
  // The write log is purged up to some commit.
  fc.record({ t: fc.constant("purge" as const), back: fc.integer({ min: 0, max: 4 }) }),
);

test("a read through the index cache always equals the store's scan at its snapshot", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 60 }), async (ops) => {
      const log = new FakeLog();
      const cache = new IndexCache(log as unknown as Committer, 1 << 20);
      const store: Store = new Map();
      const commitTs: bigint[] = [0n];
      const pending: (() => void)[] = [];
      const done: Promise<void>[] = [];
      let n = 0;
      for (const o of ops) {
        if (o.t === "commit") {
          const ts = log.visibleTs + 1n + BigInt(n++ % 3); // gaps between commit timestamps too
          const keys = store.get(o.index) ?? new Map();
          store.set(o.index, keys);
          keys.set(o.key, [...(keys.get(o.key) ?? []), { ts, value: n }]);
          log.writes.push({ ts, index: o.index, key: o.key });
          log.visibleTs = ts;
          commitTs.push(ts);
        } else if (o.t === "read") {
          const ts = commitTs[Math.max(0, commitTs.length - 1 - o.back)]!;
          const hi = o.lo + o.len;
          const interval: Interval = { index: o.index, lo: Uint8Array.of(o.lo), hi: Uint8Array.of(hi) };
          const expected = scanAt(store, o.index, o.lo, hi, ts, o.limit);
          const key = `${o.index}|${o.lo}|${hi}|${o.limit}`;
          done.push(
            cache
              .read(
                key,
                interval,
                ts,
                // The persistence read: answers as of `ts` (as a store does), when the scheduler lets it.
                () =>
                  new Promise<[number, number][]>((resolve) =>
                    pending.push(() => resolve(scanAt(store, o.index, o.lo, hi, ts, o.limit))),
                  ),
                (v) => v.length * 16,
                (a, b) => JSON.stringify(a) === JSON.stringify(b),
              )
              .then((got) => expect(got).toEqual(expected)),
          );
        } else if (o.t === "resolve") {
          if (pending.length > 0) pending.splice(o.which % pending.length, 1)[0]!();
        } else {
          log.purgedTs = commitTs[Math.max(0, commitTs.length - 1 - o.back)]!;
        }
        await Promise.resolve();
      }
      while (pending.length > 0) {
        pending.shift()!();
        await Promise.resolve();
      }
      await Promise.all(done);
    }),
    { numRuns: runs(500) },
  );
});

test("hits, stale entries and the byte bound", async () => {
  const log = new FakeLog();
  const cache = new IndexCache(log as unknown as Committer, 4000);
  const iv = (lo: number, hi: number): Interval => ({ index: "a", lo: Uint8Array.of(lo), hi: Uint8Array.of(hi) });
  let reads = 0;
  const read = (v: string) => () => {
    reads++;
    return v;
  };
  const r = (key: string, i: Interval, ts: bigint, v: string) =>
    cache.read(
      key,
      i,
      ts,
      read(v),
      (s) => s.length,
      (a, b) => a === b,
    );

  log.visibleTs = 10n;
  expect(await r("k", iv(0, 4), 10n, "v1")).toBe("v1"); // fill at 10
  log.writes.push({ ts: 11n, index: "a", key: 7 }); // outside [0, 4)
  log.visibleTs = 11n;
  expect(await r("k", iv(0, 4), 11n, "x")).toBe("v1"); // hit at a later ts
  expect(await r("k", iv(0, 4), 9n, "x")).toBe("v1"); // and at an earlier one: nothing changed in (9, 11]
  log.writes.push({ ts: 12n, index: "a", key: 2 }); // inside
  log.visibleTs = 12n;
  expect(await r("k", iv(0, 4), 12n, "v2")).toBe("v2"); // stale, re-read
  expect(await r("k", iv(0, 4), 11n, "v1")).toBe("v1"); // the entry is at 12 now: 11 is behind the write
  expect(cache.stats).toMatchObject({ hits: 2, stale: 2, misses: 3 });
  expect(reads).toBe(3);

  log.purgedTs = 12n;
  log.visibleTs = 13n;
  expect(await r("k", iv(0, 4), 13n, "v3")).toBe("v3"); // the log no longer covers (11, 13]: a miss

  // The byte bound evicts the least recently used.
  for (let i = 0; i < 20; i++) await r(`e${i}`, iv(0, 4), 13n, "y".repeat(150));
  expect(cache.stats.bytes).toBeLessThanOrEqual(4000);
  expect(cache.stats.entries).toBeLessThan(21);
});

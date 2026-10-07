// STUDY-136: the index cache against a model, under random interleavings of reads and commits — the
// counterpart of Convex's shuttle tests (crates/indexing/src/index_cache/shuttle_tests.rs), whose invariant
// is that a read never gets a stale page. Here a read (a `scan` or a `get`) is made at a snapshot, and its
// persistence call stays pending until the scheduler resolves it, so commits, other reads of the same key
// and write-log purges land between a read's start and its fill. Every completed read must equal the
// model's answer at its snapshot.
import { expect, test } from "bun:test";
import fc from "fast-check";
import type { Interval } from "../src/committer.ts";
import { IndexCache, IndexCacheMismatchError } from "../src/index-cache.ts";
import type { DocVersion, IndexedDoc } from "../src/persistence/index.ts";
import { runs } from "./property-runs.ts";

/** A write log as the committer keeps it, with a naive `changedBetween` (the real one has its own tests). */
class FakeLog {
  visibleTs = 0n;
  purgedTs = 0n;
  writes: { ts: bigint; index: string; key: number }[] = [];
  changedBetween(reads: Interval[], from: bigint, to: bigint): boolean {
    if (to > this.visibleTs) throw new Error("past the visible ts");
    if (from >= to) return false;
    if (from < this.purgedTs) return true;
    return this.writes.some(
      (w) =>
        w.ts > from && w.ts <= to && reads.some((r) => r.index === w.index && w.key >= r.lo[0]! && w.key < r.hi[0]!),
    );
  }
}

/** The store: per index, key → its versions, oldest first (a null value: deleted). */
type Store = Map<string, Map<number, { ts: bigint; value: number | null }[]>>;
const at = (store: Store, index: string, key: number, ts: bigint) =>
  store
    .get(index)
    ?.get(key)
    ?.filter((x) => x.ts <= ts)
    .at(-1);
const scanAt = (store: Store, index: string, lo: number, hi: number, ts: bigint, limit: number, desc: boolean) => {
  const out: IndexedDoc[] = [];
  const keys = [...(store.get(index)?.keys() ?? [])].sort((a, b) => (desc ? b - a : a - b));
  for (const k of keys) {
    if (k < lo || k >= hi) continue;
    const v = at(store, index, k, ts);
    if (v && v.value !== null) out.push({ id: `d${k}`, ts: v.ts, json: String(v.value) });
    if (out.length === limit) break;
  }
  return out;
};
const getAt = (store: Store, index: string, key: number, ts: bigint): DocVersion => {
  const v = at(store, index, key, ts);
  return v && v.value !== null ? { ts: v.ts, json: String(v.value) } : null;
};

const index = fc.constantFrom("a", "b");
const op = fc.oneof(
  // A commit: one key of one index gets a new value, or is deleted.
  fc.record({ t: fc.constant("commit" as const), index, key: fc.integer({ min: 0, max: 7 }), del: fc.boolean() }),
  // A scan starts at a snapshot `back` commits behind the visible ts.
  fc.record({
    t: fc.constant("scan" as const),
    index,
    lo: fc.integer({ min: 0, max: 7 }),
    len: fc.integer({ min: 1, max: 4 }),
    limit: fc.integer({ min: 1, max: 3 }),
    desc: fc.boolean(),
    back: fc.integer({ min: 0, max: 3 }),
  }),
  // A get by id: a point in the index.
  fc.record({
    t: fc.constant("get" as const),
    index,
    key: fc.integer({ min: 0, max: 7 }),
    back: fc.integer({ min: 0, max: 3 }),
  }),
  // One pending persistence read returns (which one: an index into the pending list).
  fc.record({ t: fc.constant("resolve" as const), which: fc.nat() }),
  // The write log is purged up to some commit.
  fc.record({ t: fc.constant("purge" as const), back: fc.integer({ min: 0, max: 4 }) }),
);

test("a read through the index cache always equals the store's answer at its snapshot", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(op, { maxLength: 80 }),
      fc.boolean(),
      fc.integer({ min: 2000, max: 1 << 16 }),
      async (ops, verify, maxBytes) => {
        const log = new FakeLog();
        // A small budget evicts in the middle of a run, a large one never; verification re-reads every hit.
        const cache = new IndexCache(log, maxBytes, verify ? 100 : 0);
        const store: Store = new Map();
        const commitTs: bigint[] = [0n];
        const pending: (() => void)[] = [];
        const done: Promise<void>[] = [];
        // The persistence read: answers as of its snapshot (as a store does), when the scheduler lets it.
        const later =
          <T>(answer: () => T) =>
          () =>
            new Promise<T>((resolve) => pending.push(() => resolve(answer())));
        let n = 0;
        for (const o of ops) {
          if (o.t === "commit") {
            const ts = log.visibleTs + 1n + BigInt(n++ % 3); // gaps between commit timestamps too
            const keys = store.get(o.index) ?? new Map();
            store.set(o.index, keys);
            keys.set(o.key, [...(keys.get(o.key) ?? []), { ts, value: o.del ? null : n }]);
            log.writes.push({ ts, index: o.index, key: o.key });
            log.visibleTs = ts;
            commitTs.push(ts);
          } else if (o.t === "scan") {
            const ts = commitTs[Math.max(0, commitTs.length - 1 - o.back)]!;
            const hi = o.lo + o.len;
            const expected = scanAt(store, o.index, o.lo, hi, ts, o.limit, o.desc);
            const read = later(() => scanAt(store, o.index, o.lo, hi, ts, o.limit, o.desc));
            done.push(
              cache
                .scan(o.index, Uint8Array.of(o.lo), Uint8Array.of(hi), o.limit, o.desc, ts, read)
                .then((got) => expect(got).toEqual(expected)),
            );
          } else if (o.t === "get") {
            const ts = commitTs[Math.max(0, commitTs.length - 1 - o.back)]!;
            const expected = getAt(store, o.index, o.key, ts);
            const read = later(() => getAt(store, o.index, o.key, ts));
            done.push(
              cache
                .get(o.index, Uint8Array.of(o.key), Uint8Array.of(o.key + 1), ts, read)
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
        expect(cache.stats.mismatches).toBe(0);
        expect(cache.bytes).toBeLessThanOrEqual(maxBytes);
      },
    ),
    { numRuns: runs(500) },
  );
});

const row = (json: string): IndexedDoc[] => [{ id: "d", ts: 1n, json }];

test("hits at later and earlier snapshots, stale entries, the purged log", async () => {
  const log = new FakeLog();
  const cache = new IndexCache(log, 1 << 20);
  let reads = 0;
  const scan = (ts: bigint, json: string) =>
    cache.scan("a", Uint8Array.of(0), Uint8Array.of(4), 10, false, ts, () => {
      reads++;
      return row(json);
    });

  log.visibleTs = 10n;
  expect(await scan(10n, "v1")).toEqual(row("v1")); // filled at 10
  log.writes.push({ ts: 11n, index: "a", key: 7 }); // outside [0, 4)
  log.writes.push({ ts: 11n, index: "b", key: 2 }); // another index
  log.visibleTs = 11n;
  expect(await scan(11n, "x")).toEqual(row("v1")); // a hit at a later ts
  expect(await scan(9n, "x")).toEqual(row("v1")); // and at an earlier one: nothing changed in (9, 11]
  log.writes.push({ ts: 12n, index: "a", key: 2 }); // inside
  log.visibleTs = 12n;
  expect(await scan(12n, "v2")).toEqual(row("v2")); // stale: read again
  expect(await scan(11n, "v1")).toEqual(row("v1")); // the entry is at 12 now, and 11 is behind the write
  expect(cache.stats).toMatchObject({ hits: 2, misses: { new: 1, stale: 2 } });
  expect(reads).toBe(3);

  log.purgedTs = 12n;
  log.visibleTs = 13n;
  expect(await scan(13n, "v3")).toEqual(row("v3")); // the log no longer covers (11, 13]: read again
  expect(reads).toBe(4);
  // A snapshot past the visible ts is never served from, nor stored.
  expect(await scan(14n, "v4")).toEqual(row("v4"));
  expect(await scan(13n, "x")).toEqual(row("v3"));
});

test("the byte budget evicts the least recently used; a read too big is not kept", async () => {
  const log = new FakeLog();
  log.visibleTs = 1n;
  const cache = new IndexCache(log, 8000);
  const fill = (k: number, json: string) =>
    cache.scan("a", Uint8Array.of(k), Uint8Array.of(k + 1), 1, false, 1n, () => row(json));
  for (let k = 0; k < 40; k++) await fill(k, "y".repeat(100));
  expect(cache.bytes).toBeLessThanOrEqual(8000);
  expect(cache.stats.evictions).toBeGreaterThan(0);
  const before = cache.entries;
  await fill(200, "z".repeat(1000)); // > 8000 / 16
  expect(cache.entries).toBe(before);
  // The newest are kept, the oldest went first.
  let reads = 0;
  const again = () => {
    reads++;
    return row("again");
  };
  await cache.scan("a", Uint8Array.of(39), Uint8Array.of(40), 1, false, 1n, again);
  await cache.scan("a", Uint8Array.of(0), Uint8Array.of(1), 1, false, 1n, again);
  expect(reads).toBe(1);
});

test("verification: a hit that differs from persistence fails the read, and the entry is dropped", async () => {
  const log = new FakeLog();
  log.visibleTs = 1n;
  const cache = new IndexCache(log, 1 << 20, 100);
  let truth = "v1";
  const scan = () => cache.scan("a", Uint8Array.of(0), Uint8Array.of(4), 10, false, 1n, () => row(truth));
  expect(await scan()).toEqual(row("v1"));
  expect(await scan()).toEqual(row("v1")); // verified, equal
  truth = "changed behind the write log's back";
  const err = console.error;
  console.error = () => {};
  try {
    await expect(scan()).rejects.toBeInstanceOf(IndexCacheMismatchError);
  } finally {
    console.error = err;
  }
  expect(cache.stats).toMatchObject({ verified: 2, mismatches: 1 });
  expect(await scan()).toEqual(row(truth)); // dropped: read again
});

// Commit validation through the write log indexed per index (STUDY-06 D11, DV-61), checked against the
// linear validator it replaced: random commits (several indexes, deletes, write sources) through the real
// committer with its retention trimming the log, and random read-sets and snapshots. The indexed validator
// must find a conflict exactly when the linear scan does, report a write that really conflicts (chosen as
// Convex's `writes_overlap_by_index` chooses it), refuse the same snapshots as out of retention, and hold
// exactly the writes of the commits still in the log.
import { describe, expect, test } from "bun:test";
import { Committer, type Conflict, ConflictError, type Interval, OutOfRetentionError } from "../src/committer.ts";
import { encodeKey } from "../src/keyenc.ts";
import type { IndexWrite, Persistence } from "../src/persistence/index.ts";
import { intervalSetContains, intervalSetsByIndex } from "../src/write-log-index.ts";

/** mulberry32: a seeded generator, so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nullPersistence = { apply() {}, async flush() {} } as unknown as Persistence;
const KEYS = 16;
const INDEXES = 4;
const key = (k: number) => encodeKey([k]);
const minTs = (xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const rand = (r: () => number, n: number) => BigInt(Math.floor(r() * n));
type Entry = { ts: bigint; writes: { index: number; key: Uint8Array; id: string | null }[]; source?: string };
type Internals = {
  validate(p: { snapshot: bigint; reads: Interval[] }): Conflict | OutOfRetentionError | null;
  byIndex: { writeCount: number; indexCount: number };
};

function inside(k: Uint8Array, r: Interval) {
  return Buffer.compare(k, r.lo) >= 0 && Buffer.compare(k, r.hi) < 0;
}

/** The linear validator this replaced: every write of every commit in (from, to] against every interval. */
function linearConflicts(log: Entry[], reads: Interval[], from: bigint, to: bigint) {
  const out: (Conflict & { key: Uint8Array })[] = [];
  for (const e of log)
    if (e.ts > from && e.ts <= to)
      for (const w of e.writes)
        if (reads.some((r) => r.index === w.index && inside(w.key, r)))
          out.push({ writeTs: e.ts, index: w.index, id: w.id, source: e.source, key: w.key });
  return out;
}

/**
 * The indexed answer is right when it finds a conflict exactly when the linear scan does, and names one of
 * the conflicting writes as Convex would: a published one (ts ≤ `published`) before a pending one, then the
 * first index read (ascending), then the oldest published write into it (`writes_overlap_by_index`), or
 * the pending write with the lowest key, the oldest among equal keys (`PendingKeysInIndex::overlaps`).
 */
function expectSame(
  got: Conflict | null,
  want: (Conflict & { key?: Uint8Array })[],
  what: string,
  published = (1n << 63n) - 1n,
) {
  if (want.length === 0) {
    expect(got, what).toBeNull();
    return;
  }
  expect(got, what).not.toBeNull();
  const g = got as Conflict;
  // A real conflicting write (its commit's ts, index, document and source)…
  expect(
    want.map(({ key: _, ...c }) => c),
    what,
  ).toContainEqual({
    writeTs: g.writeTs,
    index: g.index,
    id: g.id,
    source: g.source,
  });
  // …and Convex's choice.
  const pending = !want.some((c) => c.writeTs <= published);
  const side = pending ? want : want.filter((c) => c.writeTs <= published);
  const index = Math.min(...side.map((c) => c.index as number));
  expect(g.index, what).toBe(index);
  const inIndex = side.filter((c) => c.index === index);
  if (pending) {
    const lowest = inIndex.map((c) => c.key as Uint8Array).sort(Buffer.compare)[0];
    const atLowest = inIndex.filter((c) => Buffer.compare(c.key as Uint8Array, lowest) === 0);
    expect(g.writeTs, `${what} (pending)`).toBe(minTs(atLowest.map((c) => c.writeTs)));
  } else expect(g.writeTs, what).toBe(minTs(inIndex.map((c) => c.writeTs)));
}

function randomReads(r: () => number): Interval[] {
  const n = Math.floor(r() * 5); // 0..4 intervals, some on the same index, some overlapping
  return Array.from({ length: n }, () => {
    const index = 1 + Math.floor(r() * INDEXES);
    const kind = r();
    if (kind < 0.35) {
      const k = key(Math.floor(r() * KEYS));
      return { index, lo: k, hi: new Uint8Array([...k, 0]) }; // a point, as `db.get`
    }
    const a = Math.floor(r() * (KEYS + 1));
    const b = Math.floor(r() * (KEYS + 1));
    if (kind < 0.45) return { index, lo: key(b), hi: key(a) }; // possibly empty or reversed
    return { index, lo: key(Math.min(a, b)), hi: key(Math.max(a, b) + (r() < 0.5 ? 0 : 1)) };
  });
}

function randomCommitWrites(r: () => number): IndexWrite[] {
  const n = Math.floor(r() * 6); // 0..5 index-key writes
  return Array.from({ length: n }, () => {
    const k = Math.floor(r() * KEYS);
    return { index: 1 + Math.floor(r() * INDEXES), key: key(k), id: r() < 0.25 ? null : `d${k}` };
  });
}

async function run(seed: number) {
  const r = rng(seed);
  let clock = 1_000n;
  // Small retention windows in clock units, and sometimes a small soft size, so the log is trimmed often.
  const c = new Committer(
    nullPersistence,
    {
      minRetentionNs: 3n + rand(r, 5),
      maxRetentionNs: 10n + rand(r, 30),
      softMaxBytes: r() < 0.5 ? 2_000 + Math.floor(r() * 4_000) : Number.POSITIVE_INFINITY,
    },
    () => clock,
  );
  c.resume(clock);
  const log: Entry[] = []; // every accepted commit, as the oracle sees it
  const internals = c as unknown as Internals;
  let checks = 0;
  let conflicts = 0;
  for (let batch = 0; batch < 60; batch++) {
    clock += rand(r, 4); // sometimes stands still: ts = last + 1
    // One group: commits queued together are validated in order, each also against those accepted before it.
    const purged = c.logStartTs;
    const n = 1 + Math.floor(r() * 4);
    const pending = Array.from({ length: n }, (_, i) => {
      const back = c.visibleTs - rand(r, 12);
      const snapshot = back > 0n ? back : 0n;
      const reads = randomReads(r);
      const idx = randomCommitWrites(r);
      const source = r() < 0.5 ? `m${batch}.${i}` : undefined;
      const p = c.commit({ snapshot, reads, docs: [], idx, ...(source === undefined ? {} : { source }) });
      return {
        snapshot,
        reads,
        idx,
        source,
        result: p.then(
          (ts) => ts,
          (e: unknown) => e,
        ),
      };
    });
    const published = c.visibleTs; // what the group's validations see as published; the rest is pending
    let appliedBefore = published;
    for (const p of pending) {
      const got = await p.result;
      const what = `seed ${seed}, batch ${batch}`;
      if (p.snapshot < purged) {
        expect(got, what).toBeInstanceOf(OutOfRetentionError);
        continue;
      }
      const want = linearConflicts(log, p.reads, p.snapshot, appliedBefore);
      if (want.length) {
        conflicts++;
        expect(got, what).toBeInstanceOf(ConflictError);
        expectSame((got as ConflictError).conflict, want, what, published);
        continue;
      }
      expect(typeof got, `${what}: ${got}`).toBe("bigint");
      const ts = got as bigint;
      log.push({ ts, writes: p.idx.map((w) => ({ index: w.index, key: w.key, id: w.id })), source: p.source });
      appliedBefore = ts;
    }

    // Direct validations and changedBetween at random snapshots, including ones between sparse timestamps
    // and ones just outside the log.
    const retained = log.filter((e) => e.ts > c.logStartTs);
    expect(c.logLength).toBe(retained.length);
    expect(internals.byIndex.writeCount, `seed ${seed}: writes held`).toBe(
      retained.reduce((n, e) => n + e.writes.length, 0),
    );
    expect(internals.byIndex.indexCount, `seed ${seed}: indexes held`).toBe(
      new Set(retained.flatMap((e) => e.writes.map((w) => w.index))).size,
    );
    for (let q = 0; q < 8; q++) {
      const reads = randomReads(r);
      const lo = c.logStartTs - 2n;
      const snapshot = lo + rand(r, Number(c.visibleTs - lo + 2n));
      const got = internals.validate({ snapshot, reads });
      checks++;
      if (snapshot < c.logStartTs) expect(got).toBeInstanceOf(OutOfRetentionError);
      else expectSame(got as Conflict | null, linearConflicts(log, reads, snapshot, c.visibleTs), `seed ${seed}`);

      const from = lo + rand(r, Number(c.visibleTs - lo + 1n));
      const ahead = from + rand(r, 10);
      const to = ahead < c.visibleTs ? ahead : c.visibleTs;
      const changed = c.changedBetween(reads, from, to);
      const want = from >= to ? false : from < c.logStartTs ? true : linearConflicts(log, reads, from, to).length > 0;
      expect(changed, `seed ${seed}: changedBetween(${from}, ${to})`).toBe(want);
    }
  }
  return { checks, conflicts, trimmed: c.logStartTs > 1_000n };
}

describe("commit validation through the indexed write log (STUDY-06 D11)", () => {
  test("agrees with the linear validator on random commits, read-sets and snapshots, across trims", async () => {
    let checks = 0;
    let conflicts = 0;
    let trimmed = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const s = await run(seed);
      checks += s.checks;
      conflicts += s.conflicts;
      if (s.trimmed) trimmed++;
    }
    // The scenarios exercise what they claim to: conflicts happen, and the log was trimmed.
    expect(checks).toBeGreaterThan(50_000);
    expect(conflicts).toBeGreaterThan(500);
    expect(trimmed).toBeGreaterThan(140);
  });

  test("interval sets: merged, sorted, empty intervals dropped; a key is in exactly the intervals it was in", () => {
    const r = rng(7);
    for (let t = 0; t < 2_000; t++) {
      const reads = randomReads(r);
      const sets = new Map(intervalSetsByIndex(reads));
      expect([...sets.keys()]).toEqual([...sets.keys()].sort((a, b) => a - b));
      for (const set of sets.values())
        for (let i = 1; i < set.lo.length; i++) expect(Buffer.compare(set.hi[i - 1], set.lo[i])).toBeLessThan(0);
      for (let index = 1; index <= INDEXES; index++)
        for (let k = 0; k <= KEYS; k++)
          for (const kk of [key(k), new Uint8Array([...key(k), 0])]) {
            const set = sets.get(index);
            const got = set ? intervalSetContains(set, kk) : false;
            expect(got).toBe(reads.some((rd) => rd.index === index && inside(kk, rd)));
          }
    }
  });
});

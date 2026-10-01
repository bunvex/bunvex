// Commit timestamps as Convex assigns them (STUDY-06 D9, decided "as Convex" on 2026-09-30):
// `max(last assigned + 1, wall clock)`, strictly increasing, resumed above the store's durable maxTs.
// Convex counts nanoseconds in a u64; a JS number is exact only to 2^53, so bunvex counts MICROseconds and
// the sync protocol multiplies by 1000 on the wire (packages/server/src/sync.ts).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Committer, ConflictError, logEntryBytes, OutOfRetentionError } from "../src/committer.ts";
import { wallClockUs } from "../src/determinism.ts";
import { Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()) });
const commit = (c: Committer) => c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: [] });

describe("commit timestamps", () => {
  test("are the wall clock in microseconds", async () => {
    const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false })).init();
    const before = wallClockUs();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const ts = e.committer.visibleTs;
    expect(ts).toBeGreaterThanOrEqual(before);
    // At most ~1 ms ahead: when performance.now() lags Date.now(), the clock falls back to Date.now() (ms
    // resolution), and commits within one millisecond take `last + 1` µs — ahead of the clock, as Convex's
    // `max(last + 1, clock)` also runs ahead when commits outpace it.
    expect(ts).toBeLessThanOrEqual(wallClockUs() + 1000);
    expect(Number.isSafeInteger(ts)).toBe(true);
  });

  test("strictly increase even when the clock stands still or goes back", async () => {
    let now = 5_000_000;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => now);
    const seen: number[] = [];
    for (const t of [5_000_000, 5_000_000, 4_000_000, 5_000_010, 5_000_010]) {
      now = t;
      seen.push(await commit(c));
    }
    expect(seen).toEqual([5_000_000, 5_000_001, 5_000_002, 5_000_010, 5_000_011]);
  });

  test("resume above the store's maxTs, whether it is behind or ahead of the clock", async () => {
    const behind = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => 9_000);
    behind.appliedTs = behind.visibleTs = 42; // an older store (e.g. written with counter timestamps)
    expect(await commit(behind)).toBe(9_000);
    const ahead = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => 9_000);
    ahead.appliedTs = ahead.visibleTs = 20_000; // the clock went back since the last commit
    expect(await commit(ahead)).toBe(20_001);
  });
});

describe("the write log's window with sparse timestamps", () => {
  const key = (n: number) => new Uint8Array([n]);
  const write = (n: number) => [{ index: 9, key: key(n), id: `d${n}` }];
  const readOf = (n: number) => [{ index: 9, lo: key(n), hi: key(n + 1) }];

  test("concurrent transactions that read nothing the others wrote are not conflicts", async () => {
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }));
    c.resume(1_000); // just opened on a store whose maxTs is 1000: the log is empty, and the clock is far ahead
    for (let round = 0; round < 3; round++) {
      const at = c.visibleTs; // one group: each commit's snapshot is behind the ones accepted before it
      await Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          c.commit({ snapshot: at, reads: readOf(100 + n), docs: [], idx: write(n + 1) }),
        ),
      );
    }
    expect(c.conflicts).toBe(0);
  });

  test("a snapshot older than the log is out of retention, even while the log is empty (STUDY-24 S4)", async () => {
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => 0);
    c.resume(1_000); // opened on a store whose durable maxTs is 1000: nothing before it is in the log
    const r = c.commit({ snapshot: 500, reads: readOf(1), docs: [], idx: write(2) });
    expect(
      await r.then(
        () => "committed",
        (e) => e.constructor.name,
      ),
    ).toBe("OutOfRetentionError");
    expect(c.changedBetween(readOf(1), 500, 1_000)).toBe(true);
    expect(c.changedBetween(readOf(1), 1_000, 1_000)).toBe(false);
  });

  test("a trimmed log still validates snapshots it covers, and refuses older ones", async () => {
    let now = 0;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), { maxRetentionUs: 25 }, () => now);
    const ts: number[] = [];
    for (let n = 1; n <= 6; n++) {
      now = n * 10; // ts 10, 20, … 60
      ts.push(await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(n) }));
    }
    // 25 µs before ts 60 is 35: the log holds ts 40, 50, 60; ts 30 was the last one trimmed
    expect(c.logStartTs).toBe(ts[2]);
    expect(c.changedBetween(readOf(9), ts[2], ts[5])).toBe(false); // covered, nothing wrote key 9
    expect(c.changedBetween(readOf(9), ts[1], ts[5])).toBe(true); // reaches before the log
    const old = c.commit({ snapshot: ts[1], reads: readOf(9), docs: [], idx: write(7) });
    expect(
      await old.then(
        () => "committed",
        (e) => e.constructor.name,
      ),
    ).toBe("OutOfRetentionError");
    const fresh = c.commit({ snapshot: ts[2], reads: readOf(9), docs: [], idx: write(8) });
    expect(await fresh.then(() => "committed")).toBe("committed");
  });
});

// The write log is kept by time and size, as Convex's (crates/database/src/write_log.rs; STUDY-06 D10).
describe("the write log's retention, as Convex", () => {
  const key = (n: number) => new Uint8Array([n >> 8, n & 0xff]);
  const write = (n: number) => [{ index: 9, key: key(n), id: `d${n}` }];
  const readOf = (n: number) => [{ index: 9, lo: key(n), hi: key(n + 1) }];
  const outcome = (p: Promise<number>) =>
    p.then(
      () => "committed",
      (e) => (e as Error).constructor.name,
    );
  const SEC = 1_000_000;

  test("commits older than the max retention are trimmed, younger ones kept, whatever their number", async () => {
    let now = 0;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => now);
    for (let n = 0; n < 400; n++) {
      now = n * SEC; // one commit a second for 400 s
      await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(n) });
    }
    // Under the size budget, the log keeps 300 s (Convex's WRITE_LOG_MAX_RETENTION_SECS): ts 99 s was the
    // last commit older than 399 s - 300 s.
    expect(c.logStartTs).toBe(98 * SEC);
    expect(c.logLength).toBe(301);
    expect(c.outOfRetention).toBe(0);
    expect(c.changedBetween(readOf(1000), 98 * SEC, 399 * SEC)).toBe(false);
    expect(c.changedBetween(readOf(1000), 97 * SEC, 399 * SEC)).toBe(true); // beyond the log: unknown
    // A snapshot 300 s old still validates; one older is out of retention, not a conflict.
    const older = c.commit({ snapshot: 97 * SEC, reads: readOf(1000), docs: [], idx: [] });
    const covered = c.commit({ snapshot: 98 * SEC, reads: readOf(1000), docs: [], idx: [] });
    expect(await outcome(older)).toBe("OutOfRetentionError");
    expect(await outcome(covered)).toBe("committed");
  });

  test("out of retention is not a conflict: counted apart, and refused even with no reads (as Convex's is_stale)", async () => {
    let now = 0;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), { maxRetentionUs: 10 }, () => now);
    for (const t of [100, 200]) {
      now = t;
      await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(t) });
    }
    expect(c.logStartTs).toBe(100);
    const r = await c.commit({ snapshot: 50, reads: [], docs: [], idx: write(1) }).catch((e) => e);
    expect(r).toBeInstanceOf(OutOfRetentionError);
    expect(r).not.toBeInstanceOf(ConflictError);
    expect(r.message).toBe("Timestamp 50 is outside of write log retention window (minimum timestamp 100)");
    expect(c.outOfRetention).toBe(1);
    expect(c.conflicts).toBe(0);
  });

  test("over the soft size, commits older than the min retention go; younger ones stay even over it", async () => {
    let now = 0;
    const c = new Committer(
      await MemoryPersistence.open(null, { durable: false }),
      { minRetentionUs: 1_000, softMaxBytes: 20_000 },
      () => now,
    );
    const big = (n: number) =>
      Array.from({ length: 10 }, (_, i) => ({ index: 9, key: new Uint8Array(100).fill(i), id: `d${n}-${i}` }));
    let peak = 0;
    for (let n = 0; n < 2_000; n++) {
      now = n * 1_000; // one commit per ms: the 1 ms min retention covers 2 commits, the budget ~9
      await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: big(n) });
      peak = Math.max(peak, c.logBytes);
    }
    // The memory bound: the budget, plus at most one commit (a trim stops below the budget).
    const one = logEntryBytes({ ts: 0, writes: big(1999) });
    expect(peak).toBeLessThan(20_000 + one);
    expect(c.logBytes).toBeLessThan(20_000);
    expect(c.logLength).toBeGreaterThan(5);
    expect(c.logLength).toBeLessThan(12); // nowhere near 2000, nor 300 s

    // With a budget smaller than one commit, the min retention still holds: ~1 ms of commits stays.
    now = 0;
    const tiny = new Committer(
      await MemoryPersistence.open(null, { durable: false }),
      { minRetentionUs: 1_000, softMaxBytes: 1 },
      () => now,
    );
    for (let n = 0; n < 500; n++) {
      now = n * 10;
      await tiny.commit({ snapshot: tiny.visibleTs, reads: [], docs: [], idx: write(n) });
    }
    expect(tiny.logLength).toBe(101); // ts 3990 … 4990: none older than 4990 - 1000 is kept
    expect(tiny.logStartTs).toBe(3980);
  });

  test("the optional hard cap (not in Convex, off by default) drops commits younger than the min retention", async () => {
    let now = 0;
    const capped = new Committer(
      await MemoryPersistence.open(null, { durable: false }),
      { hardMaxBytes: 2_000 },
      () => now,
    );
    const uncapped = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => now);
    for (let n = 0; n < 100; n++) {
      now = n; // 100 commits within 100 µs: all inside the 30 s min retention
      await capped.commit({ snapshot: capped.visibleTs, reads: [], docs: [], idx: write(n) });
      await uncapped.commit({ snapshot: uncapped.visibleTs, reads: [], docs: [], idx: write(n) });
    }
    expect(uncapped.logLength).toBe(100); // Convex: the min retention wins over any size
    expect(capped.logBytes).toBeLessThanOrEqual(2_000);
    expect(capped.logLength).toBeLessThan(100);
    expect(capped.logLength).toBeGreaterThan(2_000 / logEntryBytes({ ts: 0, writes: write(99) }) - 1); // a full budget
  });

  test("lagged snapshots (500 ms) under 2 000 commits/s, and >20 000 commits later, validate normally (STUDY-24 A2)", async () => {
    let now = 1_000 * SEC;
    // Every commit moves the clock 500 µs: 2 000 commits per second.
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => (now += 500));
    const at: { time: number; ts: number }[] = []; // visibleTs over time, to take lagged snapshots
    const start = c.visibleTs;
    let noise = 0;
    let lagged = 0;
    const results: string[] = [];
    while (noise < 25_000) {
      // 50 noise commits (keys 0…199), then one lagged transaction reading key 500 + i, which noise never writes
      await Promise.all(
        Array.from({ length: 50 }, () =>
          c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(noise++ % 200) }),
        ),
      );
      at.push({ time: now, ts: c.visibleTs });
      const lagTo = now - 500_000;
      const snap = [...at].reverse().find((x) => x.time <= lagTo)?.ts;
      if (snap === undefined) continue;
      results.push(
        await outcome(c.commit({ snapshot: snap, reads: readOf(500 + lagged), docs: [], idx: write(500 + lagged++) })),
      );
    }
    expect(results.length).toBeGreaterThan(400);
    expect(results.filter((r) => r !== "committed")).toEqual([]);
    // A lagged transaction that did read a key noise wrote is still a conflict (validation is real).
    const lost = c.commit({ snapshot: at[at.length - 20].ts, reads: readOf(7), docs: [], idx: [] });
    expect(await outcome(lost)).toBe("ConflictError");
    // And one whose snapshot is older than 25 000 commits (12.5 s here) validates: no count-based window.
    expect(c.logLength).toBeGreaterThan(25_000);
    expect(await outcome(c.commit({ snapshot: start, reads: readOf(4_000), docs: [], idx: [] }))).toBe("committed");
    expect(c.conflicts).toBe(1);
  });

  test("a transaction may not begin further back than MAX_TRANSACTION_WINDOW (10 s), as Convex's snapshot manager", async () => {
    let now = 0;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), {}, () => now);
    c.resume(1_000);
    expect(c.earliestBeginTs()).toBe(1_000); // no commit yet: the store's ts
    for (const t of [2, 5, 12, 20]) {
      now = t * SEC;
      await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(t) });
    }
    // Latest 20 s: the window reaches back to 10 s, and the snapshot in force then is the 5 s commit's.
    expect(c.earliestBeginTs()).toBe(5 * SEC);
    expect(() => c.checkBeginTs(5 * SEC)).not.toThrow();
    expect(() => c.checkBeginTs(9 * SEC)).not.toThrow();
    const e = (() => {
      try {
        c.checkBeginTs(4 * SEC);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(OutOfRetentionError);
    expect((e as Error).message).toBe(`Timestamp ${4 * SEC} is too early, retry with a higher timestamp`);
    // A commit exactly at latest - window keeps its predecessor (Convex pops only when the gap is > window).
    now = 22 * SEC;
    await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(22) });
    expect(c.earliestBeginTs()).toBe(5 * SEC);
  });
});

describe("the engine and an out-of-retention snapshot", () => {
  test("the mutation fails with OutOfRetentionError after one execution: not retried as an OCC conflict", async () => {
    const e = await new Engine(schema, await MemoryPersistence.open(null, { durable: false }), {
      writeLogRetention: { maxRetentionUs: 1_000 }, // 1 ms
      occInitialBackoffMs: 1,
      occMaxBackoffMs: 2,
    }).init();
    const id = await e.mutation((db) => db.insert("items", { n: 0 }));
    let runs = 0;
    const slow = e.mutation(async (db) => {
      runs++;
      await db.get("items", id);
      // Two other commits more than 1 ms apart: the first is trimmed, past this snapshot.
      await e.mutation((d) => d.insert("items", { n: 1 }));
      await Bun.sleep(5);
      await e.mutation((d) => d.insert("items", { n: 2 }));
      await db.patch("items", id, { n: 3 });
    });
    expect(await slow.catch((x) => x)).toBeInstanceOf(OutOfRetentionError);
    expect(runs).toBe(1);
    expect(e.stats.retries).toBe(0);
  });
});

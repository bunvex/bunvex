// Commit timestamps as Convex assigns them (STUDY-06 D9, decided "as Convex" on 2026-09-30):
// `max(last assigned + 1, wall clock)`, strictly increasing, resumed above the store's durable maxTs.
// Convex counts nanoseconds in a u64; a JS number is exact only to 2^53, so bunvex counts MICROseconds and
// the sync protocol multiplies by 1000 on the wire (packages/server/src/sync.ts).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { Committer } from "../src/committer.ts";
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
    expect(ts).toBeLessThanOrEqual(wallClockUs());
    expect(Number.isSafeInteger(ts)).toBe(true);
  });

  test("strictly increase even when the clock stands still or goes back", async () => {
    let now = 5_000_000;
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), 20_000, () => now);
    const seen: number[] = [];
    for (const t of [5_000_000, 5_000_000, 4_000_000, 5_000_010, 5_000_010]) {
      now = t;
      seen.push(await commit(c));
    }
    expect(seen).toEqual([5_000_000, 5_000_001, 5_000_002, 5_000_010, 5_000_011]);
  });

  test("resume above the store's maxTs, whether it is behind or ahead of the clock", async () => {
    const behind = new Committer(await MemoryPersistence.open(null, { durable: false }), 20_000, () => 9_000);
    behind.appliedTs = behind.visibleTs = 42; // an older store (e.g. written with counter timestamps)
    expect(await commit(behind)).toBe(9_000);
    const ahead = new Committer(await MemoryPersistence.open(null, { durable: false }), 20_000, () => 9_000);
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

  test("a snapshot older than the log is a conflict, even while the log is empty (STUDY-24 S4)", async () => {
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), 20_000, () => 0);
    c.resume(1_000); // opened on a store whose durable maxTs is 1000: nothing before it is in the log
    const r = c.commit({ snapshot: 500, reads: readOf(1), docs: [], idx: write(2) });
    expect(
      await r.then(
        () => "committed",
        (e) => e.constructor.name,
      ),
    ).toBe("ConflictError");
    expect(c.changedBetween(readOf(1), 500, 1_000)).toBe(true);
    expect(c.changedBetween(readOf(1), 1_000, 1_000)).toBe(false);
  });

  test("a trimmed log still validates snapshots it covers, and refuses older ones", async () => {
    const c = new Committer(await MemoryPersistence.open(null, { durable: false }), 3);
    const ts: number[] = [];
    for (let n = 1; n <= 6; n++) ts.push(await c.commit({ snapshot: c.visibleTs, reads: [], docs: [], idx: write(n) }));
    // the log holds the last 3 commits: ts[3..5]; ts[2] was trimmed
    expect(c.changedBetween(readOf(9), ts[2], ts[5])).toBe(false); // covered, nothing wrote key 9
    expect(c.changedBetween(readOf(9), ts[1], ts[5])).toBe(true); // reaches before the log
    const old = c.commit({ snapshot: ts[1], reads: readOf(9), docs: [], idx: write(7) });
    expect(
      await old.then(
        () => "committed",
        (e) => e.constructor.name,
      ),
    ).toBe("ConflictError");
    const fresh = c.commit({ snapshot: ts[2], reads: readOf(9), docs: [], idx: write(8) });
    expect(await fresh.then(() => "committed")).toBe("committed");
  });
});

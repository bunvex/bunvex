// The query cache as Convex's (STUDY-08 D8, DV-63): an LRU bounded by bytes, identical concurrent runs
// coalesced, and results checked against the write log when they are looked up.
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import type { WriteLogRetention } from "../src/committer.ts";
import { type Caller, Engine } from "../src/engine.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { MAX_CACHE_AGE_MS, readySize } from "../src/query-cache.ts";
import { defineSchema, defineTable } from "../src/schema.ts";
import type { Tx } from "../src/tx.ts";

async function engine(
  opts: { cacheMaxBytes?: number; writeLogRetention?: Partial<WriteLogRetention>; cacheClock?: () => number } = {},
) {
  const e = await new Engine(
    defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) }),
    await MemoryPersistence.open(null, { durable: false }),
    opts,
  ).init();
  await e.indexesReady(); // enabling an index empties the cache
  return e;
}

/** A query over `items` with `n`, counting its runs. */
function counted(n: number) {
  const q = Object.assign(
    async (db: Tx) => {
      q.runs++;
      return db
        .query("items")
        .withIndex("by_n", (r) => r.eq("n", n))
        .collect();
    },
    { runs: 0 },
  );
  return q;
}

const user = (name: string): Caller => ({ identity: { subject: name }, key: name });

describe("an LRU bounded by bytes", () => {
  test("an insert over the budget evicts the least recently used entry", async () => {
    // Room for three of these results, not four.
    const probe = await engine();
    await probe.query(async () => "x".repeat(1000), "probe");
    const one = probe.cache.bytes;
    const e = await engine({ cacheMaxBytes: one * 3 + one / 2 });
    const big = (tag: string) => async () => `${tag}${"x".repeat(999)}`;
    await e.query(big("a"), "a");
    await e.query(big("b"), "b");
    await e.query(big("c"), "c");
    await e.query(big("a"), "a"); // a is now the most recently used; b the least
    expect(e.stats.cacheHits).toBe(1);
    await e.query(big("d"), "d");
    expect(e.cache.size).toBe(3);
    expect(e.cache.bytes).toBeLessThanOrEqual(e.cache.maxBytes);
    const misses = e.stats.cacheMisses;
    await e.query(big("a"), "a");
    await e.query(big("c"), "c");
    await e.query(big("d"), "d");
    expect(e.stats.cacheMisses).toBe(misses); // a, c, d were kept
    await e.query(big("b"), "b");
    expect(e.stats.cacheMisses).toBe(misses + 1); // b was evicted
    expect(e.cache.evictions).toBe(2); // b, then c to make room for b again
  });

  test("an entry's size counts its key, its result and its read-set", async () => {
    const e = await engine();
    await e.mutation(async (db) => {
      for (let i = 0; i < 50; i++) await db.insert("items", { n: 1, pad: "p".repeat(100) });
    });
    await e.query(counted(1), "k");
    const json = await e.queryJson(counted(1), "k");
    expect(e.cache.bytes).toBeGreaterThan(json.length);
    expect(e.cache.bytes).toBeLessThan(json.length + 1000);
  });

  test("a result larger than the whole budget is not kept, and empties the cache as in Convex", async () => {
    const e = await engine({ cacheMaxBytes: 10_000 });
    await e.query(async () => "small", "small");
    expect(e.cache.size).toBe(1);
    const huge = Object.assign(
      async () => {
        huge.runs++;
        return "x".repeat(20_000);
      },
      { runs: 0 },
    );
    expect(await e.query(huge, "huge")).toHaveLength(20_000);
    expect(e.cache.size).toBe(0);
    expect(e.cache.bytes).toBe(0);
    await e.query(huge, "huge");
    expect(huge.runs).toBe(2);
  });

  test("readySize grows with the result", () => {
    const r = {
      json: "1",
      extra: undefined,
      originalTs: 1n,
      tokenTs: 1n,
      reads: [],
      observedTime: false,
      unixMs: 0,
      identityObserved: false,
    };
    expect(readySize("k", { ...r, json: "x".repeat(1000) }) - readySize("k", r)).toBe(999);
  });
});

describe("identical concurrent runs are coalesced", () => {
  test("N concurrent identical queries run once, and every caller gets the result", async () => {
    const e = await engine();
    await e.mutation((db) => db.insert("items", { n: 1 }));
    const q = counted(1);
    const results = await Promise.all(Array.from({ length: 32 }, () => e.queryJson(q, "k")));
    expect(q.runs).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(e.stats).toMatchObject({ cacheMisses: 1, cacheHits: 31, cacheWaits: 31 });
  });

  test("different arguments or identities run apart", async () => {
    const e = await engine();
    const q1 = counted(1);
    const q2 = counted(2);
    await Promise.all([e.query(q1, "q:1"), e.query(q2, "q:2"), e.query(q1, "q:1"), e.query(q2, "q:2")]);
    expect([q1.runs, q2.runs]).toEqual([1, 1]);

    // A query that reads the identity: one run per caller, each with its own answer.
    let runs = 0;
    const whoami = async (db: Tx) => {
      runs++;
      return (db.readIdentity() as { subject: string }).subject;
    };
    const answers = await Promise.all(
      ["ada", "bob", "ada", "bob", "ada"].map((u) => e.query(whoami, "whoami", undefined, user(u))),
    );
    expect(answers).toEqual(["ada", "bob", "ada", "bob", "ada"]);
    expect(runs).toBe(2);
  });

  test("a run that throws is not cached, and each waiter runs the query again, as Convex's", async () => {
    const e = await engine();
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("boom");
    };
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => e.query(boom, "boom")));
    expect(outcomes.every((o) => o.status === "rejected" && String(o.reason).includes("boom"))).toBe(true);
    // Convex's executor drops its broadcast sender on an error; every waiter then plans again, one at a time.
    expect(runs).toBe(8);
    expect(e.cache.size).toBe(0);
  });

  test("a waiter joins a run of the shared entry when the stored result was found stale", async () => {
    const e = await engine();
    const q = counted(1);
    await e.query(q, "k", undefined, user("ada")); // reads no identity: stored shared
    await e.mutation((db) => db.insert("items", { n: 1 }));
    await Promise.all(["ada", "bob", "cyd"].map((u) => e.query(q, "k", undefined, user(u))));
    expect(q.runs).toBe(2); // the rerun is coordinated under the shared key: one for all three
  });
});

describe("validity: checked against the write log when looked up", () => {
  test("a write into the read-set makes the next call run again; a write past it does not", async () => {
    const e = await engine();
    const q = counted(1);
    await e.query(q, "k");
    await e.mutation((db) => db.insert("items", { n: 2 }));
    await e.query(q, "k");
    expect(q.runs).toBe(1);
    await e.mutation((db) => db.insert("items", { n: 1 }));
    expect(await e.query(q, "k")).toHaveLength(1);
    expect(q.runs).toBe(2);
  });

  test("a hit moves the entry's token forward: the next check starts from there", async () => {
    const e = await engine();
    const q = counted(1);
    await e.query(q, "k");
    const entry = () =>
      [...(e.cache as unknown as { entries: Map<string, { result: { tokenTs: bigint } }> }).entries.values()][0]!;
    const cachedAt = entry().result.tokenTs;
    await e.mutation((db) => db.insert("items", { n: 2 }));
    await e.query(q, "k");
    expect(q.runs).toBe(1);
    expect(entry().result.tokenTs).toBe(e.committer.visibleTs);
    expect(entry().result.tokenTs).toBeGreaterThan(cachedAt);
  });

  test("a result is cached even when other commits land while it runs", async () => {
    const e = await engine();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let runs = 0;
    const slow = async (db: Tx) => {
      runs++;
      const rows = await db
        .query("items")
        .withIndex("by_n", (r) => r.eq("n", 1))
        .collect();
      await gate;
      return rows.length;
    };
    const first = e.query(slow, "slow");
    await e.mutation((db) => db.insert("items", { n: 2 })); // lands while `slow` runs, outside its reads
    open();
    expect(await first).toBe(0);
    expect(await e.query(slow, "slow")).toBe(0);
    expect(runs).toBe(1);
  });

  test("a result that read the clock expires after MAX_CACHE_AGE_MS; one that did not, never", async () => {
    let skew = 0; // the cache's clock runs this far ahead of the real one
    const e = await engine({ cacheClock: () => Date.now() + skew });
    let clockRuns = 0;
    let plainRuns = 0;
    const clock = async () => {
      clockRuns++;
      return Date.now() > 0;
    };
    const plain = async () => {
      plainRuns++;
      return true;
    };
    await e.query(clock, "clock");
    await e.query(plain, "plain");
    skew = MAX_CACHE_AGE_MS - 1000;
    await e.query(clock, "clock");
    expect(clockRuns).toBe(1);
    skew = MAX_CACHE_AGE_MS + 1000;
    await e.query(clock, "clock");
    await e.query(plain, "plain");
    expect([clockRuns, plainRuns]).toEqual([2, 1]);
  });

  test("a result cached at ts serves a call at a later ts, not an earlier one", async () => {
    const e = await engine();
    const q = counted(1);
    const before = e.committer.visibleTs;
    await e.mutation((db) => db.insert("items", { n: 2 }));
    await e.query(q, "k"); // cached at the latest ts
    expect(await e.query(q, "k", undefined, undefined, before)).toHaveLength(0);
    expect(q.runs).toBe(2); // older than the cached result: run, and not stored over the newer one
    await e.query(q, "k");
    expect(q.runs).toBe(2);
  });

  test("a result whose reads fell out of the write log's retention runs again", async () => {
    const e = await engine({ writeLogRetention: { minRetentionNs: 0n, maxRetentionNs: 1000n, softMaxBytes: 0 } });
    const q = counted(1);
    await e.query(q, "k");
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 2));
      await e.mutation((db) => db.insert("items", { n: 2 })); // outside the reads, but trims the log
    }
    await e.query(q, "k");
    expect(q.runs).toBe(2);
  });
});

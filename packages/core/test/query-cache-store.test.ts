// The query cache's store on its own (`QueryCache`, STUDY-08 D8): which result a key keeps, the waiting
// entries, the bytes it counts and what it evicts. query-cache.test.ts tests the cache through the engine;
// these pin the store's rules directly, the ones mutation testing (TEST-01 §7) found no core test noticing.
import { describe, expect, test } from "bun:test";
import type { Interval } from "../src/committer.ts";
import { type CachedResult, QueryCache, readySize } from "../src/query-cache.ts";

function result(originalTs: bigint, tokenTs: bigint, json = '"r"', extra: unknown = null, reads: Interval[] = []) {
  return {
    json,
    extra,
    originalTs,
    tokenTs,
    reads,
    observedTime: false,
    unixMs: 0,
    identityObserved: false,
  } satisfies CachedResult;
}

const kept = (c: QueryCache, key: string) => {
  const e = c.inspect().find((x) => x.key === key)?.entry;
  return e?.kind === "ready" ? [e.result.originalTs, e.result.tokenTs] : e?.kind;
};

describe("which result a key keeps", () => {
  test("a newer snapshot wins; at the same snapshot, a later token; an older or equal one is dropped", () => {
    const c = new QueryCache();
    c.putReady("k", result(10n, 10n));
    c.putReady("k", result(9n, 50n)); // older snapshot, even with a later token
    expect(kept(c, "k")).toEqual([10n, 10n]);
    c.putReady("k", result(10n, 9n)); // same snapshot, earlier token
    expect(kept(c, "k")).toEqual([10n, 10n]);
    c.putReady("k", result(10n, 10n, '"other"')); // the same: the stored one stays
    expect((c.inspect()[0]!.entry as { result: CachedResult }).result.json).toBe('"r"');
    c.putReady("k", result(10n, 12n)); // same snapshot, later token
    expect(kept(c, "k")).toEqual([10n, 12n]);
    c.putReady("k", result(11n, 11n)); // newer snapshot, even with an earlier token than 12
    expect(kept(c, "k")).toEqual([11n, 11n]);
  });

  test("a result takes a waiting entry's place, and the bytes count the result only", () => {
    const c = new QueryCache();
    c.putWaiting("key", 5n);
    expect(kept(c, "key")).toBe("waiting");
    const r = result(5n, 5n);
    c.putReady("key", r);
    expect(kept(c, "key")).toEqual([5n, 5n]);
    expect(c.bytes).toBe(readySize("key", r));
    expect(c.size).toBe(1);
  });
});

describe("removing an entry", () => {
  test("removeWaiting drops only the waiting entry with that id", async () => {
    const c = new QueryCache();
    const first = c.putWaiting("k", 1n);
    const second = c.putWaiting("k", 2n); // replaces the first: another id
    expect(second.id).not.toBe(first.id);
    c.removeWaiting("k", first.id);
    expect(kept(c, "k")).toBe("waiting");
    c.removeWaiting("k", second.id);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
    // A ready entry is never removed as a waiting one.
    const third = c.putWaiting("k", 3n);
    c.putReady("k", result(3n, 3n));
    c.removeWaiting("k", third.id);
    expect(kept(c, "k")).toEqual([3n, 3n]);
  });

  test("removeReady drops the result only if it is the one computed at that snapshot", () => {
    const c = new QueryCache();
    c.putReady("k", result(7n, 7n));
    c.removeReady("k", 6n);
    expect(kept(c, "k")).toEqual([7n, 7n]);
    c.removeReady("k", 7n);
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
    c.putWaiting("w", 7n);
    c.removeReady("w", 7n); // a waiting entry is not a result
    expect(kept(c, "w")).toBe("waiting");
    c.removeReady("missing", 7n); // nothing under the key: nothing to do
    c.removeWaiting("missing", 0);
    expect(c.size).toBe(1);
  });

  test("a waiting entry settles its waiters", async () => {
    const c = new QueryCache();
    const w = c.putWaiting("k", 1n);
    const entry = c.inspect()[0]!.entry as { result: Promise<CachedResult | null> };
    const r = result(1n, 1n);
    w.settle(r);
    expect(await entry.result).toBe(r);
  });
});

describe("the bytes an entry counts", () => {
  // 360 per entry, the key, the JSON, the companion's data, and 96 per read interval plus its key bytes.
  test("a result: its key, its JSON, its read-set and its companion's data", () => {
    const reads: Interval[] = [{ lo: new Uint8Array(3), hi: new Uint8Array(5) } as Interval];
    expect(readySize("key", result(1n, 1n, '"ab"'))).toBe(360 + 3 + 4);
    expect(readySize("key", result(1n, 1n, '"ab"', null, reads))).toBe(360 + 3 + 4 + 96 + 3 + 5);
    // The companion's data: a string by its length, an array 16 + 16 per item, an object 32 + 16 per field,
    // anything else 8; nested the same way.
    expect(readySize("", result(1n, 1n, "", "abc"))).toBe(360 + 3);
    expect(readySize("", result(1n, 1n, "", ["ab", "c"]))).toBe(360 + 16 + (16 + 2) + (16 + 1));
    expect(readySize("", result(1n, 1n, "", { a: "xy", b: 1 }))).toBe(360 + 32 + (16 + 2) + (16 + 8));
    expect(readySize("", result(1n, 1n, "", [{ m: ["z"] }]))).toBe(360 + 16 + 16 + 32 + 16 + 16 + 16 + 1);
    expect(readySize("", result(1n, 1n, "", undefined))).toBe(360);
  });

  test("a waiting entry: its key only; bytes always equal the sum of the entries", () => {
    const c = new QueryCache();
    c.putWaiting("abcd", 1n);
    expect(c.bytes).toBe(360 + 4);
    c.putReady("other", result(1n, 1n, '"x"'));
    expect(c.bytes).toBe(360 + 4 + readySize("other", result(1n, 1n, '"x"')));
    c.clear();
    expect(c.bytes).toBe(0);
    expect(c.size).toBe(0);
    expect(c.inspect()).toEqual([]);
  });
});

describe("eviction and the misses it explains", () => {
  const each = readySize("k0", result(1n, 1n)); // every key below has 2 characters

  test("the least recently used goes first; find() marks an entry as used", () => {
    const c = new QueryCache(each * 3);
    for (const k of ["k0", "k1", "k2"]) c.putReady(k, result(1n, 1n));
    expect(c.find(["missing", "k0"])?.key).toBe("k0"); // k0 is now the most recent
    c.putReady("k3", result(1n, 1n));
    expect(c.inspect().map((x) => x.key)).toEqual(["k2", "k0", "k3"]);
    expect(c.evictions).toBe(1);
    expect(c.bytes).toBe(each * 3);
  });

  test("a miss after an eviction counts as `evicted` once, then as `new`; a given reason counts as itself", () => {
    const c = new QueryCache(each);
    c.putReady("k0", result(1n, 1n));
    c.putReady("k1", result(1n, 1n)); // evicts k0
    c.noteMiss(["k0"]);
    c.noteMiss(["k0"]);
    c.noteMiss(["zz"], "invalidated");
    expect(c.misses).toEqual({ new: 1, evicted: 1, invalidated: 1, expired: 0, snapshot: 0 });
  });

  test("a waiting entry counts against the budget too", () => {
    const c = new QueryCache(each);
    c.putReady("k0", result(1n, 1n));
    c.putWaiting("a much longer key than k0", 1n); // over the budget: the ready entry goes, then itself
    expect(c.inspect().map((x) => x.key)).toEqual([]);
    expect(c.evictions).toBe(2);
  });

  test("a result larger than the budget empties the cache and is not kept", () => {
    const c = new QueryCache(each * 2);
    c.putReady("k0", result(1n, 1n));
    c.putReady("k1", result(1n, 1n, `"${"x".repeat(each * 2)}"`));
    expect(c.size).toBe(0);
    expect(c.bytes).toBe(0);
    expect(c.evictions).toBe(2);
  });

  test("only the last 1024 evicted keys are remembered", () => {
    const key = (i: number) => `k${String(i).padStart(5, "0")}`;
    const c = new QueryCache(readySize(key(0), result(1n, 1n))); // room for one entry
    for (let i = 0; i < 1026; i++) c.putReady(key(i), result(1n, 1n));
    expect(c.evictions).toBe(1025);
    c.noteMiss([key(0)]); // the first evicted key is forgotten: a first miss
    c.noteMiss([key(1)]); // the second is still remembered
    expect(c.misses).toMatchObject({ new: 1, evicted: 1 });
  });
});

test("printed by name only: inspecting the cache never shows its entries (inspect.ts)", () => {
  const c = new QueryCache();
  c.putReady("secret-key", result(1n, 1n, '"secret result"'));
  expect(Bun.inspect(c)).toBe("QueryCache {…}");
});

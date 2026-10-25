// The component's functions beyond upstream's tests (STUDY-183 §3.3): `rebalance` (unrounded shares, more and fewer
// shards, the default of 16, the rows it leaves alone), `estimateCount` (its clamp, its formula, its bounds) and
// `add`'s random shard. Rows are read as upstream's tests read them: the component's functions pushed as the app's
// (fixtures/standalone), so `t.run` sees `counters`.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const fn = anyApi.public as any;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function standalone() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

type Row = { name: string; shard: number; value: number };
/** The rows of `name`, as `[shard, value]` in shard order. */
const rows = (t: TestBunvex, name: string) =>
  t.run(async (ctx: any) =>
    ((await ctx.db.query("counters").collect()) as Row[])
      .filter((r) => r.name === name)
      .sort((a, b) => a.shard - b.shard)
      .map((r) => [r.shard, r.value]),
  ) as Promise<[number, number][]>;
const add = (t: TestBunvex, args: Record<string, unknown>) => t.mutation(fn.add, args) as Promise<number>;

describe("rebalance", () => {
  test("every shard gets the same unrounded share of the total", async () => {
    const t = standalone();
    await add(t, { name: "beans", count: 10, shard: 0 });
    await t.mutation(fn.rebalance, { name: "beans", shards: 3 });
    expect(await rows(t, "beans")).toEqual([
      [0, 10 / 3],
      [1, 10 / 3],
      [2, 10 / 3],
    ]);
    // A share that is not a whole number stays as it is.
    expect((await rows(t, "beans"))[0]![1]).not.toBe(Math.round(10 / 3));
    expect(await t.query(fn.count, { name: "beans" })).toBeCloseTo(10);
  });

  test("without `shards`, 16 shards", async () => {
    const t = standalone();
    await add(t, { name: "beans", count: 32, shard: 40 });
    await t.mutation(fn.rebalance, { name: "beans" });
    expect(await rows(t, "beans")).toEqual(Array.from({ length: 16 }, (_, i) => [i, 2]));
  });

  test("more shards: the missing ones are inserted", async () => {
    const t = standalone();
    await add(t, { name: "beans", count: 3, shard: 0 });
    await add(t, { name: "beans", count: 5, shard: 1 });
    await t.mutation(fn.rebalance, { name: "beans", shards: 4 });
    expect(await rows(t, "beans")).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
  });

  test("fewer shards: the shards at or past the new number are deleted, their counts kept", async () => {
    const t = standalone();
    for (let shard = 0; shard < 8; shard++) await add(t, { name: "beans", count: shard + 1, shard });
    await add(t, { name: "other", count: 7, shard: 6 });
    await t.mutation(fn.rebalance, { name: "beans", shards: 2 });
    expect(await rows(t, "beans")).toEqual([
      [0, 18],
      [1, 18],
    ]);
    // Another counter's rows are left alone.
    expect(await rows(t, "other")).toEqual([[6, 7]]);
  });

  test("a shard that is negative or not a whole number is left as it is (Convex's quirk, kept)", async () => {
    const t = standalone();
    await add(t, { name: "beans", count: 4, shard: -1 });
    await add(t, { name: "beans", count: 2, shard: 0.5 });
    await t.mutation(fn.rebalance, { name: "beans", shards: 2 });
    expect(await rows(t, "beans")).toEqual([
      [-1, 4],
      [0, 3],
      [0.5, 2],
      [1, 3],
    ]);
  });

  test("an empty counter rebalanced has every shard at 0; the result is null", async () => {
    const t = standalone();
    expect(await t.mutation(fn.rebalance, { name: "none", shards: 2 })).toBeNull();
    expect(await rows(t, "none")).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });
});

describe("estimateCount", () => {
  /** Shards 0..3 holding 1, 2, 3 and 4. */
  async function four() {
    const t = standalone();
    for (let shard = 0; shard < 4; shard++) await add(t, { name: "beans", count: shard + 1, shard });
    return t;
  }
  const estimate = (t: TestBunvex, args: Record<string, unknown>) =>
    t.query(fn.estimateCount, { name: "beans", ...args }) as Promise<number>;

  test("one shard read, scaled to all: 4 times one shard's value, the shard picked at random", async () => {
    const t = standalone();
    // A query's result is cached until what it read changes, so the draws are spread over counters of their own.
    const names = Array.from({ length: 30 }, (_, i) => `beans${i}`);
    for (const name of names) for (let shard = 0; shard < 4; shard++) await add(t, { name, count: shard + 1, shard });
    const seen = new Set<number>();
    for (const name of names) {
      const e = (await t.query(fn.estimateCount, { name, shards: 4 })) as number;
      expect([4, 8, 12, 16]).toContain(e);
      seen.add(e);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test("k shards read: their sum times shards / k, within the bounds", async () => {
    const t = await four();
    const e = await estimate(t, { shards: 4, readFromShards: 2 });
    // Between the two smallest (1 + 2) and the two largest (3 + 4), scaled by 4 / 2.
    expect([6, 8, 10, 12, 14]).toContain(e);
  });

  test("readFromShards clamped to [1, shards]: 0 or less reads one, more than shards reads all", async () => {
    const t = await four();
    for (const readFromShards of [0, -3])
      expect([4, 8, 12, 16]).toContain(await estimate(t, { shards: 4, readFromShards }));
    expect(await estimate(t, { shards: 4, readFromShards: 4 })).toBe(10);
    expect(await estimate(t, { shards: 4, readFromShards: 100 })).toBe(10);
  });

  test("without `shards`, 16: one read shard of the 4 used is worth 16 times its value", async () => {
    const t = await four();
    expect([0, 16, 32, 48, 64]).toContain(await estimate(t, {}));
    expect(await estimate(t, { readFromShards: 16 })).toBe(10);
  });

  test("a fractional readFromShards reads its whole part and divides by itself, as Convex's", async () => {
    const t = await four();
    // Two shards read (slice to 2.5 keeps 2), scaled by 4 / 2.5.
    const e = await estimate(t, { shards: 4, readFromShards: 2.5 });
    const sums = [3, 4, 5, 6, 7].map((s) => (s * 4) / 2.5);
    expect(sums).toContain(e);
  });

  test("a counter with no rows estimates 0", async () => {
    const t = standalone();
    expect(await t.query(fn.estimateCount, { name: "none", readFromShards: 3 })).toBe(0);
  });
});

describe("add", () => {
  test("without a shard, a random one below `shards` (16 by default), and its number is the result", async () => {
    const t = standalone();
    const picked = new Set<number>();
    for (let i = 0; i < 60; i++) picked.add(await add(t, { name: "beans", count: 1 }));
    for (const s of picked) expect(Number.isInteger(s) && s >= 0 && s < 16).toBe(true);
    // 60 draws over 16 shards land on more than 8 of them (all but certainly), so the default is not smaller.
    expect(picked.size).toBeGreaterThan(8);
    expect((await rows(t, "beans")).map(([s]) => s)).toEqual([...picked].sort((a, b) => a - b));
    const three = new Set<number>();
    for (let i = 0; i < 30; i++) three.add(await add(t, { name: "few", count: 1, shards: 3 }));
    expect([...three].sort()).toEqual([0, 1, 2]);
    expect(await t.query(fn.count, { name: "beans" })).toBe(60);
  });

  test("bad arguments are refused by the validators", async () => {
    const t = standalone();
    await expect(add(t, { name: "beans" })).rejects.toThrow(/count/);
    await expect(add(t, { name: "beans", count: "1" })).rejects.toThrow(/count/);
    await expect(add(t, { name: "beans", count: 1, extra: true })).rejects.toThrow(/extra/);
    await expect(t.query(fn.count, { name: 1 })).rejects.toThrow(/name/);
  });
});

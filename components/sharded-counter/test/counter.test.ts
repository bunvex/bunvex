// Upstream's tests (`src/component/counter.test.ts` of `@convex-dev/sharded-counter` 0.2.3) ported to `@bunvex/testing`
// (STUDY-183 §3.3). Upstream runs the component's own schema and modules as convex-test's app; here:
//
// - most tests mount the component as an app does (`register(t)`, the package's `./test`) and call
//   `components.shardedCounter.public.*` through the reference it returns;
// - the explicit shard is read row by row, which only the component's own functions can do: those tests push the
//   component's functions as the app's (fixtures/standalone, upstream's setup), so `t.run` reads `counters`.
//
// The property is upstream's, with fast-check's `fc.assert` in place of `@fast-check/vitest`'s `test.prop`.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline function's ctx is untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import fc from "fast-check";
import { register } from "../src/test.ts";

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
/** A deployment with the component mounted as `shardedCounter`, and its reference. */
function mounted() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return { t, c: register(t) };
}
/** The component's functions as the app's own (`public:add`, …): `t.run` reads its table. */
function standalone() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

describe("counter", () => {
  test("add and subtract", async () => {
    const { t, c } = mounted();
    await t.mutation(c.public.add, { name: "beans", count: 10 });
    await t.mutation(c.public.add, { name: "beans", count: 5 });
    expect(await t.query(c.public.count, { name: "beans" })).toEqual(15);
    await t.mutation(c.public.add, { name: "beans", count: -5 });
    expect(await t.query(c.public.count, { name: "friends" })).toEqual(0);
    await t.mutation(c.public.add, { name: "friends", count: 6, shards: 1 });
    await t.mutation(c.public.add, { name: "friends", count: 2, shards: 1 });
    await t.mutation(c.public.add, { name: "friends", count: 3, shards: 3 });
    expect(await t.query(c.public.count, { name: "beans" })).toEqual(10);
    expect(await t.query(c.public.count, { name: "friends" })).toEqual(11);
  });

  test("respects shard argument", async () => {
    const t = standalone();
    expect(await t.mutation(anyApi.public!.add!, { name: "beans", count: 10, shard: 1 })).toBe(1);
    expect(await t.mutation(anyApi.public!.add!, { name: "beans", count: 5, shard: 2 })).toBe(2);
    const values = await t.run(async (ctx) => {
      const shard = (n: number) =>
        ctx.db
          .query("counters")
          .withIndex("name", (q: any) => q.eq("name", "beans").eq("shard", n))
          .unique();
      return [(await shard(1))?.value, (await shard(2))?.value];
    });
    expect(values).toEqual([10, 5]);
  });

  test("reset", async () => {
    const { t, c } = mounted();
    await t.mutation(c.public.add, { name: "beans", count: 10 });
    await t.mutation(c.public.reset, { name: "beans" });
    expect(await t.query(c.public.count, { name: "beans" })).toEqual(0);
  });
});

test("updates to counter should match in-memory counter which ignores sharding", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          v: fc.integer({ min: -10000, max: 10000 }).map((i) => i / 100),
          key: fc.string(),
          shards: fc.option(fc.integer({ min: 1, max: 100 })),
        }),
      ),
      async (updates) => {
        const { t, c } = mounted();
        try {
          const counter = new Map<string, number>();
          for (const { v, key, shards } of updates) {
            counter.set(key, (counter.get(key) ?? 0) + v);
            await t.mutation(c.public.add, { name: key, count: v, shards: shards ?? undefined });
            expect(await t.query(c.public.count, { name: key })).toBeCloseTo(counter.get(key)!);
          }
          for (const [key, value] of counter) {
            // Rebalancing keeps the count, and makes every estimate exact.
            await t.mutation(c.public.rebalance, { name: key });
            expect(await t.query(c.public.count, { name: key })).toBeCloseTo(value);
            for (let i = 1; i <= 16; i++)
              expect(await t.query(c.public.estimateCount, { name: key, readFromShards: i })).toBeCloseTo(value);
          }
        } finally {
          await t.close();
        }
      },
    ),
    { numRuns: 10 },
  );
}, 120_000);

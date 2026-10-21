// The client (`ShardedCounter`, STUDY-183 §3.2, §3.3): its methods and defaults, `for(name)`, the shard an instance
// remembers per counter, its `shards` / `defaultShards` options, and `trigger(name)` with `@bunvex/helpers`' triggers
// in an app that installs the package by its name (fixtures/app).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { ShardedCounter } from "../src/client/index.ts";
import type { ComponentApi } from "../src/component/_generated/component.ts";
import { register } from "../src/test.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
const deployment = (dir: string) => {
  const t = bunvexTest({ cwd: join(FIXTURES, dir) });
  open.push(t);
  return t;
};

/** Rows of the component's table by counter, as `[shard, value]` (the component's functions as the app's). */
const rows = (t: TestBunvex, name: string) =>
  t.run(async (ctx: any) =>
    ((await ctx.db.query("counters").collect()) as { name: string; shard: number; value: number }[])
      .filter((r) => r.name === name)
      .sort((a, b) => a.shard - b.shard)
      .map((r) => [r.shard, r.value]),
  ) as Promise<[number, number][]>;

describe("ShardedCounter, on the mounted component", () => {
  test("add (1 by default), subtract, inc, dec, count, reset", async () => {
    const t = deployment("standalone");
    const counter = new ShardedCounter<"beans" | "peas">(register(t));
    await t.run(async (ctx: any) => {
      await counter.add(ctx, "beans");
      await counter.add(ctx, "beans", 10);
      await counter.subtract(ctx, "beans");
      await counter.subtract(ctx, "beans", 3);
      await counter.inc(ctx, "beans");
      await counter.dec(ctx, "peas");
    });
    expect(await t.run((ctx: any) => counter.count(ctx, "beans"))).toBe(8);
    expect(await t.run((ctx: any) => counter.count(ctx, "peas"))).toBe(-1);
    // From a query too.
    expect(await t.query((ctx: any) => counter.count(ctx, "beans"))).toBe(8);
    await t.run((ctx: any) => counter.reset(ctx, "beans"));
    expect(await t.query((ctx: any) => counter.count(ctx, "beans"))).toBe(0);
    expect(await t.query((ctx: any) => counter.count(ctx, "peas"))).toBe(-1);
  });

  test("for(name): the same methods with the name given once", async () => {
    const t = deployment("standalone");
    const beans = new ShardedCounter(register(t), { shards: { beans: 4 } }).for("beans");
    await t.run(async (ctx: any) => {
      await beans.add(ctx);
      await beans.add(ctx, 5);
      await beans.subtract(ctx);
      await beans.subtract(ctx, 2);
      await beans.inc(ctx);
      await beans.inc(ctx);
      await beans.dec(ctx);
    });
    expect(await t.query((ctx: any) => beans.count(ctx))).toBe(4);
    await t.run((ctx: any) => beans.rebalance(ctx));
    expect(await t.query((ctx: any) => beans.count(ctx))).toBe(4);
    // Rebalanced over its 4 shards: any one of them, scaled by 4, is the count.
    expect(await t.query((ctx: any) => beans.estimateCount(ctx))).toBe(4);
    expect(await t.query((ctx: any) => beans.estimateCount(ctx, 4))).toBe(4);
    await t.run((ctx: any) => beans.reset(ctx));
    expect(await t.query((ctx: any) => beans.count(ctx))).toBe(0);
  });

  test("from an action too", async () => {
    const t = deployment("standalone");
    const counter = new ShardedCounter(register(t));
    await t.action(async (ctx: any) => {
      await counter.inc(ctx, "beans");
      await counter.add(ctx, "beans", 2);
    });
    expect(await t.action((ctx: any) => counter.count(ctx, "beans"))).toBe(3);
  });

  test("a component mounted under another name", async () => {
    const t = deployment("standalone");
    const a = new ShardedCounter(register(t));
    const b = new ShardedCounter(register(t, "second"));
    await t.run(async (ctx: any) => {
      await a.add(ctx, "beans", 2);
      await b.add(ctx, "beans", 5);
    });
    expect(await t.query((ctx: any) => a.count(ctx, "beans"))).toBe(2);
    expect(await t.query((ctx: any) => b.count(ctx, "beans"))).toBe(5);
  });
});

describe("ShardedCounter, its shards (the component's functions as the app's, rows read)", () => {
  // The client calls `component.public.add`; here `public:add` is the app's own.
  const component = anyApi as unknown as ComponentApi;

  test("an instance keeps writing a counter to the shard its first add picked", async () => {
    const t = deployment("standalone");
    const counter = new ShardedCounter(component, { defaultShards: 10 });
    for (let i = 0; i < 20; i++) await t.run((ctx: any) => counter.add(ctx, "beans"));
    const [only, ...rest] = await rows(t, "beans");
    expect(rest).toEqual([]);
    expect(only![1]).toBe(20);
    // Each counter has its own: another key picks again.
    await t.run((ctx: any) => counter.add(ctx, "peas", 3));
    expect(await rows(t, "peas")).toHaveLength(1);
    // As upstream's example checks it: with one shard of 10 read, the estimate is 10 times all or nothing.
    const e = await t.query(anyApi.public!.estimateCount!, { name: "beans", shards: 10, readFromShards: 1 });
    expect([0, 200]).toContain(e);
  });

  test("fresh instances spread a counter over its shards: `shards` per key, else `defaultShards`", async () => {
    const t = deployment("standalone");
    const options = { shards: { beans: 3 }, defaultShards: 5 };
    for (let i = 0; i < 40; i++)
      await t.run(async (ctx: any) => {
        await new ShardedCounter<"beans" | "peas">(component, options).inc(ctx, "beans");
        await new ShardedCounter<"beans" | "peas">(component, options).inc(ctx, "peas");
      });
    for (const [s] of await rows(t, "beans")) expect(s).toBeLessThan(3);
    for (const [s] of await rows(t, "peas")) expect(s).toBeLessThan(5);
    // `rebalance` and `estimateCount` use the same number of shards.
    const counter = new ShardedCounter<"beans" | "peas">(component, options);
    await t.run(async (ctx: any) => {
      await counter.rebalance(ctx, "beans");
      await counter.rebalance(ctx, "peas");
    });
    expect((await rows(t, "beans")).map(([s]) => s)).toEqual([0, 1, 2]);
    expect((await rows(t, "peas")).map(([s]) => s)).toEqual([0, 1, 2, 3, 4]);
    expect(await t.query((ctx: any) => counter.estimateCount(ctx, "beans"))).toBeCloseTo(40);
    expect(await t.query((ctx: any) => counter.estimateCount(ctx, "peas", 2))).toBeCloseTo(40);
  });

  test("without options: the component's default, 16 shards", async () => {
    const t = deployment("standalone");
    const counter = new ShardedCounter(component);
    await t.run((ctx: any) => counter.add(ctx, "beans", 32));
    await t.run((ctx: any) => counter.rebalance(ctx, "beans"));
    expect(await rows(t, "beans")).toEqual(Array.from({ length: 16 }, (_, i) => [i, 2]));
  });
});

describe("trigger(name), with @bunvex/helpers' Triggers", () => {
  const app = anyApi.users as any;

  test("an insert adds 1, a delete takes 1, an update changes nothing", async () => {
    const t = deployment("app");
    const ids = [];
    for (const name of ["Ada", "Alan", "Grace"]) ids.push(await t.mutation(app.insert, { name }));
    expect(await t.query(app.userCount)).toBe(3);
    await t.mutation(app.rename, { id: ids[0], name: "Ada L." });
    expect(await t.query(app.userCount)).toBe(3);
    await t.mutation(app.remove, { id: ids[1] });
    expect(await t.query(app.userCount)).toBe(2);
    // A write that does not go through the triggers is not counted.
    await t.mutation(app.insertRaw, { name: "Edsger" });
    expect(await t.query(app.userCount)).toBe(2);
  });

  test("the app installs the package by its name, mounted twice: two counters of their own", async () => {
    const t = deployment("app");
    await t.mutation(app.insert, { name: "Ada" });
    await t.mutation(app.bumpOther);
    await t.mutation(app.bumpOther);
    expect(await t.query(app.userCount)).toBe(1);
    expect(await t.query(app.otherCount)).toBe(2);
  });
});

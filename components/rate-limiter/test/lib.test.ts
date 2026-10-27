// Upstream's `src/component/lib.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported to
// `@bunvex/testing`: the component's functions pushed as the app's (fixtures/standalone), each case for both kinds of
// limit, several calls in one `t.run` transaction as upstream makes them. Time moves on the harness's virtual clock;
// upstream's `vi.setSystemTime(x)` is `setTime(t, x)`, which moves the clock to `x` (running nothing: these limits
// are transactional, so nothing is scheduled).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";

const api = anyApi as any;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}
/** Move the virtual clock to `at` (ms), as upstream's `vi.setSystemTime`. */
const setTime = (t: TestBunvex, at: number) => t.advanceTime(at - t.now());
/** The one row of `name`. */
const row = (ctx: any, name: string) =>
  ctx.db
    .query("rateLimits")
    .withIndex("name", (q: any) => q.eq("name", name))
    .unique();

describe.each(["token bucket", "fixed window"] as const)("rateLimit %s", (kind) => {
  test("simple check", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 1, period: SECOND } };
    await t.run(async (ctx: any) => {
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true, retryAfter: undefined });
      expect(await ctx.runMutation(api.lib.rateLimit, args)).toEqual({ ok: true, retryAfter: undefined });
      const after = await ctx.runQuery(api.lib.checkRateLimit, args);
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(0);
    });
  });

  test("simple consume", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 1, period: SECOND } };
    expect(await t.run((ctx: any) => ctx.runMutation(api.lib.rateLimit, args))).toEqual({ ok: true });
    const after = await t.run((ctx: any) => ctx.runMutation(api.lib.rateLimit, args));
    expect(after.ok).toBe(false);
    expect(after.retryAfter).toBeGreaterThan(0);
  });

  test("consume too much", async () => {
    const t = deployment();
    await expect(
      t.run((ctx: any) =>
        ctx.runMutation(api.lib.rateLimit, {
          name: "simple",
          count: 2,
          config: { kind: "fixed window", rate: 1, period: SECOND },
        }),
      ),
    ).rejects.toThrow("Rate limit simple count 2 exceeds 1.");
  });

  test("keyed", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 1, period: SECOND } };
    for (const key of ["key", "key2"]) {
      expect(await t.run((ctx: any) => ctx.runMutation(api.lib.rateLimit, { ...args, key }))).toEqual({ ok: true });
    }
  });

  test("burst", async () => {
    const t = deployment();
    const args = { name: "burst", config: { kind, rate: 1, period: SECOND, capacity: 3 } };
    await t.run(async (ctx: any) => {
      expect(await ctx.runQuery(api.lib.checkRateLimit, { ...args, count: 3 })).toEqual({ ok: true });
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, key: "foo", count: 3 })).toEqual({ ok: true });
      expect((await ctx.runMutation(api.lib.rateLimit, { ...args, key: "foo" })).ok).toBe(false);
    });
  });

  test("retryAfter is accurate", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 10, period: MINUTE } };
    const one = await t.run(async (ctx: any) => {
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 5 })).toEqual({ ok: true });
      return row(ctx, "simple");
    });
    await setTime(t, one.ts + (kind === "token bucket" ? 6 * SECOND : MINUTE));
    const two = await t.run(async (ctx: any) => {
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 6 })).toEqual({ ok: true });
      return row(ctx, "simple");
    });
    expect(two.value).toBe(kind === "token bucket" ? 0 : 4);
    const three = await t.run(async (ctx: any) => {
      // The token bucket waits a minute from now; the fixed window a minute from its window, stored as `ts`.
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 10 })).toEqual({
        ok: false,
        retryAfter: MINUTE,
      });
      return row(ctx, "simple");
    });
    expect(three.value).toBe(two.value);
    expect(three.ts).toBe(two.ts);
  });

  test("retryAfter for reserved is accurate", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 10, period: MINUTE } };
    const one = await t.run(async (ctx: any) => {
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 5 })).toEqual({ ok: true });
      return row(ctx, "simple");
    });
    expect(one.value).toBe(5);
    await setTime(t, one.ts + (kind === "token bucket" ? 6 * SECOND : MINUTE));
    const two = await t.run(async (ctx: any) => {
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 16, reserve: true })).toEqual({
        ok: true,
        retryAfter: MINUTE,
      });
      return row(ctx, "simple");
    });
    expect(two.value).toBe(kind === "token bucket" ? -10 : -6);
    await setTime(t, two.ts + 30 * SECOND);
    const three = await t.run(async (ctx: any) => {
      expect(await ctx.runMutation(api.lib.rateLimit, { ...args, count: 5, reserve: true })).toEqual({
        ok: true,
        retryAfter: kind === "token bucket" ? MINUTE : 30 * SECOND + MINUTE,
      });
      return row(ctx, "simple");
    });
    expect(three.value).toBe(kind === "token bucket" ? -10 : -11);
  });

  test("simple reset", async () => {
    const t = deployment();
    const args = { name: "simple", config: { kind, rate: 1, period: SECOND } };
    await t.run(async (ctx: any) => {
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true });
      await ctx.runMutation(api.lib.resetRateLimit, { name: "simple" });
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true });
    });
  });

  test("keyed reset", async () => {
    const t = deployment();
    const args = { name: "simple", key: "key", config: { kind, rate: 1, period: SECOND } };
    await t.run(async (ctx: any) => {
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true });
      await ctx.runMutation(api.lib.resetRateLimit, { name: "simple", key: "key" });
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true });
    });
  });

  test("reserved without max", async () => {
    const t = deployment();
    const args = { name: "reserved", config: { kind, rate: 1, period: HOUR } };
    await t.run(async (ctx: any) => {
      expect(await ctx.runQuery(api.lib.checkRateLimit, args)).toEqual({ ok: true });
      const reserved = await ctx.runMutation(api.lib.rateLimit, { ...args, count: 100, reserve: true });
      expect(reserved.ok).toBe(true);
      expect(reserved.retryAfter).toBeGreaterThan(0);
      const after = await ctx.runQuery(api.lib.checkRateLimit, args);
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(reserved.retryAfter);
    });
  });

  test("reserved with max", async () => {
    const t = deployment();
    const args = { name: "reserved", config: { kind, rate: 1, period: HOUR, maxReserved: 1 } };
    await t.run(async (ctx: any) => {
      expect((await ctx.runQuery(api.lib.checkRateLimit, { ...args, count: 2, reserve: true })).ok).toBe(true);
      const reserved = await ctx.runMutation(api.lib.rateLimit, { ...args, count: 2, reserve: true });
      expect(reserved.ok).toBe(true);
      expect(reserved.retryAfter).toBeGreaterThan(0);
      expect((await ctx.runQuery(api.lib.checkRateLimit, args)).ok).toBe(false);
    });
  });

  test("consume too much reserved", async () => {
    const t = deployment();
    await expect(
      t.run((ctx: any) =>
        ctx.runMutation(api.lib.rateLimit, {
          name: "simple",
          count: 4,
          reserve: true,
          config: { kind: "fixed window", rate: 1, period: SECOND, maxReserved: 2 },
        }),
      ),
    ).rejects.toThrow("Rate limit simple count 4 exceeds 3.00.");
  });
});

describe("asynchronous configs", () => {
  const config = { kind: "token bucket", rate: 1, period: HOUR, applyUpdates: "asynchronously" } as const;

  test("can't be applied by rateLimit", async () => {
    const t = deployment();
    await expect(t.mutation(api.lib.rateLimit, { name: "async", config })).rejects.toThrow(
      'Rate limit config for async has `applyUpdates: "asynchronously"`. Limit consumption must be enqueued.',
    );
  });

  test("can't be queued when updates are applied transactionally", async () => {
    const t = deployment();
    const update = {
      kind: "consume" as const,
      name: "eager",
      count: 1,
      config: { ...config, applyUpdates: "transactionally" as const },
      ts: Date.now(),
    };
    await expect(t.mutation(api.lib.enqueueUpdates, { updates: [update] })).rejects.toThrow(
      'Rate limit config for eager has `applyUpdates: "transactionally"` and can\'t be enqueued.',
    );
  });

  test("are readable, since the async path checks through the same query", async () => {
    const t = deployment();
    expect(await t.query(api.lib.checkRateLimit, { name: "async", config })).toEqual({ ok: true });
    const { value, config: applied } = await t.query(api.lib.getValue, { name: "async", config });
    expect(value).toBe(1);
    // Collapsed onto the one shard the worker writes.
    expect(applied.shards).toBe(1);
  });
});

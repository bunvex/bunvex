// Upstream's `src/component/internal.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported:
// `checkRateLimitOrThrow` inside a `t.run` transaction over the component's tables pushed as the app's
// (fixtures/standalone), and `_checkRateLimitInternal` as a plain function with `bun:test`'s `setSystemTime` for
// upstream's `vi.setSystemTime`. Rows inserted in a transaction take that transaction's time, as upstream's frozen
// clock gives every call the same one.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { BunvexError } from "@bunvex/values";
import { _checkRateLimitInternal, checkRateLimitOrThrow, MIN_CHOOSE_TWO } from "../src/component/internal.ts";

// Each test pushes its own deployment first, which takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  setSystemTime();
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

describe.each(["token bucket", "fixed window"] as const)("rateLimit %s", (kind) => {
  test("simple check success", async () => {
    const t = deployment();
    const { status, updates } = await t.run((ctx: any) =>
      checkRateLimitOrThrow(ctx.db, { name: "simple", config: { kind, rate: 1, period: SECOND } }),
    );
    expect(status).toEqual({ ok: true, retryAfter: undefined });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ existing: null, shard: 0, value: 0 });
  });

  test("simple check failure", async () => {
    const t = deployment();
    const { status, updates } = await t.run(async (ctx: any) => {
      await ctx.db.insert("rateLimits", { name: "simple", ts: Date.now(), value: 0, shard: 0 });
      return checkRateLimitOrThrow(ctx.db, { name: "simple", config: { kind, rate: 1, period: SECOND } });
    });
    expect(status).toEqual({ ok: false, retryAfter: SECOND });
    expect(updates).toHaveLength(0);
  });

  test("consume too much", async () => {
    const t = deployment();
    await expect(
      t.run((ctx: any) =>
        checkRateLimitOrThrow(ctx.db, {
          name: "simple",
          count: 2,
          config: { kind: "fixed window", rate: 1, period: SECOND },
        }),
      ),
    ).rejects.toThrow("Rate limit simple count 2 exceeds 1.");
  });

  test("keyed: only the key's own row counts", async () => {
    const t = deployment();
    const { status, updates } = await t.run(async (ctx: any) => {
      const ts = Date.now();
      await ctx.db.insert("rateLimits", { name: "simple", key: "key", ts, value: -1, shard: 0 });
      await ctx.db.insert("rateLimits", { name: "simple", ts, value: -1, shard: 0 });
      await ctx.db.insert("rateLimits", { name: "simple", key: "otherKey", ts, value: -1, shard: 0 });
      return checkRateLimitOrThrow(ctx.db, { name: "simple", key: "key", config: { kind, rate: 1, period: SECOND } });
    });
    expect(status).toEqual({ ok: false, retryAfter: 2 * SECOND });
    expect(updates).toHaveLength(0);
  });

  test("burst", () => {
    setSystemTime(new Date(1_765_432_101_234));
    const config = { kind, rate: 1, period: SECOND, capacity: 3 };
    const now = Date.now();
    expect(_checkRateLimitInternal({ ts: now, value: 3 }, config, 3)).toMatchObject({
      status: { ok: true, retryAfter: undefined },
      value: 0,
    });
    expect(_checkRateLimitInternal({ ts: now, value: 3 }, config, 4)).toMatchObject({
      status: { ok: false, retryAfter: SECOND },
      value: -1,
    });
  });

  test("retryAfter is accurate", () => {
    setSystemTime(new Date(1_765_432_101_234));
    const config = { kind, rate: 10, period: MINUTE };
    const one = _checkRateLimitInternal({ ts: Date.now(), value: 10 }, config, 5);
    expect(one.status).toEqual({ ok: true, retryAfter: undefined });
    setSystemTime(new Date(one.ts + (kind === "token bucket" ? 6 * SECOND : MINUTE)));
    const two = _checkRateLimitInternal(one, config, 6);
    expect(two.status).toEqual({ ok: true, retryAfter: undefined });
    expect(two.value).toBe(kind === "token bucket" ? 0 : 4);
    // The token bucket waits a minute from now; the fixed window a minute from its window, stored as `ts`.
    expect(_checkRateLimitInternal(two, config, 10).status).toEqual({ ok: false, retryAfter: MINUTE });
  });

  test("retryAfter for reserved is accurate", () => {
    setSystemTime(new Date(1_765_432_101_234));
    const config = { kind, rate: 10, period: MINUTE };
    const one = _checkRateLimitInternal({ ts: Date.now(), value: 10 }, config, 5);
    expect(one.status).toEqual({ ok: true, retryAfter: undefined });
    setSystemTime(new Date(one.ts + (kind === "token bucket" ? 6 * SECOND : MINUTE)));
    const two = _checkRateLimitInternal(one, config, 16, true);
    expect(two.status).toEqual({ ok: true, retryAfter: MINUTE });
    expect(two.value).toBe(kind === "token bucket" ? -10 : -6);
    setSystemTime(new Date(two.ts + 30 * SECOND));
    const three = _checkRateLimitInternal(two, config, 5, true);
    expect(three.status.retryAfter).toBe(kind === "token bucket" ? MINUTE : 30 * SECOND + MINUTE);
    expect(three.value).toBe(kind === "token bucket" ? -10 : -11);
  });

  test("reserved without max", () => {
    setSystemTime(new Date(1_765_432_101_234));
    const config = { kind, rate: 1, period: HOUR };
    const reserved = _checkRateLimitInternal({ value: 0, ts: Date.now() }, config, 100, true);
    expect(reserved.status.ok).toBe(true);
    expect(reserved.status.retryAfter).toBeGreaterThan(0);
    const followup = _checkRateLimitInternal(reserved, config);
    expect(followup.status.ok).toBe(false);
    expect(followup.status.retryAfter).toBeGreaterThan(reserved.status.retryAfter!);
  });

  test("reserved with max", () => {
    setSystemTime(new Date(1_765_432_101_234));
    const config = { kind, rate: 1, period: HOUR, maxReserved: 1 };
    const reserved = _checkRateLimitInternal({ value: 1, ts: Date.now() }, config, 2, true);
    expect(reserved.status.ok).toBe(true);
    expect(reserved.status.retryAfter).toBeGreaterThan(0);
    const followup = _checkRateLimitInternal(reserved, config);
    expect(followup.status.ok).toBe(false);
    expect(followup.status.retryAfter).toBeGreaterThan(reserved.status.retryAfter!);
  });

  test("consume too much reserved", async () => {
    const t = deployment();
    await expect(
      t.run((ctx: any) =>
        checkRateLimitOrThrow(ctx.db, {
          name: "simple",
          count: 4,
          reserve: true,
          config: { kind: "fixed window", rate: 1, period: SECOND, maxReserved: 2 },
        }),
      ),
    ).rejects.toThrow("Rate limit simple count 4 exceeds 3.00.");
  });
});

describe.each([1, 2, 3, 4] as const)("sharding: %s", (shards) => {
  const name = "simple";
  const config = { kind: "token bucket" as const, rate: 1, period: SECOND, shards, capacity: 10 * shards };
  /** Every shard's row at this transaction's time, then the check. */
  const withShards = (t: TestBunvex, shardValue: (shard: number) => number, args: Record<string, unknown> = {}) =>
    t.run(async (ctx: any) => {
      const ts = Date.now();
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", { name, shard, ts, value: shardValue(shard) });
      }
      return checkRateLimitOrThrow(ctx.db, { name, config, ...args } as never);
    });

  test("success when all shards have enough", async () => {
    const { status, updates } = await withShards(deployment(), () => 1);
    expect(status).toEqual({ ok: true, retryAfter: undefined });
    expect(updates).toHaveLength(1);
  });

  test("unbounded reservations work with shards", async () => {
    const { status, updates } = await withShards(deployment(), () => 0, { reserve: true });
    expect(status.ok).toBe(true);
    expect(status.retryAfter).toBeGreaterThanOrEqual(SECOND);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.value).toBe(-1);
  });

  test("failure when no shards have enough: a BunvexError (Convex's ConvexError, DV-538)", async () => {
    await expect(withShards(deployment(), () => 0, { throws: true })).rejects.toThrow(BunvexError);
  });

  test("success when at least one of the two shards has enough", async () => {
    // The third shard does not have enough.
    const { status, updates } = await withShards(deployment(), (shard) => (shard === 2 ? -1 : 1));
    expect(status).toEqual({ ok: true, retryAfter: undefined });
    expect(updates).toHaveLength(1);
  });

  test("reservations fail when maxed out", async () => {
    const { status, updates } = await withShards(deployment(), () => 1, {
      config: { ...config, maxReserved: 1 },
      count: 3,
      reserve: true,
    });
    expect(status.ok).toBe(false);
    expect(status.retryAfter).toBeGreaterThanOrEqual(SECOND);
    expect(updates).toHaveLength(0);
  });

  test("reservations work if one of the shards has capacity", async () => {
    const { status, updates } = await withShards(deployment(), (shard) => (shard === 2 ? -1 : 1), {
      config: { ...config, maxReserved: shards, rate: shards },
      count: 2,
      reserve: true,
    });
    expect(status).toEqual({ ok: true, retryAfter: SECOND });
    expect(updates).toHaveLength(1);
  });

  if (shards >= MIN_CHOOSE_TWO) {
    test("success when shards have enough put together", async () => {
      const { status, updates } = await withShards(deployment(), () => 0.5);
      expect(status).toEqual({ ok: true, retryAfter: undefined });
      expect(updates).toHaveLength(2);
    });
  }
});

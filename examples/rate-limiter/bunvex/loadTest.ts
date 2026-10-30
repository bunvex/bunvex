// A load test of a sharded limit (Convex's `example/convex/loadTest.ts`): workers in one action call `limit` at
// about `qps` (times `overRequest`), back off for `retryAfter` when refused, and count what passed, what the limit
// refused, and what failed on a write conflict. With enough shards, few calls conflict and the rate that passes is
// the limit's. Run it with `bunx bunvex run loadTest:run '{"qps": 50}'`.
import { type RateLimitConfig, RateLimiter, SECOND } from "@bunvex/rate-limiter";
import { v } from "@bunvex/values";
import { components } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";

const rateLimiter = new RateLimiter(components.rateLimiter);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const run = internalAction({
  args: {
    /** The limit, in calls a second (100). */
    qps: v.optional(v.number()),
    /** How many shards (a shard for every `qpsPerShard`, 2, calls a second). */
    shards: v.optional(v.number()),
    qpsPerShard: v.optional(v.number()),
    /** Tokens a shard holds (10); the period follows from it. */
    shardCapacity: v.optional(v.number()),
    /** How much more than the limit the workers ask for (1.1). */
    overRequest: v.optional(v.number()),
    /** Calls a second each worker makes (5). */
    qpsPerWorker: v.optional(v.number()),
    /** How long to count, in ms (five periods, 10 s at least). */
    duration: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("token bucket"), v.literal("fixed window"))),
  },
  handler: async (ctx, args) => {
    const qps = args.qps ?? 100;
    const shards = args.shards ?? Math.max(1, Math.round(qps / (args.qpsPerShard ?? 2)));
    const shardCapacity = args.shardCapacity ?? 10;
    const period = (shardCapacity / (qps / shards)) * SECOND;
    const duration = args.duration ?? Math.max(10 * SECOND, 5 * period);
    const rate = (period * qps) / SECOND;
    const config: RateLimitConfig = { kind: args.kind ?? "token bucket", rate, period, shards, capacity: rate };
    const workers = Math.ceil(qps / (args.qpsPerWorker ?? 5));
    const workerPeriod = SECOND / ((qps * (args.overRequest ?? 1.1)) / workers);

    await rateLimiter.reset(ctx, "loadTest");
    // The first period fills the buckets; counting starts after it.
    const start = Date.now() + period;
    const end = start + duration;
    const counting = () => Date.now() > start && Date.now() < end;
    const results = await Promise.all(
      Array.from({ length: workers }, async () => {
        const counts = { passed: 0, limited: 0, conflicts: 0 };
        await sleep(Math.random() * period);
        while (Date.now() < end) {
          try {
            const { ok, retryAfter } = await rateLimiter.limit(ctx, "loadTest", { config });
            if (ok) {
              if (counting()) counts.passed++;
              await sleep(workerPeriod * (0.5 + Math.random()));
            } else {
              if (counting()) counts.limited++;
              if (Date.now() + retryAfter >= end) break;
              await sleep(retryAfter * (0.5 + Math.random()));
            }
          } catch {
            if (counting()) counts.conflicts++;
            await sleep(workerPeriod * (0.5 + Math.random()));
          }
        }
        return counts;
      }),
    );
    const total = { passed: 0, limited: 0, conflicts: 0 };
    for (const r of results) {
      total.passed += r.passed;
      total.limited += r.limited;
      total.conflicts += r.conflicts;
    }
    return {
      ...total,
      config,
      workers,
      perSecond: { asked: qps * (args.overRequest ?? 1.1), limit: qps, passed: total.passed / (duration / SECOND) },
    };
  },
});

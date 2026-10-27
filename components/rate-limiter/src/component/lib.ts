// The rate limiter's public functions (STUDY-197 §1.4), with the paths, validators, results and messages of
// Convex's package: `lib:rateLimit`, `lib:checkRateLimit`, `lib:getValue`, `lib:enqueueUpdates`,
// `lib:resetRateLimit`, `lib:clearAll` and `lib:getServerTime`.
import { v } from "@bunvex/values";
import {
  calculateRateLimit,
  configValidator,
  type GetValueReturns,
  getValueReturns,
  rateLimitArgs,
  rateLimitReturns,
  vPendingUpdate,
} from "../shared";
import { api } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { checkRateLimitOrThrow, configWithDefaults, getShard } from "./internal";
import { pingWorker } from "./worker";

/** Check a transactional limit and take its tokens: the shards it changed are written in this transaction. */
export const rateLimit = mutation({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    if (args.config.applyUpdates === "asynchronously") {
      throw new Error(
        `Rate limit config for ${args.name} has \`applyUpdates: "asynchronously"\`. Limit consumption must be enqueued.`,
      );
    }
    const { status, updates } = await checkRateLimitOrThrow(ctx.db, args);
    for (const { value, ts, existing, shard } of updates) {
      if (existing) await ctx.db.patch("rateLimits", existing._id, { ts, value });
      else await ctx.db.insert("rateLimits", { name: args.name, key: args.key, ts, value, shard });
    }
    return status;
  },
});

/** The same check, taking nothing. */
export const checkRateLimit = query({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => (await checkRateLimitOrThrow(ctx.db, args)).status,
});

/**
 * The fullest of `sampleShards` (1 by default) shards picked at random, a missing one counting as full at `ts: 0`.
 * Each is brought to the latest `ts` among them to compare them, not to `Date.now()`, so the query does not depend
 * on the time.
 */
export const getValue = query({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
    config: configValidator,
    sampleShards: v.optional(v.number()),
  },
  returns: getValueReturns,
  handler: async (ctx, args): Promise<GetValueReturns> => {
    const config = configWithDefaults(args.config);
    const samples = Math.min(args.sampleShards || 1, config.shards);
    const left = Array.from({ length: config.shards }, (_, i) => i);
    const picked: number[] = [];
    for (let i = 0; i < samples && left.length > 0; i++) {
      picked.push(left.splice(Math.floor(Math.random() * left.length), 1)[0]!);
    }
    const states = (await Promise.all(picked.map((shard) => getShard(ctx.db, args.name, args.key, shard)))).map(
      (state, i) => state ?? { value: config.capacity, ts: 0, shard: picked[i]! },
    );
    const latest = Math.max(...states.map((s) => s.ts));
    const fullest = states
      .map((state) => ({ state, atLatest: calculateRateLimit(state, config, latest) }))
      .reduce((a, b) => (a.atLatest.value > b.atLatest.value ? a : b));
    // A fixed window with no `start` gets the window of the shard returned (`config` is this call's own copy).
    if (config.kind === "fixed window" && !config.start) config.start = fullest.atLatest.windowStart;
    return { value: fullest.state.value, ts: fullest.state.ts, shard: fullest.state.shard, config };
  },
});

/** Queue updates of asynchronous limits for the worker, then wake it. */
export const enqueueUpdates = mutation({
  args: { updates: v.array(vPendingUpdate) },
  returns: v.null(),
  handler: async (ctx, { updates }) => {
    for (const update of updates) {
      if (update.kind === "consume" && update.config.applyUpdates === "transactionally") {
        throw new Error(
          `Rate limit config for ${update.name} has \`applyUpdates: "transactionally"\` and can't be enqueued.`,
        );
      }
    }
    await Promise.all(
      updates.map((update) => ctx.db.insert("pendingUpdates", { update, updatedAt: ctx.db.vars.commitTs })),
    );
    await pingWorker(ctx);
  },
});

/** Delete every shard of a name and key. */
export const resetRateLimit = mutation({
  args: { name: v.string(), key: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const shards = await ctx.db
      .query("rateLimits")
      .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    for (const shard of shards) await ctx.db.delete("rateLimits", shard._id);
  },
});

/** Delete every limit created up to `before` (now by default), 100 at a time, newest first. */
export const clearAll = mutation({
  args: { before: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rateLimits")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", args.before ?? Date.now()))
      .order("desc")
      .take(100);
    for (const row of rows) await ctx.db.delete("rateLimits", row._id);
    if (rows.length === 100) {
      await ctx.scheduler.runAfter(0, api.lib.clearAll, { before: rows[99]!._creationTime });
    }
  },
});

export { getServerTime } from "./time";

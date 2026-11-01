// The ways an app uses the sharded counter, after the package's own example: a counter per key with `for`, the client
// and the component's functions called directly, a trigger that counts a table, and backfilling the count of rows
// written before the counting started. (The package's example also backfills with the migrations component, which
// bunvex does not have yet; `backfillUsers` below does it by hand.)
import { customCtx, customMutation } from "@bunvex/helpers/server/customFunctions";
import { Triggers } from "@bunvex/helpers/server/triggers";
import { ShardedCounter } from "@bunvex/sharded-counter";
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";

/// The counter: 10 shards for beans, 3 for users, 16 (the default) for any other key.

const counter = new ShardedCounter(components.shardedCounter, {
  shards: { beans: 10, users: 3 },
});
const numUsers = counter.for("users");

/// A trigger keeps the count of `users` as the table changes (`@bunvex/helpers`' triggers).

const triggers = new Triggers<DataModel>();
triggers.register("users", counter.trigger("users"));
export const mutationWithTriggers = customMutation(mutation, customCtx(triggers.wrapDB));

/// The counter of one key.

export const addOne = mutation({
  args: {},
  handler: async (ctx) => {
    await numUsers.inc(ctx);
  },
});

export const getCount = query({
  args: {},
  handler: async (ctx) => await numUsers.count(ctx),
});

export const rebalanceUsers = mutation({
  args: {},
  handler: async (ctx) => {
    await numUsers.rebalance(ctx);
  },
});

export const resetUsers = mutation({
  args: {},
  handler: async (ctx) => {
    await numUsers.reset(ctx);
  },
});

export const estimateUserCount = query({
  args: {},
  handler: async (ctx) => await numUsers.estimateCount(ctx),
});

/// The client with a key per call, and the component's functions called directly.

export const usingClient = internalMutation({
  args: {},
  handler: async (ctx) => {
    await counter.add(ctx, "beans", 2);
    return await counter.count(ctx, "beans");
  },
});

export const usingFunctions = internalMutation({
  args: {},
  handler: async (ctx) => {
    await numUsers.inc(ctx);
    await numUsers.inc(ctx);
    await numUsers.dec(ctx);
    return await numUsers.count(ctx);
  },
});

export const directCall = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.shardedCounter.public.add, { name: "pennies", count: 250 });
    await ctx.runMutation(components.shardedCounter.public.add, { name: "beans", count: 3, shards: 100 });
    return await ctx.runQuery(components.shardedCounter.public.count, { name: "beans" });
  },
});

/// Counting a table that already has rows: new rows counted as they are written, the old ones backfilled.

export const insertUserBeforeBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("users", { name: "Alice" });
  },
});

export const insertUserAfterBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("users", { name: "Alice" });
    await counter.add(ctx, "users");
  },
});

/** A user written while the backfill runs: counted here only if the backfill has already passed it. */
export const insertUserDuringBackfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const id = await ctx.db.insert("users", { name: "Alice" });
    const user = (await ctx.db.get("users", id))!;
    const cursor = await ctx.db.query("backfillCursor").unique();
    if (
      !cursor ||
      cursor.isDone ||
      user._creationTime < cursor.creationTime ||
      (user._creationTime === cursor.creationTime && user._id <= cursor.id)
    )
      await counter.add(ctx, "users");
  },
});

/** One page of the backfill: each user counted, and the cursor moved past it. */
export const backfillUsersBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const backfill = await ctx.db.query("backfillCursor").unique();
    if (!backfill || backfill.isDone) return { isDone: true };
    const { page, isDone, continueCursor } = await ctx.db.query("users").paginate({ cursor: args.cursor, numItems: 3 });
    for (const user of page) {
      await counter.add(ctx, "users");
      await ctx.db.patch("backfillCursor", backfill._id, { isDone, creationTime: user._creationTime, id: user._id });
    }
    return { isDone, continueCursor };
  },
});

export const backfillUsers = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    for (;;) {
      const { isDone, continueCursor }: { isDone: boolean; continueCursor?: string } = await ctx.runMutation(
        internal.example.backfillUsersBatch,
        { cursor },
      );
      if (isDone) break;
      cursor = continueCursor!;
    }
  },
});

/// The trigger at work: inserting a user counts it, with no call to the counter here.

export const insertUserWithTrigger = mutationWithTriggers({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("users", { name: "Alice" });
  },
});

/// One client instance keeps writing a key to the same shard.

export const testStickyShards = internalMutation({
  args: {},
  handler: async (ctx) => {
    await counter.reset(ctx, "beans");
    if ((await counter.count(ctx, "beans")) !== 0) throw new Error("Counter is not reset");
    for (let i = 0; i < 100; i++) await counter.add(ctx, "beans", 1);
    for (let i = 0; i < 100; i++) {
      // One shard of 10 read: all 100 are on it (an estimate of 1000), or none (0).
      const count = await ctx.runQuery(components.shardedCounter.public.estimateCount, {
        name: "beans",
        readFromShards: 1,
        shards: 10,
      });
      if (count !== 1000 && count !== 0) throw new Error(`Unexpected count: ${count}`);
    }
    console.log("testStickyShards passed");
  },
});

// The sharded counter's functions (STUDY-183 §1.1, §3.2), written for bunvex after Convex's
// `@convex-dev/sharded-counter` 0.2.3 (`src/component/public.ts`). Their paths (`public:add`, …), validators, results
// and defaults are Convex's, so an app, the dashboard and the CLI see the same component:
//
// - a counter `name` is spread over shards, one `counters` row each, found by the index `name [name, shard]`;
// - `add` writes to the shard it is given, else to one picked with `Math.random` among `shards` (16 by default), and
//   answers the shard it wrote;
// - `count` sums every shard of the name; `estimateCount` sums a random subset and scales it up;
// - `rebalance` sets every shard below `shards` to an equal share of the total (unrounded) and deletes the shards at
//   or past `shards`;
// - `reset` deletes the name's rows.
//
// Two of Convex's quirks are kept on purpose (Q-3): `rebalance` leaves a row whose shard is negative or not an
// integer as it is (it is neither one of `0..shards-1` nor at or past `shards`), and `estimateCount` lists its shards
// as `Array.from({ length })` does, so a fractional `shards` or `readFromShards` truncates the list but not the
// divisor.
import { v } from "@bunvex/values";
import { mutation, type QueryCtx, query } from "./_generated/server";

/** How many shards a counter has when the caller does not say. */
export const DEFAULT_SHARD_COUNT = 16;

/** Every shard row of the counter `name`, in shard order. */
function rowsOf(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("counters")
    .withIndex("name", (q) => q.eq("name", name))
    .collect();
}

/** The row of one shard of the counter `name`, or null. */
function rowOf(ctx: QueryCtx, name: string, shard: number) {
  return ctx.db
    .query("counters")
    .withIndex("name", (q) => q.eq("name", name).eq("shard", shard))
    .unique();
}

const total = (rows: { value: number }[]) => rows.reduce((sum, row) => sum + row.value, 0);

export const add = mutation({
  args: {
    name: v.string(),
    count: v.number(),
    shard: v.optional(v.number()),
    shards: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, { name, count, shard: given, shards }) => {
    const shard = given ?? Math.floor(Math.random() * (shards ?? DEFAULT_SHARD_COUNT));
    const row = await rowOf(ctx, name, shard);
    if (row === null) await ctx.db.insert("counters", { name, value: count, shard });
    else await ctx.db.patch("counters", row._id, { value: row.value + count });
    return shard;
  },
});

export const count = query({
  args: { name: v.string() },
  returns: v.number(),
  handler: async (ctx, { name }) => total(await rowsOf(ctx, name)),
});

export const rebalance = mutation({
  args: { name: v.string(), shards: v.optional(v.number()) },
  handler: async (ctx, { name, shards }) => {
    const rows = await rowsOf(ctx, name);
    const shardCount = shards ?? DEFAULT_SHARD_COUNT;
    // An equal share, as a plain division: 10 over 3 shards is 3.333… on each.
    const share = total(rows) / shardCount;
    for (let shard = 0; shard < shardCount; shard++) {
      const row = rows.find((r) => r.shard === shard);
      if (row) await ctx.db.patch("counters", row._id, { value: share });
      else await ctx.db.insert("counters", { name, value: share, shard });
    }
    for (const row of rows) if (row.shard >= shardCount) await ctx.db.delete("counters", row._id);
  },
});

export const reset = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const rows = await rowsOf(ctx, name);
    await Promise.all(rows.map((row) => ctx.db.delete("counters", row._id)));
  },
});

export const estimateCount = query({
  args: {
    name: v.string(),
    readFromShards: v.optional(v.number()),
    shards: v.optional(v.number()),
  },
  handler: async (ctx, { name, readFromShards, shards }) => {
    const shardCount = shards ?? DEFAULT_SHARD_COUNT;
    // At least one shard, and no more than there are.
    const sampled = Math.min(Math.max(readFromShards ?? 1, 1), shardCount);
    const picked = shuffled(Array.from({ length: shardCount }, (_, i) => i)).slice(0, sampled);
    let read = 0;
    for (const shard of picked) read += (await rowOf(ctx, name, shard))?.value ?? 0;
    return (read * shardCount) / sampled;
  },
});

/** `items` in a random order (a Fisher–Yates shuffle, in place, from the end). */
function shuffled<T>(items: T[]): T[] {
  for (let last = items.length - 1; last > 0; last--) {
    const other = Math.floor(Math.random() * (last + 1));
    const kept = items[last]!;
    items[last] = items[other]!;
    items[other] = kept;
  }
  return items;
}

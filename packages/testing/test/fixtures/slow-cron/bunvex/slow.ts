import { internalAction, internalMutation, makeFunctionReference, mutation, query } from "@bunvex/server";
import { v } from "@bunvex/values";

const record = makeFunctionReference<"mutation">("slow:recordRow");

/** A cron's run that takes real time: it waits for a slow service, then records its tick. */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    await (await fetch(process.env.SLOW_URL!)).text();
    await ctx.runMutation(record, { table: "ticks" });
  },
});

export const recordRow = internalMutation({
  args: { table: v.union(v.literal("ticks"), v.literal("jobs")) },
  handler: async (ctx, { table }) => {
    await ctx.db.insert(table, { at: Date.now() });
  },
});

export const later = mutation({
  args: { delayMs: v.number() },
  handler: async (ctx, { delayMs }) => {
    await ctx.scheduler.runAfter(delayMs, record, { table: "jobs" });
  },
});

export const ticks = query({ args: {}, handler: async (ctx) => (await ctx.db.query("ticks").collect()).length });

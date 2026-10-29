import { v } from "@bunvex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, mutation } from "./_generated/server";

/** Schedule `followUp` in `delayMs`, first adding a task if asked. */
export const later = mutation({
  args: { delayMs: v.number(), withTask: v.optional(v.boolean()) },
  // The return type is spelled out: `api` refers to this module, so TypeScript cannot infer it.
  handler: async (ctx, { delayMs, withTask }): Promise<Id<"_scheduled_functions">> => {
    if (withTask) await ctx.db.insert("tasks", { author: "scheduler" });
    return await ctx.scheduler.runAfter(delayMs, internal.scheduler.followUp, {});
  },
});

/** Schedule `later` at once, which schedules `followUp` a second after. */
export const chain = mutation({
  args: {},
  handler: async (ctx): Promise<Id<"_scheduled_functions">> =>
    await ctx.scheduler.runAfter(0, api.scheduler.later, { delayMs: 1000, withTask: true }),
});

export const followUp = internalAction({ args: {}, handler: async () => {} });

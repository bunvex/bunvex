// The app of the dashboard tests (STUDY-149 PR 5): scheduled runs of two functions (`ops:workFn`, `ops:otherFn`), a
// table a subscription reads (`ops:list`) and a mutation writes (`ops:send`), for the subscription invalidations.
import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const workRef = makeFunctionReference<"mutation">("ops:workFn");
const otherRef = makeFunctionReference<"mutation">("ops:otherFn");

/** Schedules `count` runs of `ops:workFn` (or `ops:otherFn`), `delayMs` apart from `delayMs` on. */
export const schedule = mutationGeneric({
  args: { count: v.number(), delayMs: v.number(), fn: v.optional(v.string()) },
  handler: async (ctx, { count, delayMs, fn }) => {
    const ids = [];
    for (let i = 0; i < count; i++)
      ids.push(await ctx.scheduler.runAfter(delayMs * (i + 1), fn === "other" ? otherRef : workRef, { i }));
    return ids;
  },
});

export const workFn = mutationGeneric({ args: { i: v.number() }, handler: async () => {} });
export const otherFn = mutationGeneric({ args: { i: v.number() }, handler: async () => {} });

export const send = mutationGeneric({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    await ctx.db.insert("messages", { body });
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("messages").collect()).length,
});

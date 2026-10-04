import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** A named counter's value (0 before its first increment). */
export const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    return counter?.value ?? 0;
  },
});

/** Add one to a named counter, creating it on first use. */
export const increment = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (counter === null) await ctx.db.insert("counters", { name, value: 1 });
    else await ctx.db.patch(counter._id, { value: counter.value + 1 });
  },
});

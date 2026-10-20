// A hot counter: every client bumps the same few rows, so mutations conflict and retry (OCC).
import { mutationGeneric, queryGeneric } from "bunvex/server";
import { v } from "bunvex/values";

export const get = queryGeneric({
  args: { name: v.string() },
  handler: async (ctx, { name }) =>
    (
      await ctx.db
        .query("counters")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique()
    )?.n ?? 0,
});

export const bump = mutationGeneric({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const c = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (c) await ctx.db.patch(c._id, { n: c.n + 1 });
    else await ctx.db.insert("counters", { name, n: 1 });
  },
});

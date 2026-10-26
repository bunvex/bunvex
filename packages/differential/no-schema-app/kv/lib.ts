import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const put = mutation({
  args: { k: v.string() },
  handler: async (ctx, { k }) => {
    await ctx.db.insert("entries", { k });
  },
});

export const byK = query({
  args: { k: v.string() },
  handler: async (ctx, { k }) =>
    (
      await ctx.db
        .query("entries")
        .withIndex("by_k" as never, (q: any) => q.eq("k", k))
        .collect()
    ).map((d) => d.k),
});

import { mutationGeneric as mutation } from "convex/server";
import { v } from "convex/values";

export const add = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    for (let i = 0; i < count; i++) await ctx.db.insert("items", { n: i % 7 });
  },
});

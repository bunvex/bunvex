import { mutationGeneric as mutation } from "convex/server";
import { v } from "convex/values";

export const add = mutation({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    await ctx.db.insert("items", { n });
  },
});

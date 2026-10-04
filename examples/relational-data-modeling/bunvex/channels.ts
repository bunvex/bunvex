import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every channel, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("channels").collect();
  },
});

/** Create a channel; its id is what messages point to. */
export const add = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db.insert("channels", { name });
  },
});

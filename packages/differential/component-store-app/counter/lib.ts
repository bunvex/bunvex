import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const add = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    await ctx.db.insert("messages", { body, n: 1 });
    await ctx.db.insert("counters", { name: body, value: 1 });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("messages").collect()).map((m) => m.body),
});

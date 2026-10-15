// The root's functions, deployed by both backends.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("messages").collect()).map((m) => m.text),
});

export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    await ctx.db.insert("messages", { text });
  },
});

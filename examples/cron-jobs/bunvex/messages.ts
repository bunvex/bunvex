import { v } from "bunvex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

/** Delete every message. Internal: the cron in crons.ts runs it; clients cannot. */
export const clearAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const message of await ctx.db.query("messages").collect()) await ctx.db.delete(message._id);
  },
});

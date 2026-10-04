import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first: what the chat view shows, and what hovering its button prewarms. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("messages").collect();
  },
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

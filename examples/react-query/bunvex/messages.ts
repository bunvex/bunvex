import { v } from "bunvex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<Doc<"messages">[]> => await ctx.db.query("messages").collect(),
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

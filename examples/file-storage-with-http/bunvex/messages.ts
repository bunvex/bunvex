import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first; an image message's body is its file's storage id. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** Post a text message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "text" });
  },
});

/** Post an image already in storage (the `/sendImage` HTTP action stores it first). */
export const sendImage = mutation({
  args: { storageId: v.id("_storage"), author: v.string() },
  handler: async (ctx, { storageId, author }) => {
    await ctx.db.insert("messages", { body: storageId, author, format: "image" });
  },
});

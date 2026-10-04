import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first; an image message carries the URL its file is served at. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    return await Promise.all(
      messages.map(async (m) => (m.format === "image" ? { ...m, url: await ctx.storage.getUrl(m.body) } : m)),
    );
  },
});

/** A short-lived URL the browser POSTs a file to; the response holds the new file's `storageId`. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** Post an uploaded image: the message's body is the file's id. */
export const sendImage = mutation({
  args: { storageId: v.id("_storage"), author: v.string() },
  handler: async (ctx, { storageId, author }) => {
    await ctx.db.insert("messages", { body: storageId, author, format: "image" });
  },
});

/** Post a text message. */
export const sendMessage = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "text" });
  },
});

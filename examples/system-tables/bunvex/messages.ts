import { v } from "bunvex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";

/** Every message; an image's carries its file's URL. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    return await Promise.all(
      messages.map(async (m) =>
        m.format === "image" ? { ...m, url: await ctx.storage.getUrl(m.body as Id<"_storage">) } : m,
      ),
    );
  },
});

/** A short-lived URL the page POSTs a file to; the response holds the file's id. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** Post an uploaded image, and record who uploaded it. */
export const sendImage = mutation({
  args: { file: v.id("_storage"), author: v.string() },
  handler: async (ctx, { file, author }) => {
    await ctx.db.insert("messages", { body: file, author, format: "image" });
    await ctx.db.insert("uploads", { file, author });
  },
});

/** Post a text message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "text" });
  },
});

/** Send a text message in `delaySeconds`: the scheduled job is a document of `_scheduled_functions`. */
export const sendLater = mutation({
  args: { delaySeconds: v.number(), body: v.string(), author: v.string() },
  // The return type is spelled out: `api` refers to this module, so TypeScript cannot infer it.
  handler: async (ctx, { delaySeconds, body, author }): Promise<Id<"_scheduled_functions">> => {
    return await ctx.scheduler.runAfter(delaySeconds * 1000, api.messages.send, { body, author });
  },
});

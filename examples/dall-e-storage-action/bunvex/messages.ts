import { v } from "bunvex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/** Every message, oldest first; a generated image's message carries the URL its stored file is served at. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    return await Promise.all(
      messages.map(async (m) =>
        m.format === "dall-e" ? { ...m, url: await ctx.storage.getUrl(m.body) } : { ...m, url: null },
      ),
    );
  },
});

/** Post a text message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author, format: "text" });
  },
});

/** A generated image's message: its body is the stored file's id. Internal: only the action posts one. */
export const sendDallEMessage = internalMutation({
  args: { storageId: v.id("_storage"), author: v.string(), prompt: v.string() },
  handler: async (ctx, { storageId, author, prompt }) => {
    await ctx.db.insert("messages", { body: storageId, author, prompt, format: "dall-e" });
  },
});

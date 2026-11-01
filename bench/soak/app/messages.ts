// A chat: the latest messages of a channel (what the sync clients subscribe to), sending, full-text search, and the
// cron's trim that keeps the table at a steady size, so memory has no reason to grow with the data.
import { internalMutationGeneric, mutationGeneric, queryGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

/** Messages kept: the trim deletes the oldest beyond this. */
const KEEP = 2000;

export const list = queryGeneric({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(20),
});

export const send = mutationGeneric({
  args: { channel: v.string(), author: v.string(), body: v.string() },
  handler: async (ctx, m) => void (await ctx.db.insert("messages", m)),
});

export const search = queryGeneric({
  args: { text: v.string(), channel: v.string() },
  handler: async (ctx, { text, channel }) =>
    ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("channel", channel))
      .take(10),
});

export const trim = internalMutationGeneric({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("messages")
      .order("desc")
      .take(KEEP + 500);
    for (const m of all.slice(KEEP)) await ctx.db.delete(m._id);
  },
});

import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** One channel's messages, through the `by_channel` index, with the channel's name joined in. */
export const list = query({
  args: { channel: v.id("channels") },
  handler: async (ctx, { channel }) => {
    const parent = await ctx.db.get(channel);
    if (parent === null) return [];
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .collect();
    return messages.map((m) => ({ ...m, channelName: parent.name }));
  },
});

/** Post to a channel. `v.id("channels")` refuses an id of any other table. */
export const send = mutation({
  args: { channel: v.id("channels"), body: v.string(), author: v.string() },
  handler: async (ctx, { channel, body, author }) => {
    await ctx.db.insert("messages", { channel, body, author });
  },
});

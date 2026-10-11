// STUDY-136's end-to-end benchmark app (bench/index-cache-e2e.ts): the in-process bench's chat, as deployed
// functions. `list` takes the user as an argument, so the query cache keeps one result per user and channel,
// as a query that reads ctx.auth does.
import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: { user: v.id("users"), channel: v.id("channels") },
  handler: async (ctx, { user, channel }) => {
    const me = await ctx.db.get(user);
    const settings = await ctx.db.query("settings").first();
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(20);
    return { me: me?.name, slow: settings?.slowMode, n: msgs.length };
  },
});

export const send = mutation({
  args: { user: v.id("users"), channel: v.id("channels") },
  handler: async (ctx, { user, channel }) => {
    const me = await ctx.db.get(user);
    const settings = await ctx.db.query("settings").first();
    const ch = await ctx.db.get(channel);
    if (!me || !ch || settings?.slowMode) throw new Error("refused");
    await ctx.db.insert("messages", { channel, body: "y".repeat(120), m: -1 });
  },
});

/** Seeding: settings once, then batches of channels (with their messages) and users. */
export const seedSettings = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("settings", { maxLen: 2000, slowMode: false });
  },
});
export const seedChannels = mutation({
  args: { from: v.number(), count: v.number(), msgs: v.number() },
  handler: async (ctx, { from, count, msgs }) => {
    const ids = [];
    for (let i = from; i < from + count; i++) {
      const channel = await ctx.db.insert("channels", { name: `c${i}` });
      for (let m = 0; m < msgs; m++) await ctx.db.insert("messages", { channel, body: "x".repeat(120), m });
      ids.push(channel);
    }
    return ids;
  },
});
export const seedUsers = mutation({
  args: { from: v.number(), count: v.number() },
  handler: async (ctx, { from, count }) => {
    const ids = [];
    for (let i = from; i < from + count; i++) ids.push(await ctx.db.insert("users", { name: `u${i}` }));
    return ids;
  },
});

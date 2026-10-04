import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** The 10 messages whose body best matches `query`, by relevance. Live, like any query. */
export const search = query({
  args: { query: v.string() },
  handler: async (ctx, { query }) =>
    await ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", query))
      .take(10),
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

import { v } from "bunvex/values";
import { internalMutation, query } from "./_generated/server";

/** Every post, newest first. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("posts").order("desc").collect(),
});

/** Add a post (internal: only the app's own functions, and tests, call it). */
export const add = internalMutation({
  args: { title: v.string(), content: v.string(), author: v.string() },
  returns: v.id("posts"),
  handler: async (ctx, post) => await ctx.db.insert("posts", post),
});

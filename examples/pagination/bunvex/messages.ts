import { paginationOptsValidator } from "bunvex/server";
import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/** Every message, newest first, a page at a time. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    return await ctx.db.query("messages").order("desc").paginate(paginationOpts);
  },
});

/** One author's messages, newest first: pagination over an index, with an argument of its own. */
export const listByAuthor = query({
  args: { paginationOpts: paginationOptsValidator, author: v.string() },
  handler: async (ctx, { paginationOpts, author }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_author", (q) => q.eq("author", author))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** A page can be reshaped before it is returned: here, initials and shouting. */
export const listShouted = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("messages").order("desc").paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map((m) => ({ author: m.author.slice(0, 1), body: m.body.toUpperCase() })),
    };
  },
});

/** Post a message. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

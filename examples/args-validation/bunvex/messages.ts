import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

/**
 * `args` is checked before the handler runs: a missing field, a field of the wrong type or an extra field
 * is refused with an `ArgumentValidationError`. `returns` checks what the handler gives back.
 */
export const send = mutation({
  args: {
    body: v.string(),
    author: v.string(),
    // Optional: may be left out, but if present it must be a list of strings.
    tags: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, { body, author, tags }) => {
    await ctx.db.insert("messages", { body, author, tags: tags ?? [] });
    return null;
  },
});

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("messages").collect();
  },
});

/** How many messages there are: its `returns` validator promises a number. */
export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    return (await ctx.db.query("messages").collect()).length;
  },
});

import { BunvexError, v } from "bunvex/values";
import { mutation, query } from "./_generated/server";

const MAX_MESSAGES = 20;
const MAX_LENGTH = 50;

/**
 * Every message, but past `MAX_MESSAGES` the query fails with structured data (a `BunvexError` of an object):
 * the client receives the object, to show its own message.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    if (messages.length > MAX_MESSAGES)
      throw new BunvexError({ code: "TOO_MANY_MESSAGES", message: "Too many messages!", count: messages.length });
    return messages;
  },
});

/** Post a message; one that is too long is refused with a `BunvexError` of a string. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    if (body.length > MAX_LENGTH) throw new BunvexError(`A message is at most ${MAX_LENGTH} characters.`);
    await ctx.db.insert("messages", { body, author });
  },
});

/** Delete every message. */
export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    for (const message of await ctx.db.query("messages").collect()) await ctx.db.delete(message._id);
  },
});

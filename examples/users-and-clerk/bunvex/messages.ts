import { v } from "bunvex/values";
import { mutation, query } from "./_generated/server";
import { userOf } from "./users";

/** Post a message as the signed-in (and stored) user. */
export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const identity = await ctx.auth.getUserIdentity();
    const user = identity && (await userOf(ctx, identity.tokenIdentifier));
    if (!user) throw new Error("Sign in to send messages");
    await ctx.db.insert("messages", { body, user: user._id });
  },
});

/** Every message with its author's current name: a join through the users table. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query("messages").collect();
    return await Promise.all(
      messages.map(async (m) => ({ ...m, author: (await ctx.db.get(m.user))?.name ?? "Anonymous" })),
    );
  },
});

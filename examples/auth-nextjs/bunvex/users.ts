import { getAuthUserId } from "@bunvex/auth/server";
import { v } from "@bunvex/values";
import { components } from "./_generated/api";
import { internalMutation, query } from "./_generated/server";

/** The user of a new account: the auth core calls it once, and keeps the id it returns. */
export const createUser = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("password"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", { signedUpAt: Date.now() }),
});

/** The signed-in user and their username, or null when signed out. */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const username = await ctx.runQuery(components.authUsername.public.getUsername, { userId });
    return { id: user._id, username, signedUpAt: user.signedUpAt };
  },
});

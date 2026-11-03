import { getAuthUserId } from "@bunvex/auth/server";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

/** The signed-in user and their username, or null when signed out (or once their session is revoked). */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const username = await ctx.runQuery(components.authUsername.public.getUsername, { userId });
    // Every user of this app signed up with a username.
    if (username === null) throw new Error(`User ${userId} has no username`);
    return { id: user._id, username, signedUpAt: user.signedUpAt };
  },
});

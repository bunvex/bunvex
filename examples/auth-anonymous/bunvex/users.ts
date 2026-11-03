import { getAuthUserId } from "@bunvex/auth/server";
import { v } from "@bunvex/values";
import { internalMutation, mutation, query } from "./_generated/server";

/** The user of a new anonymous account: every anonymous sign-in makes one. */
export const createUser = internalMutation({
  args: { provider: v.object({ name: v.literal("anonymous"), accountId: v.string(), profile: v.object({}) }) },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", { visits: 0 }),
});

/** The signed-in user, or null. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId === null ? null : await ctx.db.get(userId);
  },
});

/** Count a visit on the signed-in user's row: something only a signed-in user can do. */
export const visit = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first");
    const user = (await ctx.db.get(userId))!;
    await ctx.db.patch(userId, { visits: user.visits + 1 });
    return user.visits + 1;
  },
});

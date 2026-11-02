// The app's user callbacks: a user row per account, a row per sign-in.
import { internalMutation } from "@bunvex/server";
import { v } from "@bunvex/values";

const vProvider = v.object({ name: v.string(), accountId: v.string(), profile: v.any() });

export const createUser = internalMutation({
  args: { provider: vProvider },
  returns: v.id("users"),
  handler: async (ctx, { provider }) => await ctx.db.insert("users", { method: provider.name }),
});

export const onSignIn = internalMutation({
  args: { provider: vProvider, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { provider, userId }) => {
    await ctx.db.insert("signIns", { userId, method: provider.name });
    return null;
  },
});

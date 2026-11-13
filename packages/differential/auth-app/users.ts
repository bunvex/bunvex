// The app's user callbacks: a user row per sign-up, a row per sign-in.
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";

const vMethod = v.object({ name: v.string(), profile: v.any() });

export const createUser = internalMutationGeneric({
  args: { method: vMethod },
  returns: v.id("users"),
  handler: async (ctx, { method }) => await ctx.db.insert("users", { method: method.name }),
});

export const onSignIn = internalMutationGeneric({
  args: { method: vMethod, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { method, userId }) => {
    await ctx.db.insert("signIns", { userId, method: method.name });
    return null;
  },
});

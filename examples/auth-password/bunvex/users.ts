import { v } from "@bunvex/values";
import { internalMutation } from "./_generated/server";

/** The user of a new account: the auth core calls it once, at sign-up, and keeps the id it returns. */
export const createUser = internalMutation({
  args: { provider: v.object({ name: v.literal("password"), accountId: v.string(), profile: v.object({}) }) },
  returns: v.id("users"),
  handler: async (ctx) => await ctx.db.insert("users", { signedUpAt: Date.now() }),
});

import type { Id } from "./_generated/dataModel";
import { mutation, type QueryCtx } from "./_generated/server";

/**
 * Save the signed-in user (the page calls it once signed in): a new identity gets a row, a known one has its
 * name kept current. Returns the user's id.
 */
export const store = mutation({
  args: {},
  handler: async (ctx): Promise<Id<"users">> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("users:store needs a signed-in user");
    const name = identity.name ?? "Anonymous";
    const user = await userOf(ctx, identity.tokenIdentifier);
    if (user) {
      if (user.name !== name) await ctx.db.patch(user._id, { name });
      return user._id;
    }
    return await ctx.db.insert("users", { name, tokenIdentifier: identity.tokenIdentifier });
  },
});

/** The user row of a token's identity, if stored. */
export async function userOf(ctx: QueryCtx, tokenIdentifier: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier))
    .unique();
}

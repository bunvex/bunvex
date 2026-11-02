// The username component's functions (STUDY-201 §1.7), v2's: set (unique across users, case and normalization form
// ignored), look up both ways, delete. Refusals are results with a user error, never throws.
import { type Infer, v } from "@bunvex/values";
import type { Doc } from "./_generated/dataModel.ts";
import { mutation, type QueryCtx, query } from "./_generated/server.ts";
import { normalizeUsername, setUsernameUserError, validateUsernameFormat } from "./validation.ts";

const setUsernameResult = v.union(
  v.object({ success: v.literal(true), previousUsername: v.union(v.string(), v.null()) }),
  v.object({ success: v.literal(false), userError: setUsernameUserError }),
);
type SetUsernameResult = Infer<typeof setUsernameResult>;

const byUser = (ctx: QueryCtx, userId: string): Promise<Doc<"usernames"> | null> =>
  ctx.db
    .query("usernames")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

const byNormalized = (ctx: QueryCtx, usernameNormalized: string): Promise<Doc<"usernames"> | null> =>
  ctx.db
    .query("usernames")
    .withIndex("by_usernameNormalized", (q) => q.eq("usernameNormalized", usernameNormalized))
    .unique();

/**
 * Give a user a username, or change theirs (a user has at most one). Another user holding it, whatever its case or
 * normalization form, is `USERNAME_TAKEN` and changes nothing; the same user's name in a new spelling keeps the new
 * spelling. Returns the username it replaced, if any.
 */
export const setUsername = mutation({
  args: { userId: v.string(), username: v.string() },
  returns: setUsernameResult,
  handler: async (ctx, { userId, username }): Promise<SetUsernameResult> => {
    const userError = validateUsernameFormat(username);
    if (userError !== null) return { success: false, userError };
    const usernameNormalized = normalizeUsername(username);
    const holder = await byNormalized(ctx, usernameNormalized);
    if (holder !== null && holder.userId !== userId) return { success: false, userError: { error: "USERNAME_TAKEN" } };
    const current = await byUser(ctx, userId);
    if (current === null) {
      await ctx.db.insert("usernames", { userId, username, usernameNormalized });
      return { success: true, previousUsername: null };
    }
    await ctx.db.patch("usernames", current._id, { username, usernameNormalized });
    return { success: true, previousUsername: current.username };
  },
});

/** The user a username names, its case and normalization form ignored; null when no user has it. */
export const getUserIdByUsername = query({
  args: { username: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { username }): Promise<string | null> =>
    (await byNormalized(ctx, normalizeUsername(username)))?.userId ?? null,
});

/** A user's username, spelled as they gave it; null when they have none. */
export const getUsername = query({
  args: { userId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { userId }): Promise<string | null> => (await byUser(ctx, userId))?.username ?? null,
});

/**
 * Delete a user's username, which no longer finds them and becomes free again. Idempotent: `deleted` is false when
 * they had none.
 */
export const deleteUsername = mutation({
  args: { userId: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, { userId }): Promise<{ deleted: boolean }> => {
    const row = await byUser(ctx, userId);
    if (row === null) return { deleted: false };
    await ctx.db.delete("usernames", row._id);
    return { deleted: true };
  },
});

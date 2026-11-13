// The password component's functions (STUDY-201 §1.6, STUDY-208 §1.11), v2.0.0's: set a user's password (under v2's
// `_internal_dangerous_` name, with the caller's minimum length), check it. Hashes are argon2id PHC strings, v2's byte
// for byte, computed off the JavaScript thread by the runtime (`@bunvex/server/password`, AD-49) with a 16-byte salt
// from the mutation's seeded stream. Refusals are results with a user error, never throws, so a check's rate-limit
// consumption commits.
import { MINUTE, RateLimiter } from "@bunvex/rate-limiter";
import { hashPassword, verifyPassword as matchesHash } from "@bunvex/server/password";
import { type Infer, v } from "@bunvex/values";
import { components } from "./_generated/api.ts";
import type { Doc } from "./_generated/dataModel.ts";
import { mutation, type QueryCtx } from "./_generated/server.ts";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  setPasswordUserError,
  validateNewPassword,
  validatePasswordInputFormat,
  verifyPasswordUserError,
} from "./validation.ts";

// Checks are throttled per user, as https://auth.pilcrowonpaper.com/passwords recommends: a token bucket of 5, refilled
// one a minute (about 500k guesses a year at most), so a legitimate user rarely meets it. Per user id, not per IP
// address (OWASP): an IP limit hurts real users and proxies get around it. Someone can lock a user out this way, so an
// app should offer another way in (a password reset).
const rateLimiter = new RateLimiter(components.rateLimiter, {
  verifyPassword: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 5 },
});

/** The 16 bytes of salt a hash gets, as v2's hasher draws them. */
const SALT_BYTES = 16;

const setPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: setPasswordUserError }),
);
type SetPasswordResult = Infer<typeof setPasswordResult>;

const verifyPasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: verifyPasswordUserError }),
);
type VerifyPasswordResult = Infer<typeof verifyPasswordResult>;

const passwordOf = (ctx: QueryCtx, userId: string): Promise<Doc<"passwords"> | null> =>
  ctx.db
    .query("passwords")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();

/**
 * Set a user's password: a new user's, or a new one replacing theirs. A refused password changes nothing.
 * `minimumLength` is the new password's shortest length, which each caller sets (the password methods give
 * `DEFAULT_MIN_PASSWORD_LENGTH`, 10). Throws when it is not between 8 and 100: the caller's mistake, not the user's.
 *
 * DANGER: it replaces the password of any `userId`, with no proof. App code must not call it: only this package's
 * password methods do, for a user they just created or verified.
 */
export const _internal_dangerous_setPassword = mutation({
  args: { userId: v.string(), password: v.string(), minimumLength: v.number() },
  returns: setPasswordResult,
  handler: async (ctx, { userId, password, minimumLength }): Promise<SetPasswordResult> => {
    const userError = validateNewPassword(password, minimumLength);
    if (userError !== null) return { success: false, userError };
    const passwordHashPHC = await hashPassword(
      normalizePassword(password),
      crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
    );
    const current = await passwordOf(ctx, userId);
    if (current === null) await ctx.db.insert("passwords", { userId, passwordHashPHC });
    else await ctx.db.patch("passwords", current._id, { passwordHashPHC });
    return { success: true };
  },
});

/**
 * Check a user's password, within the rate limit (5 attempts, then one a minute, per user). A user with no password
 * stored is the app's mistake (it owns the mapping to user ids), so it throws.
 */
export const verifyPassword = mutation({
  args: { userId: v.string(), password: v.string() },
  returns: verifyPasswordResult,
  handler: async (ctx, { userId, password }): Promise<VerifyPasswordResult> => {
    const status = await rateLimiter.limit(ctx, "verifyPassword", { key: userId });
    if (!status.ok) return { success: false, userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter } };
    // The format first: a friendlier answer (too short cannot be right), and no hashing of an outsized input. Checked
    // against the component's floor, not the methods' minimum, so a password other systems set still verifies; should
    // the rules ever change, this must still accept the passwords set before.
    const userError = validatePasswordInputFormat(password, MIN_PASSWORD_LENGTH);
    if (userError !== null) return { success: false, userError };
    const row = await passwordOf(ctx, userId);
    if (row === null) throw new Error(`No password stored for userId ${userId}.`);
    if (!(await matchesHash(normalizePassword(password), row.passwordHashPHC)))
      return { success: false, userError: { error: "INVALID_CREDENTIALS" } };
    return { success: true };
  },
});

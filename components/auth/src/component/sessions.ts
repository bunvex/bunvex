// Sessions and the life of their refresh tokens (STUDY-208 §1.3–§1.5), v2.0.0's `component/sessions.ts`: issuing,
// redeeming, retiring and erasing tokens, the cap of sessions per user, and the scheduled erasure of a deleted
// session's tokens (`deleteSessionTokens`, an internal mutation at `sessions:deleteSessionTokens`). `public.ts`'s
// functions build on these.
import { v } from "@bunvex/values";
import { generateRandomToken, sha256Hex } from "../lib/crypto.ts";
import type { TtlConfig } from "../lib/ttl.ts";
import { internal } from "./_generated/api.ts";
import type { Doc, Id } from "./_generated/dataModel.ts";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server.ts";
import { sessionMaxLifetimeExpiresAt } from "./expiry.ts";

/**
 * How many issued tokens a session may have that nobody presented. Each refresh presenting the redeemed token adds one,
 * and presenting an issued one clears them, so the count only grows when answers are lost or refreshes race; at the
 * limit, a refresh revokes the session, unless the redeemed token was redeemed within {@link REFRESH_GRACE_MS}.
 */
export const STANDARD_ISSUED_REFRESH_TOKEN_LIMIT = 3;
/**
 * How long after its redemption a token may be presented again without counting toward
 * {@link STANDARD_ISSUED_REFRESH_TOKEN_LIMIT}: concurrent server-rendered requests carrying one cookie each refresh,
 * and the first to land redeems the token the others present.
 */
export const REFRESH_GRACE_MS = 5 * 1000;
/**
 * How long a spent or dropped token is remembered: past it, its row is pruned, and presenting it reads as an unknown
 * token, which revokes nothing and grants nothing.
 */
export const SPENT_TOKEN_HORIZON_MS = 60 * 60 * 1000;
/**
 * The most sessions a user may have. A sign-in that would pass it first revokes the sessions that refreshed longest
 * ago. It bounds what reads all of a user's sessions (`listSessions`, revoking a user's other sessions), which a user
 * signing in over and over could otherwise push past a transaction's limits.
 */
export const MAX_SESSIONS_PER_USER = 100;

// How many token rows one run of `deleteSessionTokens` erases: well within a transaction's limits.
const TOKEN_DELETION_BATCH_SIZE = 1000;

/** A refresh token, in any state, by its hash. */
export function lookupRefreshTokenByHash(ctx: QueryCtx, hash: string): Promise<Doc<"refreshTokens"> | null> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/** A session's refresh tokens in one state. */
export function sessionTokensInState(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  state: Doc<"refreshTokens">["state"],
): Promise<Doc<"refreshTokens">[]> {
  return ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", state))
    .collect();
}

/**
 * The session's newest issued token: its sign-in's or its latest refresh's, the last of its tokens to go idle (so the
 * session goes idle with it, unless its max lifetime ends it first). Null only for a session with no issued token,
 * which the token lifecycle never leaves.
 */
export async function newestIssuedToken(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"refreshTokens"> | null> {
  // Issued rows have no `retiredAt`: the index orders them by creation, so the last is the newest.
  return await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", "issued"))
    .order("desc")
    .first();
}

/**
 * Make room for one more session of the user: while they have {@link MAX_SESSIONS_PER_USER} or more, erase the one
 * that refreshed longest ago (when its newest issued token was issued, as `listSessions` reports it), so an abandoned
 * session goes before one a client keeps fresh, however old that one is.
 */
export async function evictLeastRecentlyRefreshedSessions(ctx: MutationCtx, userId: string): Promise<void> {
  // Every session of the user, which the cap keeps to `MAX_SESSIONS_PER_USER`.
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  const excess = sessions.length - MAX_SESSIONS_PER_USER + 1;
  if (excess <= 0) return;
  const byLastRefresh: { sessionId: Id<"sessions">; lastRefreshedAt: number }[] = [];
  for (const session of sessions) {
    const newest = await newestIssuedToken(ctx, session._id);
    // A session with no issued token cannot refresh: it goes first.
    byLastRefresh.push({ sessionId: session._id, lastRefreshedAt: newest?._creationTime ?? -Infinity });
  }
  // `sessions` is in creation order and the sort is stable: of sessions last refreshed at one instant, the oldest goes.
  byLastRefresh.sort((a, b) => a.lastRefreshedAt - b.lastRefreshedAt);
  for (const { sessionId } of byLastRefresh.slice(0, excess)) await deleteSession(ctx, sessionId);
  console.warn(
    `Evicted ${excess} session${excess > 1 ? "s" : ""} past the ${MAX_SESSIONS_PER_USER} session limit for a single user`,
  );
}

/**
 * Erase a session, and schedule the erasure of its refresh tokens (`deleteSessionTokens`). The session ends with its
 * row: `refresh` refuses a token whose session is gone, so no token is added to it again, and its token rows only
 * linger until the job reaches them. That keeps this at a few reads and writes however many rows the session holds, so
 * one mutation can erase many sessions. Idempotent: two replays of one leaked token, or a sign-out racing one, may
 * both reach the same session.
 */
export async function deleteSession(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<void> {
  // `delete` throws on a missing id, and whoever raced deleted it already, and scheduled its tokens.
  if ((await ctx.db.get("sessions", sessionId)) === null) return;
  await ctx.db.delete("sessions", sessionId);
  await ctx.scheduler.runAfter(0, internal.sessions.deleteSessionTokens, { sessionId });
}

/**
 * Erase the refresh tokens of a deleted session, a batch at a time, scheduling another run while more may remain. The
 * session is gone, so nothing adds a row to it, and the runs end.
 */
export const deleteSessionTokens = internalMutation({
  args: { sessionId: v.id("sessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const tokens = await ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
      .take(TOKEN_DELETION_BATCH_SIZE);
    for (const row of tokens) await ctx.db.delete("refreshTokens", row._id);
    if (tokens.length === TOKEN_DELETION_BATCH_SIZE)
      await ctx.scheduler.runAfter(0, internal.sessions.deleteSessionTokens, { sessionId });
    return null;
  },
});

/**
 * Prune the session's spent and dropped tokens retired more than the horizon ago. Redeeming a token runs it, so a
 * session that keeps refreshing keeps its own rows trimmed; one that stops keeps them until it is deleted.
 */
export async function pruneRetiredTokens(ctx: MutationCtx, sessionId: Id<"sessions">, now: number): Promise<void> {
  for (const state of ["spent", "dropped"] as const) {
    const old = await ctx.db
      .query("refreshTokens")
      .withIndex("by_session_state", (q) =>
        q
          .eq("sessionId", sessionId)
          .eq("state", state)
          .lte("retiredAt", now - SPENT_TOKEN_HORIZON_MS),
      )
      .collect();
    for (const row of old) await ctx.db.delete("refreshTokens", row._id);
  }
}

/**
 * A new issued refresh token for the session: the token (its hash is stored), and when it expires under the current
 * lifetimes, the sooner of the inactivity timeout from `now` and the session's max lifetime. A later change of either
 * lifetime moves it. Counted from `now`, not the row's `_creationTime`, so it can differ from what `refresh` enforces
 * by a fraction of a millisecond.
 */
export async function issueRefreshToken(
  ctx: MutationCtx,
  session: Pick<Doc<"sessions">, "_id" | "_creationTime">,
  now: number,
  ttl: TtlConfig,
): Promise<{ refreshToken: string; expiresAt: number }> {
  const refreshToken = generateRandomToken();
  await ctx.db.insert("refreshTokens", {
    hash: await sha256Hex(refreshToken),
    sessionId: session._id,
    state: "issued",
  });
  return {
    refreshToken,
    expiresAt: Math.min(
      now + ttl.refreshInactivityTimeoutSeconds * 1000,
      sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds),
    ),
  };
}

/**
 * The first presentation of an issued token: its holder got it, so the session's redeemed token (at most one) becomes
 * spent and its other issued tokens, which nobody should ever present, dropped.
 */
export async function redeem(ctx: MutationCtx, token: Doc<"refreshTokens">, now: number): Promise<void> {
  const redeemed = await sessionTokensInState(ctx, token.sessionId, "redeemed");
  if (redeemed.length > 1) throw new Error("Invariant violation: a session has more than one redeemed refresh token");
  for (const row of redeemed) await ctx.db.patch("refreshTokens", row._id, { state: "spent", retiredAt: now });
  for (const row of await sessionTokensInState(ctx, token.sessionId, "issued"))
    if (row._id !== token._id) await ctx.db.patch("refreshTokens", row._id, { state: "dropped", retiredAt: now });
  await ctx.db.patch("refreshTokens", token._id, { state: "redeemed" });
  await pruneRetiredTokens(ctx, token.sessionId, now);
}

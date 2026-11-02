// The core's functions (STUDY-201 §1.2–§1.4), v2's at the pin: sign-up and sign-in turn a method's verified claims into
// an account and a session; `refresh` rotates the session's refresh token, detecting a leaked one; the rest look up,
// list and revoke. Every message, log line, default and limit is v2's; the access token's audience is bunvex's
// (DV-576). Plain `Error`s only, as v2's core: the methods decide what a user is told.
import type { FunctionHandle } from "@bunvex/server";
import { type GenericId, v } from "@bunvex/values";
import { generateRandomToken, sha256Hex } from "../lib/crypto.ts";
import {
  type AuthClaims,
  type RefreshResult,
  type TokenBundle,
  USE_USER_ID_AS_ACCOUNT_ID,
  vAuthClaims,
  vRefreshResult,
  vTokenBundle,
} from "../lib/types.ts";
import type { Doc, Id } from "./_generated/dataModel.ts";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server.ts";

/** The access token's `aud`: what the app's provider (`bunvexAuthProvider`) expects as its application id. */
const AUDIENCE = "bunvex";
/** The lifetimes when the app sets none (`setupAuth`'s options, passed on every call). */
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** `ctx.auth.signJwt` signs nothing that lives longer: a longer access token is a misconfiguration. */
const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

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

type TokenState = Doc<"refreshTokens">["state"];
type Ttl = { accessTokenTtlSeconds: number; refreshTokenTtlSeconds: number };
type CreateUserHandle = FunctionHandle<"mutation", { provider: { name: string; accountId: string; profile: unknown } }>;
type OnSignInHandle = FunctionHandle<
  "mutation",
  { provider: { name: string; accountId: string; profile: unknown }; userId: GenericId<string> },
  null
>;

const accountOf = (ctx: QueryCtx, provider: string, providerAccountId: string) =>
  ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) => q.eq("provider", provider).eq("providerAccountId", providerAccountId))
    .unique();

const tokenByHash = (ctx: QueryCtx, hash: string) =>
  ctx.db
    .query("refreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();

const tokensIn = (ctx: QueryCtx, sessionId: Id<"sessions">, state: TokenState) =>
  ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId).eq("state", state))
    .collect();

/**
 * The lifetimes of a call: the app's, or the defaults, checked on every call that takes them (a misconfiguration fails
 * every sign-in and refresh, not the setup).
 */
function ttlOf(args: { accessTokenTtlSeconds?: number; refreshTokenTtlSeconds?: number }): Ttl {
  const accessTokenTtlSeconds = args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtlSeconds = args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= 0) throw new Error("Token TTLs must be positive.");
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS)
    throw new Error("Access-token TTL must be at most one hour (the deployment refuses to sign a longer-lived JWT).");
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds)
    throw new Error("Access-token TTL must be shorter than the refresh-token TTL.");
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

/**
 * Erase a session and every refresh token of it. Idempotent: two replays of one leaked token, or a sign-out racing
 * one, may both reach the same session. It reads all of the session's token rows: about the horizon over the refresh
 * interval at the defaults (~60), unbounded in principle.
 */
async function deleteSession(ctx: MutationCtx, sessionId: Id<"sessions">): Promise<void> {
  const rows = await ctx.db
    .query("refreshTokens")
    .withIndex("by_session_state", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of rows) await ctx.db.delete("refreshTokens", row._id);
  // Whoever raced may have deleted it already, and `delete` throws on a missing id.
  if ((await ctx.db.get("sessions", sessionId)) !== null) await ctx.db.delete("sessions", sessionId);
}

/**
 * Prune the session's spent and dropped tokens retired more than the horizon ago. Redeeming a token runs it, so a
 * session that keeps refreshing keeps its own rows trimmed; one that stops keeps them until it is deleted.
 */
async function pruneRetired(ctx: MutationCtx, sessionId: Id<"sessions">, now: number): Promise<void> {
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

/** A new issued refresh token for the session, good for the refresh lifetime: the token, and when it expires. */
async function issueRefreshToken(ctx: MutationCtx, sessionId: Id<"sessions">, now: number, ttl: Ttl) {
  const refreshToken = generateRandomToken();
  const expiresAt = now + ttl.refreshTokenTtlSeconds * 1000;
  await ctx.db.insert("refreshTokens", { hash: await sha256Hex(refreshToken), sessionId, state: "issued", expiresAt });
  return { refreshToken, expiresAt };
}

/**
 * The access token, signed with the deployment's key, which adds `iss` (`<cloud URL>/components/<path>`), `iat` and
 * `exp`. Its subject is the session, not the user: the app finds the user through the session (`getSession`), so a
 * revoked session stops resolving before its tokens expire.
 */
function accessToken(ctx: MutationCtx, sessionId: Id<"sessions">, ttl: Ttl): Promise<string> {
  return ctx.auth.signJwt({ claims: { sub: sessionId, aud: AUDIENCE }, expiresInSeconds: ttl.accessTokenTtlSeconds });
}

/** A new session for the account, its first refresh token (issued, redeemed by its first refresh) and access token. */
async function startSession(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  userId: string,
  ttl: Ttl,
): Promise<TokenBundle> {
  const now = Date.now();
  const sessionId = await ctx.db.insert("sessions", { userId, accountId });
  const { refreshToken, expiresAt } = await issueRefreshToken(ctx, sessionId, now, ttl);
  return {
    accessToken: await accessToken(ctx, sessionId, ttl),
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    userId,
  };
}

/** The callbacks' `provider` argument, from the claims. */
const providerOf = (claims: AuthClaims) => ({
  name: claims.providerName,
  accountId: claims.providerAccountId,
  profile: claims.profile,
});

/**
 * The account and the app's user for an identity the core has not seen: the app's `createUser` makes the user, and
 * this maps the identity to it. With `USE_USER_ID_AS_ACCOUNT_ID`, the account is keyed by that user's id.
 */
async function createAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUser: CreateUserHandle,
): Promise<{ accountId: Id<"accounts">; userId: string }> {
  // A user id is not known before `createUser` runs, and no account is ever stored with an empty identifier: only a
  // method's own identifier can already have one.
  if (
    claims.providerAccountId !== USE_USER_ID_AS_ACCOUNT_ID &&
    (await accountOf(ctx, claims.providerName, claims.providerAccountId)) !== null
  )
    throw new Error(
      `Cannot create an account: an account for provider = ${JSON.stringify(claims.providerName)} and provider ` +
        `account ID = ${JSON.stringify(claims.providerAccountId)} already exists. Sign-in methods that cannot tell a ` +
        "first sign-in from a return visit must look the identity up (getUserIdByAccount) and call signIn instead.",
    );
  const userId = (await ctx.runMutation(createUser, { provider: providerOf(claims) })) as string;
  const provider = claims.providerName;
  const providerAccountId = claims.providerAccountId === USE_USER_ID_AS_ACCOUNT_ID ? userId : claims.providerAccountId;
  // The check for a key only known now; for the others, the same check again.
  const existing = await ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) => q.eq("provider", provider).eq("providerAccountId", providerAccountId))
    .first();
  if (existing !== null)
    throw new Error(
      `Invariant violation: an account for provider = ${JSON.stringify(provider)} and provider account ID = ` +
        `${JSON.stringify(providerAccountId)} already exists`,
    );
  const accountId = await ctx.db.insert("accounts", { provider, providerAccountId, userId });
  return { accountId, userId };
}

/** The app's sign-in callback, when it gave one: every sign-in, the first included, runs it. */
async function notifySignIn(
  ctx: MutationCtx,
  claims: AuthClaims,
  userId: string,
  onSignIn: string | undefined,
): Promise<void> {
  if (onSignIn === undefined) return;
  await ctx.runMutation(onSignIn as OnSignInHandle, {
    provider: providerOf(claims),
    userId: userId as GenericId<string>,
  });
}

const ttlArgs = {
  accessTokenTtlSeconds: v.optional(v.number()),
  refreshTokenTtlSeconds: v.optional(v.number()),
};

/**
 * Sign up an identity the core has not seen: the app's `createUser` makes its user, its `onSignIn` runs, and a session
 * starts. Both callbacks run inside this mutation, so an `onSignIn` that throws undoes the user just made. Methods
 * reach it through the setup's `completeSignUp`, which passes the callbacks. Throws when the identity already has an
 * account (see `signIn`).
 */
export const signUp = mutation({
  args: { claims: vAuthClaims, createUserHandle: v.string(), onSignInHandle: v.optional(v.string()), ...ttlArgs },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = ttlOf(args);
    const { accountId, userId } = await createAccount(ctx, args.claims, args.createUserHandle as CreateUserHandle);
    await notifySignIn(ctx, args.claims, userId, args.onSignInHandle);
    return startSession(ctx, accountId, userId, ttl);
  },
});

/**
 * Sign in an identity that has an account: the app's `onSignIn` runs and a session starts. Methods reach it through
 * the setup's `completeSignIn`. Throws when the identity has no account (see `signUp`).
 */
export const signIn = mutation({
  args: { claims: vAuthClaims, onSignInHandle: v.optional(v.string()), ...ttlArgs },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = ttlOf(args);
    const { claims } = args;
    const account = await accountOf(ctx, claims.providerName, claims.providerAccountId);
    if (account === null)
      throw new Error(
        `Cannot sign in: no account for provider = ${JSON.stringify(claims.providerName)} and provider account ID = ` +
          `${JSON.stringify(claims.providerAccountId)} exists. A first sign-in for an identity must go through signUp.`,
      );
    await notifySignIn(ctx, claims, account.userId, args.onSignInHandle);
    return startSession(ctx, account._id, account.userId, ttl);
  },
});

/**
 * Create the account and the app's user for an identity, as `signUp` does, but start no session and run no `onSignIn`:
 * for a method whose user must finish a step (verify an email) before the first sign-in.
 */
export const signUpWithoutSession = mutation({
  args: { claims: vAuthClaims, createUserHandle: v.string() },
  returns: v.object({ userId: v.string() }),
  handler: async (ctx, args): Promise<{ userId: string }> => {
    const { userId } = await createAccount(ctx, args.claims, args.createUserHandle as CreateUserHandle);
    return { userId };
  },
});

/**
 * The app user of a method identity, or null when it has no account, without starting a session (a password method
 * finds the user before it checks the password). Only the app can call it.
 */
export const getUserIdByAccount = query({
  args: { provider: v.string(), providerAccountId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { provider, providerAccountId }): Promise<string | null> =>
    (await accountOf(ctx, provider, providerAccountId))?.userId ?? null,
});

/**
 * A live session's user, or null: a session is live exactly while its row exists, which sign-out, a leaked token's
 * detection, an expired token's refresh and revocation delete. Only the app can call it.
 */
export const getSession = query({
  args: { sessionId: v.string() },
  returns: v.union(v.object({ userId: v.string() }), v.null()),
  handler: async (ctx, { sessionId }): Promise<{ userId: string } | null> => {
    const id = ctx.db.normalizeId("sessions", sessionId);
    const session = id === null ? null : await ctx.db.get("sessions", id);
    return session === null ? null : { userId: session.userId };
  },
});

/**
 * The first presentation of an issued token: its holder got it, so the session's redeemed token (at most one) becomes
 * spent and its other issued tokens, which nobody should ever present, dropped.
 */
async function redeem(ctx: MutationCtx, token: Doc<"refreshTokens">, now: number): Promise<void> {
  const redeemed = await tokensIn(ctx, token.sessionId, "redeemed");
  if (redeemed.length > 1) throw new Error("Invariant violation: a session has more than one redeemed refresh token");
  for (const row of redeemed) await ctx.db.patch("refreshTokens", row._id, { state: "spent", retiredAt: now });
  for (const row of await tokensIn(ctx, token.sessionId, "issued"))
    if (row._id !== token._id) await ctx.db.patch("refreshTokens", row._id, { state: "dropped", retiredAt: now });
  await ctx.db.patch("refreshTokens", token._id, { state: "redeemed" });
  await pruneRetired(ctx, token.sessionId, now);
}

/**
 * Exchange a refresh token for a new access token and a new issued refresh token. The token presented is:
 *
 * - issued: it is redeemed, then a token is issued;
 * - redeemed: a token is issued and it stays redeemed, so a client whose answer was lost can retry with it, however
 *   late;
 * - spent or dropped: the session's holders diverged, as with a leaked token: the session is revoked;
 * - unknown or expired: no session.
 *
 * Racers presenting one issued token are serialized: the first redeems it, the others find it redeemed, and each gets
 * a token of its own; within {@link REFRESH_GRACE_MS} of the redemption they do not count toward the limit.
 */
export const refresh = mutation({
  args: { refreshToken: v.string(), ...ttlArgs },
  returns: vRefreshResult,
  handler: async (ctx, args): Promise<RefreshResult> => {
    // Checked first: a misconfiguration fails every call.
    const ttl = ttlOf(args);
    const now = Date.now();
    const token = await tokenByHash(ctx, await sha256Hex(args.refreshToken));
    // Never issued, or pruned past the horizon: revoking anything here would let anyone sign anyone out with a made-up
    // string.
    if (token === null) return { kind: "noSession" };
    if (token.state === "spent" || token.state === "dropped") {
      console.warn(
        `${
          token.state === "dropped"
            ? "Dropped refresh token used: a sibling was already redeemed, so the session has forked. "
            : "Spent refresh token used: a later token was already redeemed. "
        }Deleting the associated session. This could be due to a bug or a leaked refresh token.`,
      );
      await deleteSession(ctx, token.sessionId);
      return { kind: "noSession" };
    }
    if (token.expiresAt <= now) {
      await deleteSession(ctx, token.sessionId);
      return { kind: "noSession" };
    }
    if (token.state === "issued") await redeem(ctx, token, now);
    else {
      // Every issued token descends from the redeemed one, so the oldest was issued at its redemption. Issued rows have
      // no `retiredAt`: the index orders them by creation, oldest first, and the limit's worth dates the redemption
      // and counts them.
      const issued = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) => q.eq("sessionId", token.sessionId).eq("state", "issued"))
        .take(STANDARD_ISSUED_REFRESH_TOKEN_LIMIT);
      if (issued.length >= STANDARD_ISSUED_REFRESH_TOKEN_LIMIT && now - issued[0]!._creationTime > REFRESH_GRACE_MS) {
        console.warn(
          `Refresh token used with at least ${issued.length} issued tokens never redeemed: deleting the associated ` +
            "session. This could be due to a bug or a leaked refresh token.",
        );
        await deleteSession(ctx, token.sessionId);
        return { kind: "noSession" };
      }
    }
    // A token row goes with its session, so the session is there. A refresh never writes it: queries reading it stay
    // cached across refreshes.
    const session = (await ctx.db.get("sessions", token.sessionId))!;
    const { refreshToken, expiresAt } = await issueRefreshToken(ctx, session._id, now, ttl);
    return {
      kind: "rotated",
      tokens: {
        accessToken: await accessToken(ctx, session._id, ttl),
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
        userId: session.userId,
      },
    };
  },
});

/**
 * Sign out: revoke the session of a refresh token, whatever its state (a client usually holds an issued token, and
 * one signing out right after another tab refreshed may hold a spent one). An unknown token does nothing. Idempotent.
 */
export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const token = await tokenByHash(ctx, await sha256Hex(args.refreshToken));
    if (token !== null) await deleteSession(ctx, token.sessionId);
    return null;
  },
});

/**
 * A user's sessions, newest first, with when each last refreshed (its newest issued token's creation: the sign-in or
 * the latest refresh, about once per access-token lifetime while a client is connected) and when it expires (that
 * token's expiry). Expired sessions are listed too: the query reads no clock, so it stays cached until a session or a
 * token changes; compare `expiresAt` with the time to keep the active ones. A session with no issued token (never left
 * by the token lifecycle) is left out with a warning. Only the app can call it.
 */
export const listSessions = query({
  args: { userId: v.string() },
  returns: v.array(
    v.object({ sessionId: v.string(), creationTime: v.number(), lastRefreshedAt: v.number(), expiresAt: v.number() }),
  ),
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    const listed = [];
    for (const session of sessions) {
      // Issued rows have no `retiredAt`: the index orders them by creation, so the last is the newest.
      const newest = await ctx.db
        .query("refreshTokens")
        .withIndex("by_session_state", (q) => q.eq("sessionId", session._id).eq("state", "issued"))
        .order("desc")
        .first();
      if (newest === null) {
        console.warn(
          `Session ${session._id} has no issued refresh token, which should be impossible. Leaving it out of the ` +
            "session list.",
        );
        continue;
      }
      listed.push({
        sessionId: session._id,
        creationTime: session._creationTime,
        lastRefreshedAt: newest._creationTime,
        expiresAt: newest.expiresAt,
      });
    }
    return listed;
  },
});

/**
 * Revoke sessions, erasing their refresh tokens, so their holders can no longer refresh; returns the ids that were
 * sessions and were revoked (a malformed, already revoked or repeated id is skipped). It checks no authorization: any
 * user's sessions are revoked. The caller decides which may be, e.g. revoking a user's other sessions only once the
 * user proved they hold the current one. Only the app can call it.
 */
export const revokeSessions = mutation({
  args: { sessionIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const revoked: string[] = [];
    for (const raw of args.sessionIds) {
      const id = ctx.db.normalizeId("sessions", raw);
      if (id === null || (await ctx.db.get("sessions", id)) === null) continue;
      await deleteSession(ctx, id);
      revoked.push(id);
    }
    return revoked;
  },
});

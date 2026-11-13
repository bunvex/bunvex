// The core's functions (STUDY-201 §1.2–§1.4, STUDY-208 §1.3–§1.8), v2.0.0's: sign-up and sign-in turn a method's
// verified claims into a session; `refresh` rotates the session's refresh token, detecting a leaked one; the rest look
// up, list and revoke. Every message, log line, default and limit is v2's; the access token's audience is bunvex's
// (DV-576, `"bunvex-auth"` against v2's `"convex-auth"`). Plain `Error`s only, as v2's core: the methods decide what a
// user is told. The functions that trust their caller carry v2's `_internal_dangerous_` prefix (`fd06a184`).
import type { FunctionHandle } from "@bunvex/server";
import { type GenericId, v } from "@bunvex/values";
import { assertMountedAsCore } from "../lib/coreComponent.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { type TtlConfig, validateTtlConfig, vTtlConfigFields } from "../lib/ttl.ts";
import {
  type AuthClaims,
  type RefreshResult,
  type TokenBundle,
  vAuthClaims,
  vRefreshResult,
  vTokenBundle,
} from "../lib/types.ts";
import type { Id } from "./_generated/dataModel.ts";
import { type MutationCtx, mutation, query } from "./_generated/server.ts";
import { refreshTokenInactivityExpiresAt, sessionMaxLifetimeExpiresAt } from "./expiry.ts";
import {
  deleteSession,
  evictLeastRecentlyRefreshedSessions,
  issueRefreshToken,
  lookupRefreshTokenByHash,
  newestIssuedToken,
  REFRESH_GRACE_MS,
  redeem,
  STANDARD_ISSUED_REFRESH_TOKEN_LIMIT,
} from "./sessions.ts";

// The access token's `aud`: what the app's provider (`bunvexAuthProvider`) expects as its application id.
const AUDIENCE = "bunvex-auth";

type CallbackMethod = { name: string; profile: unknown };
type CreateUserHandle = FunctionHandle<"mutation", { method: CallbackMethod }>;
type OnSignInHandle = FunctionHandle<"mutation", { method: CallbackMethod; userId: GenericId<string> }, null>;

/**
 * The access token, signed with the deployment's key, which adds `iss` (`<cloud URL>/components/auth`), `iat` and
 * `exp`. Its subject is the session, not the user: the app finds the user through the session (`getSession`), so a
 * revoked session stops resolving before its tokens expire. Its issuer is checked to be the core's mount at `auth`.
 */
async function mintAccessToken(ctx: MutationCtx, sessionId: Id<"sessions">, ttlSeconds: number): Promise<string> {
  const token = await ctx.auth.signJwt({ claims: { sub: sessionId, aud: AUDIENCE }, expiresInSeconds: ttlSeconds });
  assertMountedAsCore(token);
  return token;
}

/**
 * A new session for the user, recording the component that authenticated them: room made under the cap first, then
 * its first refresh token (issued, redeemed by its first refresh) and its access token.
 */
async function issueSession(ctx: MutationCtx, userId: string, component: string, ttl: TtlConfig): Promise<TokenBundle> {
  const now = Date.now();
  await evictLeastRecentlyRefreshedSessions(ctx, userId);
  const sessionId = await ctx.db.insert("sessions", { userId, component });
  // Read back for its `_creationTime`, which its max lifetime counts from.
  const session = (await ctx.db.get("sessions", sessionId))!;
  const { refreshToken, expiresAt } = await issueRefreshToken(ctx, session, now, ttl);
  return {
    accessToken: await mintAccessToken(ctx, sessionId, ttl.accessTokenTtlSeconds),
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
    userId,
  };
}

/** The callbacks' `method` argument, from the claims. */
const methodOf = (claims: AuthClaims): CallbackMethod => ({ name: claims.method, profile: claims.profile });

/** The app's user for a new identity, made by its `createUser`: its id. */
async function createAppUser(ctx: MutationCtx, claims: AuthClaims, createUser: CreateUserHandle): Promise<string> {
  return (await ctx.runMutation(createUser, { method: methodOf(claims) })) as string;
}

/** Record the user in `createdUserIds`, unless it is there already. */
async function recordCreatedUserId(ctx: MutationCtx, userId: string): Promise<void> {
  const existing = await ctx.db
    .query("createdUserIds")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (existing === null) await ctx.db.insert("createdUserIds", { userId });
}

/** The app's sign-in callback, when it gave one: every sign-in, the first included, runs it. */
async function notifySignIn(
  ctx: MutationCtx,
  claims: AuthClaims,
  userId: string,
  onSignIn: string | undefined,
): Promise<void> {
  if (onSignIn === undefined) return;
  await ctx.runMutation(onSignIn as OnSignInHandle, { method: methodOf(claims), userId: userId as GenericId<string> });
}

/**
 * Sign up a new identity: the app's `createUser` makes its user, its `onSignIn` runs, and a session starts, recording
 * `componentPath`, the path of the component that authenticated the user (e.g. `"authPassword"`). Both callbacks run
 * inside this mutation, so an `onSignIn` that throws undoes the user just made. The core keeps no identities, so a
 * repeated sign-up makes another user: the method looks the identity up in its own component first, and records the
 * returned `userId` there in the same mutation. Methods reach it through the setup's `completeSignUp`, which passes the
 * callbacks and the lifetimes.
 *
 * DANGER: it trusts `claims`, which reach the app's callbacks. App code must not call it: only this package's sign-in
 * methods do, right after they verify the user.
 */
export const _internal_dangerous_signUp = mutation({
  args: {
    claims: vAuthClaims,
    componentPath: v.string(),
    createUserHandle: v.string(),
    onSignInHandle: v.optional(v.string()),
    ...vTtlConfigFields,
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = validateTtlConfig(args);
    const userId = await createAppUser(ctx, args.claims, args.createUserHandle as CreateUserHandle);
    await recordCreatedUserId(ctx, userId);
    await notifySignIn(ctx, args.claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, args.componentPath, ttl);
  },
});

/**
 * Sign in an existing user: the app's `onSignIn` runs and a session starts, recording `componentPath`. The core does
 * not check `userId`: a wrong one signs the caller in as that user, so a method passes only a user id it looked up
 * once it verified the identity. Methods reach it through the setup's `completeSignIn`.
 *
 * DANGER: it starts a session for any `userId`. App code must not call it: only this package's sign-in methods do,
 * right after they verify the user.
 */
export const _internal_dangerous_signIn = mutation({
  args: {
    claims: vAuthClaims,
    componentPath: v.string(),
    userId: v.string(),
    onSignInHandle: v.optional(v.string()),
    ...vTtlConfigFields,
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = validateTtlConfig(args);
    const { claims, userId } = args;
    if (userId === "") throw new Error("Cannot sign in: no user id was given.");
    await recordCreatedUserId(ctx, userId);
    await notifySignIn(ctx, claims, userId, args.onSignInHandle);
    return await issueSession(ctx, userId, args.componentPath, ttl);
  },
});

/**
 * Make the app's user for a verified identity, as `_internal_dangerous_signUp` does, but start no session and run no
 * `onSignIn`: for a method whose user must finish a step (verify an email) before the first sign-in. The method
 * records the returned `userId` in its own component.
 *
 * DANGER: it trusts `claims`, which reach the app's `createUser`. App code must not call it: only this package's
 * sign-in methods do, right after they verify the user.
 */
export const _internal_dangerous_signUpWithoutSession = mutation({
  args: { claims: vAuthClaims, createUserHandle: v.string() },
  returns: v.object({ userId: v.string() }),
  handler: async (ctx, args): Promise<{ userId: string }> => {
    const userId = await createAppUser(ctx, args.claims, args.createUserHandle as CreateUserHandle);
    await recordCreatedUserId(ctx, userId);
    return { userId };
  },
});

/**
 * Record that a user id is in use. The core records the users it creates and signs in; call this for the others: the
 * users the app imports or creates without the core. Any of the app's code may call it, since it only records that an
 * id exists. Idempotent; an empty id throws.
 */
export const markUserIdCreated = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    if (userId === "") throw new Error("Cannot mark an empty user ID as created.");
    await recordCreatedUserId(ctx, userId);
    return null;
  },
});

/**
 * A live session's user, or null: a session is live exactly while its row exists, which sign-out, a leaked token's
 * detection, an expired token's refresh, the cap of sessions per user and revocation delete. Only the app can call it.
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
 * Exchange a refresh token for a new access token and a new issued refresh token. The token presented is:
 *
 * - issued: it is redeemed, then a token is issued;
 * - redeemed: a token is issued and it stays redeemed, so a client whose answer was lost can retry with it, however
 *   late;
 * - spent or dropped: the session's holders diverged, as with a leaked token: the session is revoked;
 * - unknown, or expired (not refreshed within the inactivity timeout, or past the session's max lifetime): no session.
 *
 * Racers presenting one issued token are serialized: the first redeems it, the others find it redeemed, and each gets
 * a token of its own; within {@link REFRESH_GRACE_MS} of the redemption they do not count toward the limit.
 */
export const refresh = mutation({
  args: { refreshToken: v.string(), ...vTtlConfigFields },
  returns: vRefreshResult,
  handler: async (ctx, args): Promise<RefreshResult> => {
    // Checked first: a misconfiguration fails every call.
    const ttl = validateTtlConfig(args);
    const now = Date.now();
    const token = await lookupRefreshTokenByHash(ctx, await sha256Hex(args.refreshToken));
    // Never issued, or pruned past the horizon: revoking anything here would let anyone sign anyone out with a made-up
    // string.
    if (token === null) return { kind: "noSession" };
    // A session's tokens are erased after its row (`deleteSession`), so a token can outlive it a moment: the session
    // ended already, and there is nothing to refresh or revoke.
    const session = await ctx.db.get("sessions", token.sessionId);
    if (session === null) return { kind: "noSession" };
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
    // A redeemed token's session last refreshed when it issued its newest token: inactivity counts from that one.
    const lastIssued = token.state === "redeemed" ? ((await newestIssuedToken(ctx, session._id)) ?? token) : token;
    if (
      refreshTokenInactivityExpiresAt(lastIssued, ttl.refreshInactivityTimeoutSeconds) <= now ||
      sessionMaxLifetimeExpiresAt(session, ttl.sessionMaxLifetimeSeconds) <= now
    ) {
      await deleteSession(ctx, session._id);
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
    // A refresh never writes the session row: queries reading it stay cached across refreshes.
    const { refreshToken, expiresAt } = await issueRefreshToken(ctx, session, now, ttl);
    return {
      kind: "rotated",
      tokens: {
        accessToken: await mintAccessToken(ctx, session._id, ttl.accessTokenTtlSeconds),
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
    const token = await lookupRefreshTokenByHash(ctx, await sha256Hex(args.refreshToken));
    if (token !== null) await deleteSession(ctx, token.sessionId);
    return null;
  },
});

/**
 * A user's sessions, newest first, with when each last refreshed: its newest issued token's creation, the sign-in or
 * the latest refresh (about once per access-token lifetime while a client is connected, so a rough sign of activity of
 * the client, not of the user). Expired sessions are listed too: the query reads no clock, so it stays cached until a
 * session or a token changes; compare with the time and the lifetimes to keep the active ones. A session with no issued
 * token (never left by the token lifecycle) is left out with a warning. Only the app can call it.
 */
export const listSessions = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ sessionId: v.string(), creationTime: v.number(), lastRefreshedAt: v.number() })),
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    const listed = [];
    for (const session of sessions) {
      const newest = await newestIssuedToken(ctx, session._id);
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
      });
    }
    return listed;
  },
});

/**
 * Revoke sessions, so their holders can no longer refresh (their refresh tokens are erased right after); returns the
 * ids that were sessions and were revoked (a malformed, already revoked or repeated id is skipped). It checks no
 * authorization: any user's sessions are revoked. The caller decides which may be, e.g. revoking a user's other
 * sessions only once the user proved they hold the current one. Only the app can call it.
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

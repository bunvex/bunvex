// The contracts that cross a module boundary of `@bunvex/auth` (STUDY-201 §1.2), as v2's `lib/types.ts`: what the core's
// session functions take and return, and the app's user callbacks. Declared once, used by the core, the methods, the
// server helpers and the clients alike, so they never drift. It imports nothing else of the package, so the server and
// the browser halves can both use it.
import type { FunctionReference_future } from "@bunvex/server";
import { type GenericId, type Infer, v } from "@bunvex/values";

/**
 * What a sign-in or a refresh hands the client: a short-lived access token (its expiry is its `exp` claim), the
 * rotating refresh token with when it expires, and the app user the session is for.
 */
export const vTokenBundle = v.object({
  accessToken: v.string(),
  refreshToken: v.string(),
  refreshTokenExpiresAt: v.number(),
  userId: v.string(),
});

/** A session's tokens, as a sign-in or a refresh returns them. */
export type TokenBundle = Infer<typeof vTokenBundle>;

/**
 * A refresh's outcome:
 *
 * - `rotated`: the new tokens. The token presented stays good until its successor is first presented, so a client that
 *   never received this answer can retry with the token it holds;
 * - `noSession`: the token is unknown, expired, or one nobody should hold any more (which also revoked its session).
 *   The client clears what it stored and treats the user as signed out.
 */
export const vRefreshResult = v.union(
  v.object({ kind: v.literal("rotated"), tokens: vTokenBundle }),
  v.object({ kind: v.literal("noSession") }),
);

/** A refresh's outcome: new tokens, or no session. */
export type RefreshResult = Infer<typeof vRefreshResult>;

/**
 * The identity a sign-in method vouches for once it authenticated someone: what the core turns into an account and a
 * session. Methods never call the core themselves; they produce these claims.
 */
export const vAuthClaims = v.object({
  /** The name the method registers with the core, e.g. `password`. */
  providerName: v.string(),
  /** The method's stable identifier for the account (e.g. a provider's user id). */
  providerAccountId: v.string(),
  /** Whatever the method learned about the user. */
  profile: v.any(),
});

/** A method's verified identity: its name, its account identifier and a profile. */
export type AuthClaims = Infer<typeof vAuthClaims>;

/**
 * The `providerAccountId` of a sign-up whose method has no identifier of its own: the core keys the new account by the
 * app user id `createUser` returns, and later sign-ins name that user id.
 */
export const USE_USER_ID_AS_ACCOUNT_ID = "";

/**
 * The app's mutation that creates its user for an identity the core has not seen, and returns the user's id. It runs
 * once per account, right before the sign-in callback, so it owns only what is true at creation. The core keeps the
 * id as an opaque string; `UsersTable` names the app's table for its type.
 */
export type CreateUserFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  { provider: { name: ProviderName; accountId: string; profile: Profile } },
  GenericId<UsersTable>
>;

/**
 * The app's optional mutation run on every sign-in, the first included (right after its user was created): the place
 * for per-sign-in work (a last-seen time, an audit row, the user's record from the latest `profile`, which the core
 * does not keep). It returns `null`; throwing refuses the sign-in, and on a first one undoes the user just created.
 */
export type OnSignInFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  { provider: { name: ProviderName; accountId: string; profile: Profile }; userId: GenericId<UsersTable> },
  null
>;

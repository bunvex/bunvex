// The contracts that cross a module boundary of `@bunvex/auth` (STUDY-201 §1.2), as v2's `lib/types.ts`: what the core's
// session functions take and return, and the app's user callbacks. Declared once, used by the core, the methods, the
// server helpers and the clients alike, so they never drift. It imports nothing else of the package, so the server and
// the browser halves can both use it.
import type { FunctionReference, FunctionReference_future } from "@bunvex/server";
import { type GenericId, type Infer, type Validator, v } from "@bunvex/values";

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
 * A sign-in that completed, with its tokens. Methods put it in their result union instead of declaring their own, so
 * the tokens are always found in the same place (a server-rendering host's auth proxy reads them there, and refuses a
 * shape it does not know).
 */
export const vSignInComplete = v.object({ status: v.literal("complete"), tokens: vTokenBundle });

/** A completed sign-in and its tokens. */
export type SignInComplete = Infer<typeof vSignInComplete>;

/**
 * A sign-in refused for a reason to show the user: the method's own codes. Every method's results are told apart by
 * the same `status`; the error's shape is the method's.
 *
 * ```ts
 * const signInResult = v.union(
 *   vSignInComplete,
 *   vSignInError(v.object({ error: v.literal("USER_NOT_FOUND") })),
 * );
 * ```
 */
export function vSignInError<UserError extends Validator<unknown, "required">>(userError: UserError) {
  return v.object({ status: v.literal("error"), userError });
}

/** A sign-in refused, with the method's `userError`. */
export type SignInError<UserError> = { status: "error"; userError: UserError };

/** Every sign-in result: completed, or refused with a method's own error. */
export type SignInEnvelope = SignInComplete | SignInError<unknown>;

/** The `status` that tells a sign-in result's arms apart. */
export type SignInStatus = SignInEnvelope["status"];

/**
 * The tokens a server-rendering host's routes hand the browser: a {@link TokenBundle} without the refresh token and its
 * expiry, which stay in an httpOnly cookie.
 */
export type SlimTokenBundle = { accessToken: string; userId: string };

/** A {@link TokenBundle} without its refresh token, so it never reaches the browser. */
export function makeSlimBundle(bundle: TokenBundle): SlimTokenBundle {
  return { accessToken: bundle.accessToken, userId: bundle.userId };
}

/**
 * The body of every session response of a server-rendering host (refresh, sign-out, a refused origin): `tokens` is
 * null when there is no live session.
 */
export type AuthSessionResponse = { tokens: SlimTokenBundle | null };

/**
 * A sign-in result as a client sees it: the tokens narrowed to what every session model delivers (a server-rendering
 * host strips the refresh token), the refused arms unchanged. Handing the tokens to `setSession` is their one use.
 */
export type ClientView<T> = T extends { tokens: TokenBundle } ? Omit<T, "tokens"> & { tokens: SlimTokenBundle } : T;

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

/** The app's `refreshSession` mutation: a refresh token exchanged for new tokens, or no session. */
export type RefreshSessionFn = FunctionReference<"mutation", "public", { refreshToken: string }, RefreshResult>;

/** The app's `signOut` mutation: the session of a refresh token revoked. */
export type SignOutFn = FunctionReference<"mutation", "public", { refreshToken: string }, null>;

/** The app's `isAuthenticated` query: whether the access token it is called with names a live session. */
export type IsAuthenticatedFn = FunctionReference<"query", "public", Record<string, never>, boolean>;

/**
 * The session functions the app exports from `setupAuth`, given to the clients as references (an app may export them
 * under any names).
 */
export type AuthApi = { refreshSession: RefreshSessionFn; signOut: SignOutFn };

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

/**
 * A method's user callbacks, as its `attachUserCallbacks` takes them: `createUser` is required (something must make
 * the user), `onSignIn` is optional.
 */
export type UserCallbacks<Provider extends string, Profile, UsersTable extends string = string> = {
  createUser: CreateUserFn<Provider, Profile, UsersTable>;
  onSignIn?: OnSignInFn<Provider, Profile, UsersTable>;
};

/** What a method's handlers find on `ctx.bunvexAuth`: how a method turns an identity it verified into a session. */
export type BoundAuthHelpers<Profile> = {
  /**
   * A session for an identity the method has just established: the core records the account, the app's `createUser`
   * makes the user, its `onSignIn` runs, and the client's tokens come back. Throws when the identity already has an
   * account; a method that cannot tell a first visit from a return one calls `resolveUserId` first.
   */
  completeSignUp(args: { providerAccountId: string; profile: Profile }): Promise<TokenBundle>;
  /**
   * A session for an existing account the method authenticated its own way: the core finds its user, the app's
   * `onSignIn` runs, and the client's tokens come back. Throws when the identity has no account: reaching this is the
   * method's claim that it does, so a miss is a bug, not a failed sign-in.
   */
  completeSignIn(args: { providerAccountId: string; profile: Profile }): Promise<TokenBundle>;
  /**
   * The account and the app's user for a verified identity, without a session, for a user who must finish a step (an
   * email check) first: as `completeSignUp`, but no `onSignIn`. The method signs them in later with `completeSignIn`.
   */
  signUpWithoutSession(args: { providerAccountId: string; profile: Profile }): Promise<{ userId: string }>;
  /** The app user of one of this method's account identifiers, or null. */
  resolveUserId(providerAccountId: string): Promise<string | null>;
  /**
   * Revoke the signed-in user's sessions but the current one (the token's subject); returns how many active ones were
   * revoked (expired ones are deleted, not counted), 0 when not signed in. Call it only once the user proved they hold
   * this session (an authentication method confirmed): a stolen session must not revoke the others.
   *
   * @internal
   */
  revokeOtherSessions(): Promise<number>;
  /**
   * Revoke all of a user's sessions, the caller's own included; returns how many active ones were revoked (expired
   * ones are deleted, not counted). For flows that prove the account is theirs without a trusted session (password
   * recovery): revoke before starting the new session. It checks no authorization.
   *
   * @internal
   */
  revokeAllSessions(userId: string): Promise<number>;
};

/** What `authMutation` adds to a method's handlers' `ctx`: its helpers, on `ctx.bunvexAuth`. */
export type BunvexAuthCtx<Profile> = { bunvexAuth: BoundAuthHelpers<Profile> };

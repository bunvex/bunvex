// `setupAuth` (STUDY-201 §1.5), v2's `setupConvexAuth` in bunvex's words (rule 5, C-4): the app's session functions
// (`refreshSession`, `signOut`, `isAuthenticated`) over the core component, and the binding of each sign-in method,
// whose mutations find their helpers on `ctx.bunvexAuth` (v2's `ctx.convexAuth`). The callbacks' handles are made on
// each call; the token lifetimes are passed on every core call, checked there (not at setup), as v2's.
import {
  createFunctionHandle,
  type GenericDataModel,
  type GenericMutationCtx,
  mutationGeneric,
  queryGeneric,
  type RegisteredMutation,
  type RegisteredQuery,
  type ReturnValueForOptionalValidator,
} from "@bunvex/server";
import { type ObjectType, type PropertyValidators, type Validator, v } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import {
  type BunvexAuthCtx,
  type RefreshResult,
  type TokenBundle,
  type UserCallbacks,
  vRefreshResult,
} from "../lib/types.ts";
import { getAuthUserId } from "./userId.ts";

/**
 * A builder of a method's public mutations, whose handlers get the method's helpers on `ctx.bunvexAuth`. As a
 * mutation builder's, with `args` required and no app data model (a method's storage is its own component's).
 *
 * @internal
 */
export type AuthMutationBuilder<Profile> = <
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends PropertyValidators | Validator<unknown, "required"> | void,
  ReturnValue extends
    ReturnValueForOptionalValidator<ReturnsValidator> = ReturnValueForOptionalValidator<ReturnsValidator>,
>(fn: {
  args: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericMutationCtx<GenericDataModel> & BunvexAuthCtx<Profile>,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValue;
}) => RegisteredMutation<"public", ObjectType<ArgsValidator>, ReturnValue>;

/**
 * The builders a method gets from `bindProvider`.
 *
 * @internal
 */
export type MethodBuilders<Profile> = { authMutation: AuthMutationBuilder<Profile> };

/** What `setupAuth` returns: the session functions the app exports, and what the sign-in methods bind to. */
export type AuthCore<UsersTable extends string = string> = {
  /** The app's users table, as given to `setupAuth`: methods infer it from the core they are handed. */
  usersTable: UsersTable;
  /**
   * The core component, as given to `setupAuth`: the methods find the user with it, wherever the app mounts it.
   *
   * @internal
   */
  component: ComponentApi;
  /** Sign out of a session: its refresh token stops working. */
  signOut: RegisteredMutation<"public", { refreshToken: string }, Promise<null>>;
  /**
   * Refresh a session, rotating its refresh token: new tokens to keep, or no session (signed out). The token presented
   * keeps working until the new one is first used, so a lost answer can be retried.
   */
  refreshSession: RegisteredMutation<"public", { refreshToken: string }, Promise<RefreshResult>>;
  /**
   * Whether the caller's access token names a live session. The deployment checks the token's signature before the
   * query runs, so the answer can be trusted (a server-rendering host asks it rather than decoding a cookie). It reads
   * the session, so it turns false (and a subscription re-runs) once the session is gone, even while the token is valid.
   */
  isAuthenticated: RegisteredQuery<"public", Record<string, never>, Promise<boolean>>;
  /**
   * Bind a sign-in method to the core and get its builders. `name` keys the method's accounts, so it is unique among
   * the methods of one core (a second throws at once). Methods call it from their `attachUserCallbacks`, once the app
   * gave its callbacks; an app does not call it.
   *
   * @internal
   */
  bindProvider<Provider extends string, Profile>(
    options: { name: Provider } & UserCallbacks<Provider, Profile, UsersTable>,
  ): MethodBuilders<Profile>;
};

/**
 * The app's auth: the session functions to export, and the core the sign-in methods bind to. A method verifies a user
 * its own way, then trades the identity for a session through the helpers on `ctx.bunvexAuth`.
 *
 * ```ts
 * const auth = setupAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signUpWithUsernamePassword, signInWithUsernamePassword } = setupUsernamePassword(auth, {
 *   component: components.authPassword,
 *   usernameComponent: components.authUsername,
 * }).attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * ```
 *
 * Access tokens last a minute and refresh tokens 30 days, unless set here; the access token must be the shorter, and
 * well over a few seconds (clients refresh shortly before it expires). A change applies to tokens issued after it.
 */
export function setupAuth<UsersTable extends string = "users">(options: {
  component: ComponentApi;
  /**
   * The app's users table (`users` by default). The core never reads it; the name types the methods' `createUser` (it
   * returns an `Id<usersTable>`) and `onSignIn` (it takes one).
   */
  usersTable?: UsersTable;
  /** The access token's lifetime, in seconds (60 by default). */
  accessTokenTtlSeconds?: number;
  /** The refresh token's lifetime, in seconds (30 days by default). */
  refreshTokenTtlSeconds?: number;
}): AuthCore<UsersTable> {
  const { component, accessTokenTtlSeconds, refreshTokenTtlSeconds } = options;
  const usersTable = options.usersTable ?? ("users" as UsersTable);
  const ttl = { accessTokenTtlSeconds, refreshTokenTtlSeconds };

  const refreshSession = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: vRefreshResult,
    handler: async (ctx, { refreshToken }): Promise<RefreshResult> =>
      await ctx.runMutation(component.public.refresh, { refreshToken, ...ttl }),
  });

  const signOut = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: v.null(),
    handler: async (ctx, { refreshToken }) => {
      await ctx.runMutation(component.public.signOut, { refreshToken });
      return null;
    },
  });

  // In the app, not the component: only there is `ctx.auth` the caller's verified identity.
  const isAuthenticated = queryGeneric({
    args: {},
    returns: v.boolean(),
    handler: async (ctx): Promise<boolean> => (await getAuthUserId(ctx, component)) !== null,
  });

  // This core's methods: two sharing a name would share accounts.
  const bound = new Set<string>();

  const bindProvider = <Provider extends string, Profile>({
    name,
    createUser,
    onSignIn,
  }: { name: Provider } & UserCallbacks<Provider, Profile, UsersTable>): MethodBuilders<Profile> => {
    if (bound.has(name))
      throw new Error(
        `A sign-in method named "${name}" is already bound to this auth core. Method names key the accounts table, so ` +
          "each method must have a unique name.",
      );
    bound.add(name);

    // None when the app gave no `onSignIn`: the core then starts the session without telling the app.
    const onSignInHandle = async () => (onSignIn === undefined ? undefined : await createFunctionHandle(onSignIn));
    const claims = (providerAccountId: string, profile: Profile) => ({
      providerName: name,
      providerAccountId,
      profile,
    });

    /** Revoke the sessions listed; how many of them were revoked while still active (expired ones are not counted). */
    const revokeListed = async (
      ctx: GenericMutationCtx<GenericDataModel>,
      sessions: { sessionId: string; expiresAt: number }[],
    ): Promise<number> => {
      if (sessions.length === 0) return 0;
      const revoked = new Set(
        await ctx.runMutation(component.public.revokeSessions, { sessionIds: sessions.map((s) => s.sessionId) }),
      );
      const now = Date.now();
      return sessions.filter((s) => revoked.has(s.sessionId) && s.expiresAt > now).length;
    };

    const helpers = (ctx: GenericMutationCtx<GenericDataModel>): BunvexAuthCtx<Profile>["bunvexAuth"] => ({
      completeSignUp: async ({ providerAccountId, profile }): Promise<TokenBundle> =>
        await ctx.runMutation(component.public.signUp, {
          claims: claims(providerAccountId, profile),
          createUserHandle: await createFunctionHandle(createUser),
          onSignInHandle: await onSignInHandle(),
          ...ttl,
        }),
      completeSignIn: async ({ providerAccountId, profile }): Promise<TokenBundle> =>
        await ctx.runMutation(component.public.signIn, {
          claims: claims(providerAccountId, profile),
          onSignInHandle: await onSignInHandle(),
          ...ttl,
        }),
      signUpWithoutSession: async ({ providerAccountId, profile }) =>
        await ctx.runMutation(component.public.signUpWithoutSession, {
          claims: claims(providerAccountId, profile),
          createUserHandle: await createFunctionHandle(createUser),
        }),
      resolveUserId: async (providerAccountId) =>
        await ctx.runQuery(component.public.getUserIdByAccount, { provider: name, providerAccountId }),
      revokeOtherSessions: async () => {
        const identity = await ctx.auth.getUserIdentity();
        if (identity === null) return 0;
        const current = identity.subject;
        // A revoked session cannot sign the others out.
        const session = await ctx.runQuery(component.public.getSession, { sessionId: current });
        if (session === null) return 0;
        const sessions = await ctx.runQuery(component.public.listSessions, { userId: session.userId });
        return await revokeListed(
          ctx,
          sessions.filter((s) => s.sessionId !== current),
        );
      },
      revokeAllSessions: async (userId) =>
        await revokeListed(ctx, await ctx.runQuery(component.public.listSessions, { userId })),
    });

    // The builder's types are the caller's (its validators'); the registered mutation's, widened by the cast of `args`, are not.
    const authMutation: AuthMutationBuilder<Profile> = (fn) =>
      mutationGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler({ ...ctx, bunvexAuth: helpers(ctx) }, args as Parameters<typeof fn.handler>[1]),
      }) as never;

    return { authMutation };
  };

  return { usersTable, component, signOut, refreshSession, isAuthenticated, bindProvider };
}

// `setupAuth` (STUDY-201 §1.5, STUDY-208 §1.2, §1.6, §1.7), v2.0.0's `setupConvexAuth` in bunvex's words (rule 5, C-4):
// the app's session functions (`refreshSession`, `signOut`, `isAuthenticated`) over the core component, and the
// binding of each sign-in method (`bindMethod`), whose mutations find their helpers on `ctx.bunvexAuth` (v2's
// `ctx.convexAuth`). The token and session lifetimes are resolved and checked when `setupAuth` runs, as the app's
// modules load, so a bad configuration fails the push; every core call passes them. The callbacks' handles are made
// on each call.
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
import { componentPathOf } from "../lib/componentPath.ts";
import { resolveTtlConfig } from "../lib/ttl.ts";
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
 * The builders a method gets from `bindMethod`.
 *
 * @internal
 */
export type MethodBuilders<Profile> = { authMutation: AuthMutationBuilder<Profile> };

/** What `setupAuth` returns: the session functions the app exports, and what the sign-in methods bind to. */
export type AuthCore<UsersTable extends string = string> = {
  /** The app's users table, as given to `setupAuth`: methods infer it from the core they are handed. */
  usersTable: UsersTable;
  /**
   * The core component, as given to `setupAuth`: the methods find the user with it. The app mounts it as `auth`.
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
   * Bind a sign-in method to the core and get its builders. The app's callbacks get `name` as `method.name`, so it is
   * unique among the methods of one core (a second throws at once). Methods call it from their `attachUserCallbacks`,
   * once the app gave its callbacks; an app does not call it.
   *
   * @internal
   */
  bindMethod<MethodName extends string, Profile>(
    options: { name: MethodName } & UserCallbacks<MethodName, Profile, UsersTable>,
  ): MethodBuilders<Profile>;
};

/**
 * The app's auth: the session functions to export, and the core the sign-in methods bind to. A method verifies a user
 * its own way, looks the identity up in its own component, then trades it for a session through the helpers on
 * `ctx.bunvexAuth`: `completeSignUp` for a new identity, `completeSignIn` for a known one.
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
 * Access tokens last a minute and sessions at most 30 days, unless set here. The refresh inactivity timeout is the max
 * lifetime unless set, and at most it; the access token is shorter than the timeout, and well over a few seconds
 * (clients refresh shortly before it expires). The lifetimes are checked here, so a bad one fails the push. A changed
 * access-token lifetime applies to the tokens minted after it; the session lifetimes apply to every session, those
 * already started included.
 */
export function setupAuth<UsersTable extends string = "users">(options: {
  component: ComponentApi;
  /**
   * The app's users table (`users` by default). The core never reads it; the name types the methods' `createUser` (it
   * returns an `Id<usersTable>`) and `onSignIn` (it takes one).
   */
  usersTable?: UsersTable;
  /**
   * The access token's lifetime, in seconds (60 by default). A change applies to the tokens minted after it.
   */
  accessTokenTtlSeconds?: number;
  /**
   * How long a session may go without a refresh before it ends, in seconds: the session's max lifetime by default, and
   * at most it. A connected client refreshes about once per access-token lifetime, so this is how long a client may stay
   * away (closed, offline, asleep) and still resume. A change applies to every session: lowered, it ends the sessions
   * that went longer without a refresh.
   */
  refreshInactivityTimeoutSeconds?: number;
  /**
   * How long a session may last, in seconds (30 days by default), however often it refreshes: then the user signs in
   * again. A change applies to every session, counted from its creation.
   */
  sessionMaxLifetimeSeconds?: number;
}): AuthCore<UsersTable> {
  const { component } = options;
  // When the app's modules load: a bad configuration fails the push, not the first sign-in.
  const ttl = resolveTtlConfig(options);
  const usersTable = options.usersTable ?? ("users" as UsersTable);

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

  // This core's methods: the callbacks could not tell two of one name apart.
  const bound = new Set<string>();

  const bindMethod = <MethodName extends string, Profile>({
    name,
    createUser,
    onSignIn,
  }: { name: MethodName } & UserCallbacks<MethodName, Profile, UsersTable>): MethodBuilders<Profile> => {
    if (bound.has(name))
      throw new Error(
        `A sign-in method named "${name}" is already bound to this auth core. The app's callbacks get the name of the ` +
          "sign-in method as `method.name`, so each sign-in method must have a unique name.",
      );
    bound.add(name);

    // None when the app gave no `onSignIn`: the core then starts the session without telling the app.
    const onSignInHandle = async () => (onSignIn === undefined ? undefined : await createFunctionHandle(onSignIn));
    const claims = (profile: Profile) => ({ method: name, profile });

    /**
     * Revoke the sessions listed; how many of them were revoked while still active (expired ones are not counted): a
     * session expires one inactivity timeout after it last refreshed, or one max lifetime after it was created.
     */
    const revokeListed = async (
      ctx: GenericMutationCtx<GenericDataModel>,
      sessions: { sessionId: string; creationTime: number; lastRefreshedAt: number }[],
    ): Promise<number> => {
      if (sessions.length === 0) return 0;
      const revoked = new Set(
        await ctx.runMutation(component.public.revokeSessions, { sessionIds: sessions.map((s) => s.sessionId) }),
      );
      const inactivityMs = ttl.refreshInactivityTimeoutSeconds * 1000;
      const maxLifetimeMs = ttl.sessionMaxLifetimeSeconds * 1000;
      const now = Date.now();
      return sessions.filter(
        (s) =>
          revoked.has(s.sessionId) && s.lastRefreshedAt + inactivityMs > now && s.creationTime + maxLifetimeMs > now,
      ).length;
    };

    const helpers = (ctx: GenericMutationCtx<GenericDataModel>): BunvexAuthCtx<Profile>["bunvexAuth"] => ({
      completeSignUp: async ({ profile, authenticatedBy }): Promise<TokenBundle> =>
        await ctx.runMutation(component.public._internal_dangerous_signUp, {
          claims: claims(profile),
          componentPath: componentPathOf(authenticatedBy),
          createUserHandle: await createFunctionHandle(createUser),
          onSignInHandle: await onSignInHandle(),
          ...ttl,
        }),
      completeSignIn: async ({ userId, profile, authenticatedBy }): Promise<TokenBundle> =>
        await ctx.runMutation(component.public._internal_dangerous_signIn, {
          claims: claims(profile),
          componentPath: componentPathOf(authenticatedBy),
          userId,
          onSignInHandle: await onSignInHandle(),
          ...ttl,
        }),
      signUpWithoutSession: async ({ profile }) =>
        await ctx.runMutation(component.public._internal_dangerous_signUpWithoutSession, {
          claims: claims(profile),
          createUserHandle: await createFunctionHandle(createUser),
        }),
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

  return { usersTable, component, signOut, refreshSession, isAuthenticated, bindMethod };
}

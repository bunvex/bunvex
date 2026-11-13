// The anonymous method's server side (STUDY-201 §1.9, STUDY-208 §1.14), v2.0.0's `setupAnonymous`: every call creates a
// user and its session, then records the user in the anonymous component, with no way back to it.
// Not exported since Convex Auth 2.0.0 hid the anonymous method until account linking (`bff2ce56`, STUDY-208 D-3): the
// source stays, as v2's does, for its tests.
import type { ComponentApi } from "../../components/anonymous/_generated/component.ts";
import { type SignInComplete, type UserCallbacks, vSignInComplete } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";

// The method's name: the app's callbacks get it as `method.name` (v2's, as is).
const METHOD_NAME = "anonymous";

/**
 * Anonymous sign-in: a session with no credentials asked. A user cannot come back to an anonymous account later.
 *
 * ```ts
 * const auth = setupAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signInAnonymously } = setupAnonymous(auth, {
 *   component: components.authAnonymous,
 * }).attachUserCallbacks({ createUser: internal.users.createUserAnonymous });
 * ```
 *
 * @internal Not public until the anonymous sign-in method is ready.
 */
export function setupAnonymous<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: {
    /** The mounted anonymous component (`components.authAnonymous`). */
    component: ComponentApi;
  },
) {
  const { component } = options;
  return {
    /**
     * Give the app's user callbacks and get the method's functions to export. Every anonymous sign-in makes a new
     * user, so `createUser` runs each time; an `onSignIn` still runs right after, for an app's every-sign-in work.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<typeof METHOD_NAME, Record<string, never>, UsersTable>) {
      const { authMutation } = core.bindMethod({ name: METHOD_NAME, createUser, onSignIn });
      return {
        // It cannot fail for a user, yet returns the shared result shape: a server-rendering host's proxy recognizes it
        // (and checks it before moving the refresh token into its cookie), and a refused arm can come later.
        signInAnonymously: authMutation({
          args: {},
          returns: vSignInComplete,
          handler: async (ctx): Promise<SignInComplete> => {
            // Every anonymous sign-in is a new identity: there is nothing to look up.
            const tokens = await ctx.bunvexAuth.completeSignUp({ profile: {}, authenticatedBy: component });
            await ctx.runMutation(component.provider.createAnonymousAccount, { userId: tokens.userId });
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}

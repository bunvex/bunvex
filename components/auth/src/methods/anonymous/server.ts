// The anonymous method's server side (STUDY-201 §1.9), v2's `setupAnonymous`: every call creates an account and a user,
// with no way back to one.
import type { ComponentApi } from "../../components/anonymous/_generated/component.ts";
import { type SignInComplete, type UserCallbacks, vSignInComplete } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";

// The method's name, keying its accounts in the core (v2's, as is).
const PROVIDER_NAME = "anonymous";

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
     * account, so `createUser` runs each time; an `onSignIn` still runs right after, for an app's every-sign-in work.
     */
    attachUserCallbacks({ createUser, onSignIn }: UserCallbacks<"anonymous", Record<string, never>, UsersTable>) {
      const { authMutation } = core.bindProvider({ name: PROVIDER_NAME, createUser, onSignIn });
      return {
        // It cannot fail for a user, yet returns the shared result shape: a server-rendering host's proxy recognizes it
        // (and checks it before moving the refresh token into its cookie), and a refused arm can come later.
        signInAnonymously: authMutation({
          args: {},
          returns: vSignInComplete,
          handler: async (ctx): Promise<SignInComplete> => {
            const anonymousId = await ctx.runMutation(component.provider.createAnonymousAccount, {});
            const tokens = await ctx.bunvexAuth.completeSignUp({ providerAccountId: anonymousId, profile: {} });
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}

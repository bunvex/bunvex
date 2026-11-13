// The username + password method's server side (STUDY-201 §1.9, STUDY-208 §1.11), v2.0.0's `setupUsernamePassword`:
// sign up, sign in and change the password, over the password and username components. The username component maps a
// username to the user's id, and the password component keeps the user's password by that id; the sessions record the
// password component as the one that authenticated the user.
import { type Infer, v } from "@bunvex/values";
import type { ComponentApi } from "../../components/password/_generated/component.ts";
import {
  setPasswordUserError,
  validateNewPassword,
  verifyPasswordUserError,
} from "../../components/password/validation.ts";
import type { ComponentApi as UsernameComponentApi } from "../../components/username/_generated/component.ts";
import { setUsernameUserError, validateUsernameFormat } from "../../components/username/validation.ts";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../../lib/password.ts";
import { type UserCallbacks, vSignInComplete, vSignInError } from "../../lib/types.ts";
import type { AuthCore } from "../../server/setup.ts";
import { getAuthUserId } from "../../server/userId.ts";

// The method's name: the app's callbacks get it as `method.name` (v2's, as is).
const METHOD_NAME = "usernamePassword";

/** What {@link setupUsernamePassword} needs: the two mounted components. */
export type UsernamePasswordOptions = {
  /** The mounted password component (`components.authPassword`): it sets and checks the passwords. */
  component: ComponentApi;
  /** The mounted username component (`components.authUsername`): it maps a username to the user's id. */
  usernameComponent: UsernameComponentApi;
};

const signInResult = v.union(
  vSignInComplete,
  vSignInError(v.union(verifyPasswordUserError, v.object({ error: v.literal("USER_NOT_FOUND") }))),
);
/** What `signInWithUsernamePassword` returns: the session's tokens, or an error to show the user. */
export type SignInResult = Infer<typeof signInResult>;

const signUpResult = v.union(vSignInComplete, vSignInError(v.union(setPasswordUserError, setUsernameUserError)));
/** What `signUpWithUsernamePassword` returns: the session's tokens, or an error to show the user. */
export type SignUpResult = Infer<typeof signUpResult>;

const changePasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      v.object({ error: v.literal("NOT_LOGGED_IN") }),
      v.object({ error: v.literal("INVALID_CREDENTIALS") }),
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
      setPasswordUserError,
    ),
  }),
);
/**
 * What `changePassword` returns. `INVALID_CREDENTIALS` and `RATE_LIMITED` are about the current password, the others
 * about the new one.
 */
export type ChangePasswordResult = Infer<typeof changePasswordResult>;

/**
 * Sign-in with a username and a password, and nothing else (no email, no verification). In `bunvex/auth.ts`:
 *
 * ```ts
 * const auth = setupAuth({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = auth;
 *
 * export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } = setupUsernamePassword(
 *   auth,
 *   { component: components.authPassword, usernameComponent: components.authUsername },
 * ).attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * ```
 *
 * The username component finds a username's user (stored at sign-up, read at sign-in); the password component knows
 * only user ids and their hashes.
 */
export function setupUsernamePassword<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: UsernamePasswordOptions,
) {
  const { component, usernameComponent } = options;
  return {
    /** Give the app's user callbacks and get the method's functions to export. */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<typeof METHOD_NAME, Record<string, never>, UsersTable>) {
      const { authMutation } = core.bindMethod({ name: METHOD_NAME, createUser, onSignIn });
      return {
        /**
         * Create an account: a taken username or a refused password is an error; otherwise the user and a session are
         * created, and the username and password stored.
         */
        signUpWithUsernamePassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signUpResult,
          handler: async (ctx, { username, password }): Promise<SignUpResult> => {
            // Checked before anything is created, so bad input never starts a session (the components check again, but
            // by then the account would exist).
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) return { status: "error", userError: usernameError };
            const userError = validateNewPassword(password, DEFAULT_MIN_PASSWORD_LENGTH);
            if (userError !== null) return { status: "error", userError };
            if ((await ctx.runQuery(usernameComponent.public.getUserIdByUsername, { username })) !== null)
              return { status: "error", userError: { error: "USERNAME_TAKEN" } };

            // The user `createUser` makes in this call; the username and the password are stored under its id.
            const tokens = await ctx.bunvexAuth.completeSignUp({ profile: {}, authenticatedBy: component });
            const named = await ctx.runMutation(usernameComponent.public.setUsername, {
              userId: tokens.userId,
              username,
            });
            // Checked above in this same transaction, so a refusal here is a bug: throw, so nothing commits.
            if (!named.success)
              throw new Error(`Unexpected error when setting the username: ${named.userError.error}`, {
                cause: named.userError,
              });
            const set = await ctx.runMutation(component.public._internal_dangerous_setPassword, {
              userId: tokens.userId,
              password,
              minimumLength: DEFAULT_MIN_PASSWORD_LENGTH,
            });
            // As v2's: the message names the earlier check's result, which is null here.
            if (!set.success)
              throw new Error(`Unexpected error when setting the password: ${userError}`, { cause: userError });
            return { status: "complete", tokens };
          },
        }),

        /**
         * Check an account's password and start a session. An unknown username is `USER_NOT_FOUND` and a wrong
         * password `INVALID_CREDENTIALS`, told apart on purpose: sign-up's `USERNAME_TAKEN` already shows whether a
         * username exists.
         */
        signInWithUsernamePassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signInResult,
          handler: async (ctx, { username, password }): Promise<SignInResult> => {
            const userId = await ctx.runQuery(usernameComponent.public.getUserIdByUsername, { username });
            if (userId === null) return { status: "error", userError: { error: "USER_NOT_FOUND" } };
            const checked = await ctx.runMutation(component.public.verifyPassword, { userId, password });
            if (!checked.success) return { status: "error", userError: checked.userError };
            // The username found the user and the password matched.
            const tokens = await ctx.bunvexAuth.completeSignIn({ userId, profile: {}, authenticatedBy: component });
            return { status: "complete", tokens };
          },
        }),

        /**
         * Change the signed-in user's password, given their current one; with `signOutOtherSessions`, their other
         * sessions are signed out.
         */
        changePassword: authMutation({
          args: { currentPassword: v.string(), newPassword: v.string(), signOutOtherSessions: v.optional(v.boolean()) },
          returns: changePasswordResult,
          handler: async (
            ctx,
            { currentPassword, newPassword, signOutOtherSessions = false },
          ): Promise<ChangePasswordResult> => {
            const userId = await getAuthUserId(ctx, core.component);
            if (userId === null) return { success: false, userError: { error: "NOT_LOGGED_IN" } };
            // The new password first, so a refused one costs no rate-limit attempt.
            const newPasswordError = validateNewPassword(newPassword, DEFAULT_MIN_PASSWORD_LENGTH);
            if (newPasswordError !== null) return { success: false, userError: newPasswordError };
            const checked = await ctx.runMutation(component.public.verifyPassword, {
              userId,
              password: currentPassword,
            });
            if (!checked.success) {
              if (checked.userError.error === "RATE_LIMITED") return { success: false, userError: checked.userError };
              // The current password's format errors read as wrong credentials, so the user does not blame the new one.
              return { success: false, userError: { error: "INVALID_CREDENTIALS" } };
            }
            const set = await ctx.runMutation(component.public._internal_dangerous_setPassword, {
              userId,
              password: newPassword,
              minimumLength: DEFAULT_MIN_PASSWORD_LENGTH,
            });
            if (!set.success)
              throw new Error(`Unexpected error when setting the password: ${set.userError.error}`, {
                cause: set.userError,
              });
            // The current password was just checked, so the caller holds this session.
            if (signOutOtherSessions) await ctx.bunvexAuth.revokeOtherSessions();
            return { success: true };
          },
        }),
      };
    },
  };
}

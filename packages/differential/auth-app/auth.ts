// The app's auth, as v2's examples wire it: the session functions, the username + password and anonymous methods, and
// what the test reads (the caller's user, and the app's own rows).

import { setupAnonymous } from "@convex-dev/auth/methods/anonymous/server";
import { setupUsernamePassword } from "@convex-dev/auth/methods/username-password/server";
import { getAuthUserId, setupConvexAuth } from "@convex-dev/auth/server";
import { queryGeneric } from "convex/server";
import { components, internal } from "./_generated/api";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser, onSignIn: internal.users.onSignIn });

export const { signInAnonymously } = setupAnonymous(auth, { component: components.authAnonymous }).attachUserCallbacks({
  createUser: internal.users.createUser,
});

/** The caller's user, through their session. */
export const me = queryGeneric({ args: {}, handler: async (ctx) => await getAuthUserId(ctx) });

/** The app's own rows. */
export const appRows = queryGeneric({
  args: {},
  handler: async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    signIns: await ctx.db.query("signIns").collect(),
  }),
});

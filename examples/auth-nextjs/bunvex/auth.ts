// The app's auth: the session functions, and two sign-in methods, username + password and anonymous. Under server
// rendering the sign-in functions are reached through the app's sign-in route (`lib/serverAuth.ts` lists them).
import { setupAnonymous } from "@bunvex/auth/methods/anonymous/server";
import { setupUsernamePassword } from "@bunvex/auth/methods/username-password/server";
import { setupAuth } from "@bunvex/auth/server";
import { components, internal } from "./_generated/api";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });

export const { signInAnonymously } = setupAnonymous(auth, { component: components.authAnonymous }).attachUserCallbacks({
  createUser: internal.users.createUser,
});

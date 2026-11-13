// The app's auth: the session functions, and the username + password sign-in method. Under server
// rendering the sign-in functions are reached through the app's sign-in route (`lib/serverAuth.ts` lists them).
import { setupUsernamePassword } from "@bunvex/auth/methods/username-password/server";
import { setupAuth } from "@bunvex/auth/server";
import { components, internal } from "./_generated/api";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });

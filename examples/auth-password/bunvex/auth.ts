// The app's auth: the session functions the client needs, and the username + password method's.
import { setupUsernamePassword } from "@bunvex/auth/methods/username-password/server";
import { setupAuth } from "@bunvex/auth/server";
import { components, internal } from "./_generated/api";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signUpWithUsernamePassword, signInWithUsernamePassword, changePassword } = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.createUser });

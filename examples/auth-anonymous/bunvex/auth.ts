// The app's auth: the session functions the client needs, and anonymous sign-in.
import { setupAnonymous } from "@bunvex/auth/methods/anonymous/server";
import { setupAuth } from "@bunvex/auth/server";
import { components, internal } from "./_generated/api";

const auth = setupAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

export const { signInAnonymously } = setupAnonymous(auth, { component: components.authAnonymous }).attachUserCallbacks({
  createUser: internal.users.createUser,
});

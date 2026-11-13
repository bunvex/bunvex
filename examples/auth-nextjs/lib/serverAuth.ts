// The session's routes, configured once: `app/auth/*/route.ts` mount what this returns. The `secure` cookie flag is
// decided here (HTTPS only in production) and reaches every route, sign-in included.
import { setupBunvexAuthServer } from "@bunvex/auth/ssr";
import { api } from "../bunvex/_generated/api";

export const auth = setupBunvexAuthServer({
  bunvexUrl: process.env.NEXT_PUBLIC_BUNVEX_URL!,
  refreshSession: api.auth.refreshSession,
  signOut: api.auth.signOut,
  // Every function that signs a user in (creates a session and returns its tokens). The sign-in route refuses any other.
  signIn: [api.auth.signInWithUsernamePassword, api.auth.signUpWithUsernamePassword],
  cookieOptions: { secure: process.env.NODE_ENV === "production" },
});

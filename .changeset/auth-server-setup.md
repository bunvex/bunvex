---
"@bunvex/auth": minor
---

`@bunvex/auth/server` has `setupAuth`, which builds the session functions an app exports (`refreshSession`, `signOut`, `isAuthenticated`) and binds the sign-in methods; `getAuthUserId(ctx)`, the caller's user through their session; and `bunvexAuthProvider()` for `auth.config.ts`. The username + password method's server side: `setupUsernamePassword` (`signUpWithUsernamePassword`, `signInWithUsernamePassword`, `changePassword`) from `@bunvex/auth/methods/username-password/server`. `@bunvex/auth` exports the types the backend and the clients share.

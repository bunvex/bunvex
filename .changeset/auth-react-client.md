---
"@bunvex/auth": minor
---

`@bunvex/auth/react` has `BunvexAuthProvider` (in place of `BunvexProvider`: it keeps the session, refreshes the access token over HTTP and signs out, and authenticates your `BunvexReactClient`; its `api` takes `refreshSession`, `signOut` and `isAuthenticated`, which it subscribes to, so a session revoked on the server signs the client out at once), `useAuthActions` (`setSession`, `signOut`) and `useAuthToken`. The method's hooks: `useSignInWithUsernamePassword` and `useSignUpWithUsernamePassword` from `@bunvex/auth/methods/username-password/react` (a thrown call comes back as `OTHER_ERROR`, with `pending` while it runs).

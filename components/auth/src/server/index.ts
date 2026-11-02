// `@bunvex/auth/server` (STUDY-201 §1.1), v2's `./server`: `setupAuth` builds the session functions the app exports,
// `bunvexAuthProvider` the provider `auth.config.ts` lists, and `getAuthUserId` reads the caller's user.
export { bunvexAuthProvider } from "./authProvider.ts";
export { type AuthCore, setupAuth } from "./setup.ts";
export { getAuthUserId } from "./userId.ts";

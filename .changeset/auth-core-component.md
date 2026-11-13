---
"@bunvex/auth": minor
---

`@bunvex/auth` is now bunvex's built-in auth, starting with its core component, `auth`, which the app mounts as `auth`: sessions whose refresh tokens rotate on every refresh (a leaked token presented again revokes its session), each ending at an inactivity timeout or a max lifetime (30 days by default), at most 100 per user, and access tokens signed by the deployment (`ctx.auth.signJwt`, audience `bunvex-auth`), whose subject is the session. `@bunvex/auth/test` mounts it in a `@bunvex/testing` deployment (`registerCore`) and calls as a session (`sessionIdentity`). The sign-in methods, `setupAuth`, `getAuthUserId` and the clients come next.

Up to 0.1.0-alpha.2, `@bunvex/auth` was the access-token verifier inside `@bunvex/server`; that package is now `@bunvex/identity`.

---
"@bunvex/auth": minor
---

`@bunvex/auth/ssr`: the session under server rendering. The refresh token in an httpOnly cookie, never in the page; the refresh, sign-out and allowlisted sign-in routes as WHATWG handlers (`setupBunvexAuthServer`), each refusing another site's requests; `ServerAuthSession` and `createServerAuthChecker` for the server's own reads. The `RefreshResult` type (also from `@bunvex/auth`) gives a refresh's outcomes.

---
"@bunvex/auth": minor
---

`@bunvex/auth/browser` has the client's session manager without React: `AuthClient` (it keeps the tokens a sign-in returned, hands out the access token, refreshes it under a lock shared across tabs, follows other tabs, and reports its state to any UI framework, for single-page apps and for server-rendered ones whose refresh token is in a cookie), `defaultStorage`, `InMemoryStorage`, the `TokenStorage` interface (sync or async, e.g. React Native's secure stores) and `runWithMutex`. Tokens are stored under `__bunvexAuthJWT_<namespace>` and `__bunvexAuthRefreshToken_<namespace>`. The OAuth client the React provider will register comes with it, inert until a callback URL carries `bunvexAuthCode` or `bunvexAuthError`.

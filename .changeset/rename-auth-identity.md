---
"@bunvex/identity": minor
"@bunvex/server": patch
---

The token verifier (JWT / OIDC verification, the auth config and `UserIdentity`) is now `@bunvex/identity`, formerly `@bunvex/auth`. The name `@bunvex/auth` goes to the built-in auth components. Nothing else changes: `@bunvex/server` re-exports the same types.

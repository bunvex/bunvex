---
"@bunvex/testing": minor
---

`t.jwks()` returns the public keys that verify the tokens `ctx.auth.signJwt` signs, as the deployment serves them at `/.well-known/jwks.json`. Each test deployment now has an instance secret of its own, so it signs with its own key and its JWKS verifies only its tokens.

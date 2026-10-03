---
"@bunvex/server": patch
---

Changing an environment variable re-evaluates `auth.config` with the canonical URLs applied, as a push, a restart and a canonical-URL change already did. Before, an auth provider whose `domain` is `process.env.BUNVEX_SITE_URL` fell back to the raw site origin after any variable changed, and tokens from the canonical issuer were refused until the next push or restart.

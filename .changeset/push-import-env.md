---
"@bunvex/server": patch
---

A pushed module reads the deployment's variables at import (`const key = process.env.KEY` at the top of a file) from the push that installs it, as Convex's analysis gives modules its environment variables. Before, the version a push installed had read none at import (they appeared only after a restart).

---
"@bunvex/cli": patch
---

Codegen writes a component package's `_generated/` (a definition in TypeScript, linked from a workspace) with the
imports its own `package.json` depends on (`@bunvex/*`), not the app's: an app on the `bunvex` aggregate no longer
rewrites a component package's committed files (STUDY-183).

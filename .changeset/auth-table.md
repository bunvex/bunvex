---
"@bunvex/core": patch
"@bunvex/server": minor
---

The deployed auth providers are stored in `_auth`, as Convex's (STUDY-129): one document per provider, put in a push's commit and when a variable or canonical URL change re-evaluates `auth.config`. A start checks tokens against them instead of evaluating `auth.config` again. `finish_push` answers the put's `authDiff` (it was always empty), the audit event carries the same diff, and `_system/frontend/listAuthProviders` lists the documents.

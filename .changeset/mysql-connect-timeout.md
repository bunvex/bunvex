---
"@bunvex/persistence": patch
---

On MySQL, a connect that does not finish within the call's timeout fails with `DatabaseTimeoutError`, as Convex's, so the committer retries the flush. mysql2's own `connect ETIMEDOUT` no longer stops the committer.

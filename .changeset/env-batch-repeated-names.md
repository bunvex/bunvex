---
"@bunvex/core": patch
"@bunvex/server": patch
---

`/api/update_environment_variables` accepts a batch that names a variable more than once, as Convex: removals are applied first, then sets by name and value. Removing a variable and setting it again in one batch (a dashboard rename onto a deleted name, or swapping two names) used to fail with `EnvVarNameNotUnique`. The audit log records the batch in the order it is applied.

---
"@bunvex/core": patch
---

`.staged()` takes field deltas, as Convex's: over a table defined as an object or `v.any()`, an object of fields replaces or adds to the enforced ones, and a field set to `undefined` is removed from the staged validator. A whole validator is still taken as is, and a table defined with a union or record refuses a delta.

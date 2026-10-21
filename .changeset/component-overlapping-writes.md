---
"@bunvex/core": patch
---

A component's function whose first writes overlap (`Promise.all` of deletes or inserts, as `@convex-dev/sharded-counter`'s
`reset` does) no longer fails with "Delete on nonexistent document ID": the check that the component is mounted read
the root's `_components` with the root's namespace and system access held across its await, so the writes overlapping
it ran in the root's tables (STUDY-183).

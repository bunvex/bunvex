---
"@bunvex/core": patch
---

`db.patch`, `db.replace` and `db.delete` with an id whose table number the deployment does not have fail with Convex's message, ``Invalid argument `id` for `db.patch`: Table for ID "…" not found``, instead of "Update on nonexistent document ID …".

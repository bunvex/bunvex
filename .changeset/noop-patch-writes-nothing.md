---
"@bunvex/core": patch
---

A `db.patch` or `db.replace` that leaves the document as it was writes nothing, as Convex's: the mutation records no write usage, the queries that read the document are not invalidated, and concurrent readers do not conflict with it.

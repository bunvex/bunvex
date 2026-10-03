---
"@bunvex/core": patch
"@bunvex/persistence": patch
---

A read over an index entry whose document is missing or deleted at the snapshot (a corrupt store) now fails with `DanglingReferenceError`, as Convex does ("Dangling index reference", "Index reference to deleted document"), instead of skipping the entry, which returned fewer documents and could end a query's range early. Applies to the engine and to the Postgres, MySQL and MongoDB `scanDocs` (PERSIST-01 C15).

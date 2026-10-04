---
"@bunvex/core": patch
---

Database index definitions are checked as Convex checks them at push, with its messages, naming the table: `_id`, `_creationTime` or another `_` field in an index, a repeated field, too many fields, an empty index, a reserved or repeated index name. Two behaviours follow Convex's: an index with 16 fields is refused (`_creationTime` makes it 17), and two database indexes on the same fields are refused.

---
"@bunvex/core": patch
---

A query over a mutation's own writes returns copies, as `db.get` does: mutating a result no longer changes what the mutation wrote.

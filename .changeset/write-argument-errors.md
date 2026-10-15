---
"@bunvex/values": patch
"@bunvex/core": patch
"@bunvex/server": patch
---

`db.insert`, `db.patch`, `db.replace` and `db.count` word their argument errors as Convex's backend (STUDY-161 §1, §2): a table name that is not an identifier gives the identifier's own message under ``Invalid argument `table` for `db.insert`: ``; a value that is not an object is "Value must be an Object" under the value's prefix; a missing value is `Must provide arg 2 …`. A deployed function's value nested past the limit keeps the argument prefix, and a `db.vars.commitTs` inside one of its objects resolves.

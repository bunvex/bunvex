---
"@bunvex/core": patch
---

A table definition carries Convex's index lists at run time (`indexes`, `stagedDbIndexes`, `searchIndexes`, `stagedSearchIndexes`, `vectorIndexes`, `stagedVectorIndexes`), filled in declaration order as Convex's, so libraries that read `schema.tables[t].indexes` work (STUDY-181 H-5).

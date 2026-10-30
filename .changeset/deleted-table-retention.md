---
"@bunvex/core": patch
"@bunvex/persistence": patch
"@bunvex/persistence-conformance": patch
---

A deleted table is kept as Convex keeps it. Its `_index` rows go with the deletion, and its `_tables` row stays `deleting`, with its number and its documents, until document retention passes the deletion (14 days by default). A new table therefore never takes its number, and an old id never becomes another table's. Once the window has passed, retention purges the table's rows with a new persistence operation, `purgeTablet` (PERSIST-01 C18, conformance K37 on every driver), then removes its `_tables` row while the server runs.

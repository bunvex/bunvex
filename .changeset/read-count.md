---
"@bunvex/core": patch
"@bunvex/server": patch
---

Reads count toward the 4 096-read limit as Convex's backend counts them (STUDY-161 §16): per index, the merged intervals a function read (a document read again or patched after a get, adjacent or overlapping ranges add nothing), not the engine's own reads (table and index metadata, a new document's id, a search's terms), plus Convex's reads at a function's start, a table's creation and a first nested call. What subscriptions and OCC record is unchanged.

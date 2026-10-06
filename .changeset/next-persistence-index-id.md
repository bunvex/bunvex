---
"@bunvex/core": patch
---

Index ids come from one counter, as Convex's `_next_persistence_index_id` (STUDY-128): every transaction that creates indexes (a push, a start, a write to a new table, an import's hidden table) takes its ids from it and writes it back in the same commit, and a dropped index never gives its id back. Before, a new index took the highest stored id + 1, so dropping the newest index let the next one reuse its id.

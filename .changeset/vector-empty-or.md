---
"@bunvex/core": patch
---

A vector search whose filter is an empty `q.or()` (an `or` over an empty list) returns what a search with no filter returns, as Convex's. Before, it returned nothing.

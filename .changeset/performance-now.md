---
"@bunvex/core": patch
---

`performance.now()` inside queries is fixed at the execution's start and inside mutations counts up from it, rounded down to 0.1 ms, as in Convex.

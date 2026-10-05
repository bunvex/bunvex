---
"@bunvex/core": patch
---

The persistence globals' values as Convex writes them (STUDY-134): the retention timestamps as int64 nanoseconds, and `table_summary_v2` with `JsonInteger` strings and Convex's shape JSON (`numValues`, `variant`, …).

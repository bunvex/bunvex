---
"@bunvex/core": patch
"@bunvex/server": patch
---

Every write bunvex makes on its own now carries a source under `_system/` (35 labels missed by DV-435: crons, log
streams, usage limits, environment variables, the scheduler's system errors, the index and schema workers, pushes,
snapshot imports), so an OCC conflict they cause reads "A system operation" (or "A data import" for an import's
index step), as Convex's, instead of `A call to "<internal label>"`.

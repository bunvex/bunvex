---
"@bunvex/server": minor
"@bunvex/core": patch
---

A Prometheus `/metrics` endpoint on the API and site ports, as Convex's: no auth, on by default, 404 `MetricsDisabled` with `DISABLE_METRICS_ENDPOINT=true`. It serves bunvex's own `bunvex_*` series (functions by kind, the committer, sync with the argument-size histograms, the scheduler, search indexes, the process) with standard `le` histograms (DV-377, DV-378).

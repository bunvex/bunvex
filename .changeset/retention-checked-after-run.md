---
"@bunvex/core": patch
---

A function's query or mutation checks its snapshot against the retention window again once it ran, as Convex's `validate_run_function_result`: a run the window passed while it ran fails with `OutOfRetentionError` instead of answering, and a mutation's writes are dropped.

---
"@bunvex/server": patch
---

`/api/run_test_function` reads the deployment's import seed and time without writing them: before any push it uses a fresh seed, as Convex's uncommitted transaction does, and commits nothing (STUDY-119 §7).

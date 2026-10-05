---
"@bunvex/core": patch
"@bunvex/server": patch
---

A `Runtime` for the engine's clock and timers (`runtime` option of `Engine`, `realRuntime` by default), and a `TestRuntime` with virtual time (`@bunvex/core/test-runtime`) for tests. The user-time budget of functions and the concurrency limiters' wait timeout read it. Nothing changes in production.

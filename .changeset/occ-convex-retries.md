---
"@bunvex/core": minor
"@bunvex/server": patch
"@bunvex/persistence-conformance": patch
---

Convex's OCC retry budget and error: 4 retries with full-jitter backoff from 100 ms to 2 s, a wait for the conflicting write before retrying, and `OccError` (`OptimisticConcurrencyControlFailure`) with Convex's message; HTTP mutations that exhaust it answer 503. Also fixes a lost wake-up in the committer.

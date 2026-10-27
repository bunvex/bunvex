---
"@bunvex/core": patch
"@bunvex/server": patch
---

A subscription's query looks in the query cache the HTTP API uses, as Convex's sync worker does. A Next.js page's `preloadQuery` and its client's subscription run the query once, and a page reload with no commit in between is a cache hit ("(cached)" in Logs), not a run.

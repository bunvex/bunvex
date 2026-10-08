---
"@bunvex/server": minor
"@bunvex/core": minor
"@bunvex/values": patch
"@bunvex/auth": patch
"@bunvex/cli": minor
---

Matches Convex at `precompiled-2026-10-07-d8bdde0` (STUDY-137):

- A failed nested call reads `Uncaught Error:` once, however deep.
- Messages: the concurrency limit names the kind in the plural; a `_system/` function refused without an admin reads "You don't have permission to perform this operation."; a skipped cron run names the job; two typos fixed.
- Write throughput can be limited by rows: each commit's document and index rows, `MAX_ROWS_WRITTEN_PER_SECOND` (off by default). Both `TooManyWrites` messages say "per second". `formatWindow` is no longer exported from `@bunvex/core`.
- HTTP action responses go up to 100 MiB. Past that, the rest of the body is dropped with one error line and no size warning.
- Module path errors read `Invalid module path '<p>': <reason>`.
- A function or a symbol in an unsupported-value error prints as `"[Function]"` or its description.
- Creating or updating an S3 export also needs ViewData.
- `bunvex deployment usage-limits` accepts `--metric aiGatewayCostDollars` ("AI Gateway").
- A commit published while `max_repeatable_ts` is being written gets its own bump after the commit delay.

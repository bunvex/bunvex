---
"@bunvex/core": minor
"@bunvex/server": minor
---

The write throughput limit, as Convex's: every commit's bytes count in a 1 s window per deployment (`MAX_BYTES_WRITTEN_PER_SECOND`, 4 MiB; `WRITE_THROUGHPUT_WINDOW`, 1000 ms; Engine option `writeThroughput`). Each attempt of a mutation run by the function runner checks it first and is retried within the OCC budget, then fails with `TooManyWrites` (HTTP 429; the sync protocol closes with 1013 `TooManyWrites`). Scheduled mutations and crons wait instead of failing, and imports wait before each batch (STUDY-78).

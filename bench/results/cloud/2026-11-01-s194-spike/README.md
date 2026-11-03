# STUDY-194 2b spike: queries on worker threads (2026-11-01)

Two DigitalOcean `c-4` droplets in sfo2 (Xeon Platinum 8168, 4 vCPUs on 2 cores): the server and k6. SQLite,
`bench/offthread/cloud-suite.sh` steps `queriesN` (N query workers), 64 VUs, 20 s, 2 repeats each. Each file has
`uncached`, `cached` and `insert`, two lines each.

The spike is branch `spike/query-workers` (not product code):

- `run1-d8b6a44e`: workers with their own reader engine and index cache, checked against the commits the main thread
  posts them; the main thread parses each result.
- `run2-c0982e0a`: the same, with the result parsed only when asked for (the HTTP API answers with its text).

STUDY-194 §10.5.2 reads them.

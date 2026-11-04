# STUDY-194 PR 3: mutations on execution workers, measured (2026-11-04)

Two DigitalOcean `c-4` droplets in sfo2 (4 vCPUs on 2 cores): the server box and the load box (k6).
`bench/cloud/cloud.ts run single` with `VUS=64 DURATION=20s REPEATS=2`. The functions are deployed as a push's code
(`BENCH_DEPLOY=1`) with 2 workers (`MAX_ISOLATE_WORKERS=2`). `main` (`a86df6a2`, where queries already run on workers)
and the PR (`2b5c23c7`) were alternated on the same droplets.

| dir | Postgres |
|---|---|
| `1-sqlite/` | none: SQLite on the server box |
| `2-postgres-remote/` | Postgres 17 on the load box, over the private network (`PG_HOST=10.120.0.2`), pool 128 |

Medians, req/s (p99 ms), the first and the second run of each:

| store | scenario | `main` | PR 3 | |
|---|---|--:|--:|--:|
| SQLite | `insert` | 3299 · 3205 (41–42) | 3761 · 3728 (41–43) | **+15 %** |
| SQLite | `increment1000` | 1789 · 1727 (105–122) | 2655 · 2639 (102–103) | **+51 %** |
| SQLite | `increment1` | 381 · 374, 14 % errors | 345 · 345, 13 % errors | −9 % |
| SQLite | `mix` | 3691 · 3720 | 3694 · 3670 | = |
| SQLite | `uncached` | 3205 · 3213 | 3169 · 3233 | = |
| Postgres, another box | `insert` | 2292 · 2293 (47–76) | 2784 · 2832 (41–42) | **+22 %** |
| Postgres, another box | `increment1000` | 1389 · 1372 (178–251) | 1789 · 1825 (156–159) | **+31 %** |
| Postgres, another box | `increment1` | 136 · 136, 31 % errors | 129 · 132, 32 % errors | −4 % |
| Postgres, another box | `mix` | 3453 · 3424 | 3583 · 3455 | +2 % |

- **Mutations gain where the main thread was the limit.** On SQLite the server used 1.1 cores for `insert` and
  `increment1000` on `main`, and 2.0–2.45 with the PR.
- **Reads are unchanged.** `mix` (9 reads in 10) and `uncached` already ran their queries on the workers.
- **One hot key (`increment1`, every VU on one counter) is 4–9 % slower.** Every attempt conflicts with the one before.
  A worker's run adds a round trip between its snapshot and its commit, so fewer attempts commit per second. The
  errors are the 503s of attempts that ran out of retries, in the same proportion as `main`.
- The runs were steady: one configuration's two medians are within 5 % of each other. A spike earlier the same day, on
  other droplets, saw inserts spread from 605 to 2238 req/s (STUDY-194 §11.1).

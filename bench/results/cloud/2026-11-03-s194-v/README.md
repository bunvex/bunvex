# STUDY-194 step v: queries on execution workers over Postgres, measured (2026-11-03)

Two DigitalOcean `c-4` droplets in sfo2 (4 vCPUs on 2 cores): the server box and the load box (k6). Postgres 17,
`bench/cloud/cloud.ts run single` with `PERSISTENCES=postgres VUS=64 DURATION=20s REPEATS=3`, the functions deployed as
a push's code (`BENCH_DEPLOY=1`), 0 and 2 workers alternated (`MAX_ISOLATE_WORKERS`). The pool is the default
(`POSTGRES_MAX_CONNECTIONS` 128): with 2 workers the main thread keeps 32 and each worker opens up to 48 (Q8).

| dir | code | Postgres |
|---|---|---|
| `1-colocated/` | `121fa495` | on the server box, as the suite runs it (`bench-pg`, 127.0.0.1) |
| `2-remote/` | `cec8c553` (1), `7bf69e23` (2–4: the same code, main merged in) | on the load box, over the private network (`PG_HOST=10.120.0.2`) |
| `3-remote-insert/` | `7bf69e23` | as 2, `insert` only, the pool total also at 512 (the main thread keeps 128 with 2 workers, as with none) |

Medians, req/s (p99 ms):

| Postgres | workers | uncached | cached | insert |
|---|---|--:|--:|--:|
| on the server box | 0 | 1554 · 1528 (80–84) | 7935 · 7769 | 2484 · 2487 (47–49) |
| on the server box | 2 | 1780 · 1773 (83–85) | 7784 · 7961 | 2424 · 2351 (52–54) |
| on another box | 0 | 1614 · 1578 (77–84) | 7675 · 7990 | 1688 · 1962 (56–71) |
| on another box | 2 | 2252 · 2242 (67–68) | 7691 · 7578 | 1606 · 1584 (75–104) |

`3-remote-insert/`, insert medians: 0 workers 1778 · 1427; 2 workers, pool 128: 1536 · 1786; 2 workers, pool 512:
1624 · 1674.

- **Uncached, Postgres on another box: +41 %** (1596 → 2247), p99 −15 %. The server uses 2.4 cores instead of 1.
- **Postgres on the server box: +15 %.** The box is the limit: bunvex and Postgres together use 2.84 of its 4 vCPUs
  (2 physical cores).
- **Cached: the same** (a cache hit never reaches a worker).
- **Insert: no difference above the noise.** With Postgres across the network an insert waits on its commit's round
  trips, and the medians of one configuration spread from 1427 to 1962. Over the four runs of each at the default pool, 0
  workers averaged 1714 and 2 workers 1628 (−5 %), inside that spread. The connection split is not the cause: with the main thread
  keeping its 128 connections (pool 512), 2 workers did the same. On the server box (less noise), −3 %; SQLite's
  2b runs showed −2 % to −3 % (the commits posted to the workers, 0d).

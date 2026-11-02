# STUDY-194 2b step vi: queries on execution workers, measured (2026-11-02)

Two DigitalOcean `c-4` droplets in sfo2 (4 vCPUs on 2 cores): the server and k6. SQLite, `bench/cloud/cloud.ts run
single` with `PERSISTENCES=sqlite SCENARIOS=uncached,cached,insert VUS=64 DURATION=20s REPEATS=3`. The same droplets
for every run, in this order:

| dir | code | server |
|---|---|---|
| `1-branch-register` | `perf/exec-query-workers` `9db90f54` | the bench's functions registered in the process (`register`), as `main`'s bench |
| `2-branch-deploy-w0` | `9db90f54` | `BENCH_DEPLOY=1 MAX_ISOLATE_WORKERS=0`: the functions as a push's code, every call in-thread |
| `3-branch-deploy-w2` | `9db90f54` | `BENCH_DEPLOY=1 MAX_ISOLATE_WORKERS=2`: a push's code, queries on up to 2 workers |
| `4-main-register` | `main` `c823eace` | `register`: the baseline |
| `5-branch-deploy-w2-again` | `9db90f54` | as 3 |
| `6-branch-deploy-w0-again` | `9db90f54` | as 2 |

Medians, req/s (p99 ms):

| | uncached | cached | insert |
|---|--:|--:|--:|
| main, register | 1941 (64) | 7894 (17) | 2682 (50) |
| branch, register | 1771 (68) | 8089 (17) | 2581 (52) |
| branch, push, 0 workers | 1562 · 1553 (78) | 8097 · 7173 (17–18) | 2186 · 2171 (57–62) |
| branch, push, 2 workers | 3128 · 3074 (47–51) | 7122 · 6905 (19) | 2160 · 2204 (60–69) |

STUDY-194 §10.5.8 reads them.

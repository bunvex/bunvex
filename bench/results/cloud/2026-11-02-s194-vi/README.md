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

## Round 2 (`round2/`, after `wants` at `a2b0b410`) and round 3 (`round3/`, after the report change at `8a26b776`)

`main` pushed is `main` `804443bc` with `BENCH_DEPLOY` added in a local commit (`8243ffe7`, not pushed). Round 3, on new
droplets, each side twice, medians req/s:

| | uncached | cached | insert |
|---|--:|--:|--:|
| main, registered | 1938 · 1953 | 7364 · 8163 | 2258 · 2309 |
| branch, registered | 1929 · 2017 | 8420 · 8042 | 2273 · 2191 |
| main, pushed | 1741 · 1764 | 7901 · 8009 | 2113 · 2071 |
| branch, pushed, 0 workers | 1716 · 1720 | 7946 · 7959 | 2078 · 2038 |
| branch, pushed, 2 workers | 3201 | 6805 | 2057 |

Round 2 (`a2b0b410`): main registered 1925 / 7153 / 2648, branch registered 1831 · 1900 / 7102 · 7294 / 2435 · 2508,
main pushed 1752 / 7186 / 2317, branch pushed 0 workers 1664 / 7118 / 2155, 2 workers 3107 · 3178 / 6997 · 7089 /
2158 · 2101.

## Round 4 (`round4-cached/`): cached only, 5 repeats, 0 and 2 workers alternated

0 workers 9417 · 9851 (the first 0-worker run did not start: the seed raced the push, fixed in `serve.ts`); 2 workers
10209 · 9865 · 9164. The same.

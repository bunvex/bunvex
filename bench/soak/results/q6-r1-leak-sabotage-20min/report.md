# Soak report

20 min, warm-up 4.0 min, 20 clients, 80 samples, bun 1.4.2, linux; 0 hot-counter mutations lost every OCC retry (expected).

| Rule | Result | Detail |
|---|---|---|
| R1 RSS does not trend up | **FAIL** | slope 9.4 MB/min (limit 0.5 MB), last-vs-first third 82.8 MB (limit 10.0 MB); median 691.5 MB; judged from t=406 s |
| R2 heap does not trend up | **FAIL** | slope 8.3 MB/min (limit 0.3 MB), last-vs-first third 80.9 MB (limit 8.0 MB); median 252.6 MB; judged from t=406 s |
| R3 the cache canary stays cached between writes | pass | 3 misses in 9604 calls past the warm-up; 3 writes into its reads |
| R4 the cache hit rate does not fall | pass | hit rate median 56.6 %, projected change -0.9 points, first-to-last third -0.7 points |
| R5 sessions, subscriptions and room members match the open clients | pass | within the reconnect allowance at every sample |
| R6 everything is freed after the clients close | pass | sessions 0, subscriptions 0, room members 0 |
| R7a file descriptors do not trend up | pass | slope 0.0/min (limit 0.2), last-vs-first third 2.0 (limit 4.0); median 46.0 |
| R7b file descriptors return to the baseline | pass | baseline 42, after the drain 28 |
| R8 http query latency does not trend up | **FAIL** | p50 3.2 → 3.2 ms, p99 47.0 → 79.8 ms (first → last third) |
| R8 http query (canary) latency does not trend up | **FAIL** | p50 1.9 → 1.6 ms, p99 52.0 → 78.2 ms (first → last third) |
| R8 schedule latency does not trend up | pass | p50 9.6 → 9.2 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 search latency does not trend up | pass | p50 6.2 → 6.6 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 sync mutation latency does not trend up | pass | p50 24.5 → 32.5 ms, p99 106.3 → 92.4 ms (first → last third) |
| R8 sync mutation (hot counter) latency does not trend up | **FAIL** | p50 60.1 → 83.4 ms, p99 304.1 → 311.1 ms (first → last third) |
| R9a every scheduled job ran exactly once | pass | 2395 scheduled, 2395 recorded, 2395 ran, 0 ran more than once |
| R9b scheduler lag stays under 2 s and does not trend up | pass | worst per-minute p99 118 ms, projected growth -3 ms |
| R10 event loop lag over 200 ms in at most 5 % of samples | pass | 0 of 65 samples over 200 ms; median 0.2 ms, max 139.5 ms |
| R11 an idle backend uses under 3 % of a core | pass | 1.7 % of a core over the idle tail |
| R12 no unexpected errors | pass | 0 unexpected errors |

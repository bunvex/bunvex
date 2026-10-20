# Soak report

45 min, warm-up 9.0 min, 20 clients, 180 samples, bun 1.4.2, linux; 0 hot-counter mutations lost every OCC retry (expected).

| Rule | Result | Detail |
|---|---|---|
| R1 RSS does not trend up | **FAIL** | slope 0.6 MB/min (limit 0.5 MB), last-vs-first third 12.5 MB (limit 10.0 MB); median 608.1 MB; judged from t=541 s |
| R2 heap does not trend up | **FAIL** | slope 0.3 MB/min (limit 0.3 MB), last-vs-first third 8.8 MB (limit 8.0 MB); median 155.4 MB; judged from t=541 s |
| R3 the cache canary stays cached between writes | pass | 7 misses in 21718 calls past the warm-up; 7 writes into its reads |
| R4 the cache hit rate does not fall | pass | hit rate median 57.0 %, projected change -0.1 points, first-to-last third 0.2 points |
| R5 sessions, subscriptions and room members match the open clients | pass | within the reconnect allowance at every sample |
| R6 everything is freed after the clients close | pass | sessions 0, subscriptions 0, room members 0 |
| R7a file descriptors do not trend up | pass | slope 0.0/min (limit 0.2), last-vs-first third -1.0 (limit 4.0); median 46.0 |
| R7b file descriptors return to the baseline | pass | baseline 43, after the drain 28 |
| R8 http query latency does not trend up | pass | p50 3.3 → 3.5 ms, p99 55.1 → 78.4 ms (first → last third) |
| R8 http query (canary) latency does not trend up | **FAIL** | p50 1.8 → 1.9 ms, p99 54.6 → 85.4 ms (first → last third) |
| R8 schedule latency does not trend up | pass | p50 9.8 → 10.3 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 search latency does not trend up | pass | p50 6.8 → 7.4 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 sync mutation latency does not trend up | pass | p50 28.1 → 34.5 ms, p99 78.0 → 107.5 ms (first → last third) |
| R8 sync mutation (hot counter) latency does not trend up | **FAIL** | p50 68.1 → 88.6 ms, p99 288.6 → 356.8 ms (first → last third) |
| R9a every scheduled job ran exactly once | pass | 5397 scheduled, 5397 recorded, 5397 ran, 0 ran more than once |
| R9b scheduler lag stays under 2 s and does not trend up | pass | worst per-minute p99 285 ms, projected growth 7 ms |
| R10 event loop lag over 200 ms in at most 5 % of samples | pass | 0 of 145 samples over 200 ms; median 0.2 ms, max 52.3 ms |
| R11 an idle backend uses under 3 % of a core | pass | 1.9 % of a core over the idle tail |
| R12 no unexpected errors | pass | 0 unexpected errors |

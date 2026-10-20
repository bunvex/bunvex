# Soak report

120 min, warm-up 24.0 min, 20 clients, 479 samples, bun 1.4.3, linux; 0 hot-counter mutations lost every OCC retry (expected).

| Rule | Result | Detail |
|---|---|---|
| R1 RSS does not trend up | **FAIL** | slope 1.8 MB/min (limit 0.5 MB), last-vs-first third 111.7 MB (limit 10.0 MB); median 615.2 MB; judged from t=1444 s |
| R2 heap does not trend up | pass | slope 0.1 MB/min (limit 0.3 MB), last-vs-first third 4.2 MB (limit 8.0 MB); median 136.7 MB; judged from t=1444 s |
| R3 the cache canary stays cached between writes | pass | 18 misses in 57660 calls past the warm-up; 18 writes into its reads |
| R4 the cache hit rate does not fall | pass | hit rate median 57.1 %, projected change -0.4 points, first-to-last third -0.3 points |
| R5 sessions, subscriptions and room members match the open clients | pass | within the reconnect allowance at every sample |
| R6 everything is freed after the clients close | pass | sessions 0, subscriptions 0, room members 0 |
| R7a file descriptors do not trend up | pass | slope 0.0/min (limit 0.2), last-vs-first third 2.0 (limit 4.0); median 45.0 |
| R7b file descriptors return to the baseline | pass | baseline 38, after the drain 25 |
| R8 http query latency does not trend up | pass | p50 3.3 → 3.4 ms, p99 123.1 → 127.6 ms (first → last third) |
| R8 http query (canary) latency does not trend up | pass | p50 1.7 → 1.7 ms, p99 121.7 → 123.7 ms (first → last third) |
| R8 schedule latency does not trend up | pass | p50 8.7 → 10.0 ms, p99 129.1 → 147.1 ms (first → last third) |
| R8 search latency does not trend up | pass | p50 6.7 → 7.3 ms, p99 117.5 → 121.4 ms (first → last third) |
| R8 sync mutation latency does not trend up | pass | p50 33.3 → 39.3 ms, p99 132.6 → 159.2 ms (first → last third) |
| R8 sync mutation (hot counter) latency does not trend up | pass | p50 89.9 → 103.9 ms, p99 387.9 → 366.6 ms (first → last third) |
| R9a every scheduled job ran exactly once | pass | 14398 scheduled, 14398 recorded, 14398 ran, 0 ran more than once |
| R9b scheduler lag stays under 2 s and does not trend up | **FAIL** | worst per-minute p99 7828 ms, projected growth 1 ms |
| R10 event loop lag over 200 ms in at most 5 % of samples | pass | 0 of 384 samples over 200 ms; median 0.2 ms, max 194.1 ms |
| R11 an idle backend uses under 3 % of a core | **FAIL** | 73.3 % of a core over the idle tail |
| R12 no unexpected errors | pass | 0 unexpected errors |

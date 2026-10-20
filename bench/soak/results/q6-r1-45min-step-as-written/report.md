# Soak report

45 min, warm-up 9.0 min, 20 clients, 180 samples, bun 1.4.2, linux; 0 hot-counter mutations lost every OCC retry (expected).

| Rule | Result | Detail |
|---|---|---|
| R1 RSS does not trend up | pass | slope 0.3 MB/min (limit 0.5 MB), last-vs-first third 5.6 MB (limit 10.0 MB); median 608.2 MB; judged from t=902 s |
| R2 heap does not trend up | pass | slope 0.3 MB/min (limit 0.3 MB), last-vs-first third -0.7 MB (limit 8.0 MB); median 156.4 MB; judged from t=902 s |
| R3 the cache canary stays cached between writes | pass | 7 misses in 21615 calls past the warm-up; 7 writes into its reads |
| R4 the cache hit rate does not fall | pass | hit rate median 57.0 %, projected change -0.2 points, first-to-last third -0.2 points |
| R5 sessions, subscriptions and room members match the open clients | pass | within the reconnect allowance at every sample |
| R6 everything is freed after the clients close | pass | sessions 0, subscriptions 0, room members 0 |
| R7a file descriptors do not trend up | pass | slope 0.0/min (limit 0.2), last-vs-first third -6.0 (limit 4.0); median 45.0 |
| R7b file descriptors return to the baseline | pass | baseline 42, after the drain 28 |
| R8 http query latency does not trend up | pass | p50 3.0 → 3.5 ms, p99 51.5 → 57.7 ms (first → last third) |
| R8 http query (canary) latency does not trend up | pass | p50 1.6 → 1.8 ms, p99 52.5 → 69.2 ms (first → last third) |
| R8 schedule latency does not trend up | pass | p50 8.4 → 10.1 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 search latency does not trend up | pass | p50 6.6 → 7.2 ms, p99 not judged (under 100 calls a window) (first → last third) |
| R8 sync mutation latency does not trend up | pass | p50 31.1 → 32.3 ms, p99 71.5 → 91.0 ms (first → last third) |
| R8 sync mutation (hot counter) latency does not trend up | pass | p50 77.0 → 82.5 ms, p99 317.1 → 295.0 ms (first → last third) |
| R9a every scheduled job ran exactly once | pass | 5377 scheduled, 5377 recorded, 5377 ran, 0 ran more than once |
| R9b scheduler lag stays under 2 s and does not trend up | pass | worst per-minute p99 400 ms, projected growth 0 ms |
| R10 event loop lag over 200 ms in at most 5 % of samples | pass | 0 of 145 samples over 200 ms; median 0.2 ms, max 154.2 ms |
| R11 an idle backend uses under 3 % of a core | pass | 2.0 % of a core over the idle tail |
| R12 no unexpected errors | pass | 0 unexpected errors |

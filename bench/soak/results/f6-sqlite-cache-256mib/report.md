# Soak report

30 min, warm-up 6.0 min, 20 clients, 120 samples, bun 1.4.3, linux; 0 hot-counter mutations lost every OCC retry (expected).

| Rule | Result | Detail |
|---|---|---|
| R1 RSS does not trend up | **FAIL** | slope 5.3 MB/min (limit 0.5 MB), last-vs-first third 54.0 MB (limit 10.0 MB); median 406.8 MB; judged from t=766 s |
| R2 heap does not trend up | pass | slope -0.1 MB/min (limit 0.3 MB), last-vs-first third -4.5 MB (limit 8.0 MB); median 128.4 MB; judged from t=766 s |
| R3 the cache canary stays cached between writes | pass | 4 misses in 14443 calls past the warm-up; 4 writes into its reads |
| R4 the cache hit rate does not fall | pass | hit rate median 57.3 %, projected change -0.3 points, first-to-last third 0.2 points |
| R5 sessions, subscriptions and room members match the open clients | pass | within the reconnect allowance at every sample |
| R6 everything is freed after the clients close | pass | sessions 0, subscriptions 0, room members 0 |
| R7a file descriptors do not trend up | pass | slope 0.0/min (limit 0.2), last-vs-first third 2.0 (limit 4.0); median 42.0 |
| R7b file descriptors return to the baseline | pass | baseline 39, after the drain 22 |
| R8 http query latency does not trend up | pass | p50 2.5 → 3.1 ms, p99 58.9 → 83.9 ms (first → last third) |
| R8 http query (canary) latency does not trend up | **FAIL** | p50 1.3 → 1.6 ms, p99 53.8 → 83.6 ms (first → last third) |
| R8 schedule latency does not trend up | pass | p50 5.7 → 8.5 ms, p99 50.3 → 44.6 ms (first → last third) |
| R8 search latency does not trend up | pass | p50 5.4 → 6.4 ms, p99 52.3 → 60.0 ms (first → last third) |
| R8 sync mutation latency does not trend up | pass | p50 22.7 → 29.1 ms, p99 93.8 → 126.2 ms (first → last third) |
| R8 sync mutation (hot counter) latency does not trend up | **FAIL** | p50 55.9 → 79.0 ms, p99 260.1 → 318.6 ms (first → last third) |
| R9a every scheduled job ran exactly once | pass | 3586 scheduled, 3586 recorded, 3586 ran, 0 ran more than once |
| R9b scheduler lag stays under 2 s and does not trend up | pass | worst per-minute p99 194 ms, projected growth -3 ms |
| R10 event loop lag over 200 ms in at most 5 % of samples | pass | 0 of 97 samples over 200 ms; median 0.2 ms, max 35.5 ms |
| R11 an idle backend uses under 3 % of a core | pass | 1.9 % of a core over the idle tail |
| R12 no unexpected errors | pass | 0 unexpected errors |

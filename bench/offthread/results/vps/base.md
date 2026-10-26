## sqlite-cached-r1

7755 req/s, p99 14.4 ms, errors 0.00%, server 0.85 cores (bun 0.81)


## sqlite-cached-r2

8278 req/s, p99 13.9 ms, errors 0.00%, server 0.86 cores (bun 0.82, JITWorker 0.03)


## sqlite-uncached-r1

2282 req/s, p99 44.8 ms, errors 0.00%, server 0.98 cores (bun 0.86, JITWorker 0.09, JSCWarmUp 0.02)


## sqlite-uncached-r2

2538 req/s, p99 36.3 ms, errors 0.00%, server 0.99 cores (bun 0.87, JITWorker 0.08, JSCWarmUp 0.02)


## sqlite-insert-r1

1412 req/s, p99 90.4 ms, errors 0.00%, server 0.71 cores (bun 0.61, JITWorker 0.08)


## sqlite-insert-r2

1892 req/s, p99 47.9 ms, errors 0.00%, server 0.77 cores (bun 0.67, JITWorker 0.08)


## sqlite-increment1000-r1

1158 req/s, p99 97.8 ms, errors 0.00%, server 0.83 cores (bun 0.69, JITWorker 0.12)


## sqlite-increment1000-r2

1283 req/s, p99 68.4 ms, errors 0.00%, server 0.86 cores (bun 0.72, JITWorker 0.12)


## postgres-cached-r1

8354 req/s, p99 13.3 ms, errors 0.00%, server 0.86 cores (bun 0.81, JITWorker 0.03)


## postgres-cached-r2

6078 req/s, p99 24.8 ms, errors 0.00%, server 0.86 cores (bun 0.77, JITWorker 0.06)


## postgres-uncached-r1

1190 req/s, p99 82.7 ms, errors 0.00%, server 0.79 cores (bun 0.65, JITWorker 0.11)


## postgres-uncached-r2

1053 req/s, p99 109.4 ms, errors 0.00%, server 0.77 cores (bun 0.64, JITWorker 0.09)


## postgres-insert-r1

1603 req/s, p99 45.8 ms, errors 0.00%, server 0.64 cores (bun 0.51, JITWorker 0.10)


## postgres-insert-r2

1157 req/s, p99 84.2 ms, errors 0.00%, server 0.62 cores (bun 0.48, JITWorker 0.10)


## postgres-increment1000-r1

453 req/s, p99 206.1 ms, errors 0.17%, server 0.56 cores (bun 0.42, JITWorker 0.12)


## postgres-increment1000-r2

406 req/s, p99 274.0 ms, errors 0.18%, server 0.55 cores (bun 0.41, JITWorker 0.12)


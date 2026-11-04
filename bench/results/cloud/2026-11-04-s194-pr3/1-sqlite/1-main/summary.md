# single at a86df6a2: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | insert | 3299 | 3218–3299 | 40.5 | 1.15 | 1.20 | 0.58 | 0.000 |
| sqlite | 1 | increment1000 | 1789 | 1703–1789 | 105.3 | 1.08 | 1.11 | 0.32 | 0.001 |
| sqlite | 1 | increment1 | 381 | 375–381 | 1182.6 | 0.74 | 0.79 | 0.15 | 0.141 |
| sqlite | 1 | mix | 3691 | 3630–3691 | 40.6 | 2.36 | 2.38 | 0.84 | 0.000 |
| sqlite | 1 | uncached | 3205 | 3158–3205 | 42.8 | 2.49 | 2.50 | 0.79 | 0.000 |

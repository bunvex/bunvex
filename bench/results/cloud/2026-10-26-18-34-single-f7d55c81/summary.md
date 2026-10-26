# single at f7d55c81: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | cached | 8414 | 7151–8655 | 8.9 | 0.93 | 0.94 | 1.84 | 0.000 |
| sqlite | 1 | uncached | 1865 | 1802–1959 | 34.3 | 1.01 | 1.03 | 0.58 | 0.000 |
| sqlite | 1 | insert | 1596 | 1578–1610 | 43.0 | 0.74 | 0.78 | 0.32 | 0.000 |
| sqlite | 1 | increment1000 | 1134 | 1130–1136 | 44.7 | 0.84 | 0.86 | 0.24 | 0.000 |

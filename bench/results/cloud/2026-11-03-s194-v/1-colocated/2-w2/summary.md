# single at 121fa495: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1780 | 1759–1790 | 83.4 | 1.98 | 2.84 | 0.46 | 0.000 |
| postgres | 1 | cached | 7784 | 7741–8502 | 18.1 | 0.86 | 0.88 | 1.57 | 0.000 |
| postgres | 1 | insert | 2424 | 2358–2481 | 52.3 | 0.94 | 1.17 | 0.41 | 0.000 |

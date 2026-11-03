# single at a2b0b410: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1831 | 1777–1927 | 66.2 | 0.96 | 0.98 | 0.49 | 0.000 |
| sqlite | 1 | cached | 7102 | 6161–7894 | 18.2 | 0.86 | 0.88 | 1.23 | 0.000 |
| sqlite | 1 | insert | 2435 | 2336–2471 | 53.8 | 1.03 | 1.09 | 0.36 | 0.000 |

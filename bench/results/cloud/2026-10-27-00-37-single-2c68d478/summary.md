# single at 2c68d478: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1709 | 1701–1821 | 36.6 | 1.00 | 1.02 | 0.56 | 0.000 |
| sqlite | 1 | insert | 1267 | 1168–1453 | 153.2 | 0.68 | 0.70 | 0.26 | 0.000 |

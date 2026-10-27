# single at 2c68d478: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1730 | 1704–1773 | 36.4 | 1.00 | 1.01 | 0.56 | 0.000 |
| sqlite | 1 | insert | 1665 | 1621–1692 | 65.4 | 0.91 | 0.95 | 0.35 | 0.000 |

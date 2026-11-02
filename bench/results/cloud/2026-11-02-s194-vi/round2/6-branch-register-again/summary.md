# single at a2b0b410: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1900 | 1826–1932 | 64.2 | 0.97 | 0.98 | 0.47 | 0.000 |
| sqlite | 1 | cached | 7294 | 7082–7544 | 17.8 | 0.86 | 0.89 | 1.25 | 0.000 |
| sqlite | 1 | insert | 2508 | 2498–2579 | 54.4 | 1.06 | 1.12 | 0.36 | 0.000 |

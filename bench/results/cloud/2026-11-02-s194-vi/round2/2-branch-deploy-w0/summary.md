# single at a2b0b410: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1664 | 1601–1737 | 74.7 | 0.97 | 0.99 | 0.48 | 0.000 |
| sqlite | 1 | cached | 7118 | 6534–7269 | 18.8 | 0.87 | 0.88 | 1.22 | 0.000 |
| sqlite | 1 | insert | 2155 | 2136–2210 | 59.5 | 1.09 | 1.13 | 0.32 | 0.000 |

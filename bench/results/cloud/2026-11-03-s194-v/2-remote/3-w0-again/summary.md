# single at 7bf69e23: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1578 | 1558–1603 | 84.3 | 0.99 | 1.00 | 0.72 | 0.000 |
| postgres | 1 | cached | 7990 | 7734–8076 | 17.7 | 0.86 | 0.89 | 1.54 | 0.000 |
| postgres | 1 | insert | 1962 | 1724–1965 | 55.5 | 0.76 | 0.77 | 0.45 | 0.000 |

# single at 7bf69e23: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 2252 | 2213–2322 | 68.4 | 2.39 | 2.39 | 1.77 | 0.000 |
| postgres | 1 | cached | 7691 | 7656–7991 | 18.3 | 0.87 | 0.88 | 1.57 | 0.000 |
| postgres | 1 | insert | 1606 | 1596–1714 | 75.0 | 0.71 | 0.73 | 0.41 | 0.000 |

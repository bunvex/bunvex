# single at 9db90f54: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1771 | 1739–1798 | 68.6 | 0.96 | 0.98 | 0.37 | 0.000 |
| sqlite | 1 | cached | 8089 | 7504–8392 | 16.9 | 0.87 | 0.89 | 1.27 | 0.000 |
| sqlite | 1 | insert | 2581 | 2577–2607 | 51.5 | 1.11 | 1.15 | 0.37 | 0.000 |

# single at fd8d98be: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | cached | 7037 | 7030–7372 | 10.0 | 0.92 | 0.94 | 1.62 | 0.000 |
| sqlite | 1 | uncached | 1865 | 1763–1897 | 34.4 | 1.02 | 1.04 | 0.58 | 0.000 |
| sqlite | 1 | insert | 2325 | 2301–2369 | 34.1 | 1.10 | 1.15 | 0.43 | 0.000 |
| sqlite | 1 | increment1000 | 1377 | 1367–1388 | 42.7 | 1.15 | 1.18 | 0.30 | 0.000 |

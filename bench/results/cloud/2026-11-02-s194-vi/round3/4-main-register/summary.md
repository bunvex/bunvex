# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1938 | 1938–1944 | 63.4 | 0.95 | 0.97 | 0.47 | 0.000 |
| sqlite | 1 | cached | 7364 | 6904–8619 | 17.5 | 0.87 | 0.89 | 1.39 | 0.000 |
| sqlite | 1 | insert | 2258 | 2252–2279 | 98.2 | 0.91 | 0.96 | 0.38 | 0.000 |

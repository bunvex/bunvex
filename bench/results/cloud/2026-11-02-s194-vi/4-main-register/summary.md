# single at c823eace: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1941 | 1801–2032 | 64.1 | 0.97 | 0.98 | 0.37 | 0.000 |
| sqlite | 1 | cached | 7894 | 7679–8181 | 17.3 | 0.88 | 0.89 | 1.26 | 0.000 |
| sqlite | 1 | insert | 2682 | 2652–2695 | 49.8 | 1.12 | 1.16 | 0.36 | 0.000 |

# single at 8d856153: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1998 | 1966–2025 | 31.5 | 0.98 | 0.99 | 0.66 | 0.000 |
| sqlite | 1 | insert | 1894 | 1312–1943 | 66.8 | 0.79 | 0.82 | 0.39 | 0.000 |

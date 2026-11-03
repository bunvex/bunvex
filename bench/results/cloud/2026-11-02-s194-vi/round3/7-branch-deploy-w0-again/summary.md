# single at 8a26b776: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1720 | 1709–1838 | 72.0 | 0.97 | 0.99 | 0.44 | 0.000 |
| sqlite | 1 | cached | 7959 | 7865–8047 | 18.1 | 0.87 | 0.89 | 1.48 | 0.000 |
| sqlite | 1 | insert | 2038 | 1990–2042 | 93.5 | 0.97 | 1.02 | 0.34 | 0.000 |

# single at a2b0b410: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 3107 | 2981–3163 | 47.9 | 2.46 | 2.49 | 0.65 | 0.000 |
| sqlite | 1 | cached | 6997 | 6271–7390 | 18.7 | 0.87 | 0.89 | 1.18 | 0.000 |
| sqlite | 1 | insert | 2158 | 2149–2204 | 58.0 | 1.07 | 1.12 | 0.33 | 0.000 |

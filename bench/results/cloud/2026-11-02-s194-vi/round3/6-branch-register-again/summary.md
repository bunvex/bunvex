# single at 8a26b776: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 2017 | 1895–2054 | 60.1 | 0.97 | 0.98 | 0.50 | 0.000 |
| sqlite | 1 | cached | 8042 | 7984–8198 | 18.0 | 0.87 | 0.89 | 1.49 | 0.000 |
| sqlite | 1 | insert | 2191 | 2024–2289 | 101.1 | 0.92 | 0.95 | 0.36 | 0.000 |

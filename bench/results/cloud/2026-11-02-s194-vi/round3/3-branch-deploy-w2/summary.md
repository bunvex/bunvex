# single at 8a26b776: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 3201 | 3131–3245 | 45.6 | 2.48 | 2.49 | 0.72 | 0.000 |
| sqlite | 1 | cached | 6805 | 6786–6853 | 19.8 | 0.85 | 0.87 | 1.34 | 0.000 |
| sqlite | 1 | insert | 2057 | 2042–2094 | 80.4 | 0.98 | 1.02 | 0.35 | 0.000 |

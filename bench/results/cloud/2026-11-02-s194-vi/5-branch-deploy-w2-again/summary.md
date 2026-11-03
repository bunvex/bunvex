# single at 9db90f54: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 3074 | 3040–3180 | 50.7 | 2.40 | 2.40 | 0.58 | 0.000 |
| sqlite | 1 | cached | 6905 | 6488–7878 | 19.2 | 0.88 | 0.90 | 1.12 | 0.000 |
| sqlite | 1 | insert | 2204 | 2152–2262 | 57.3 | 1.14 | 1.18 | 0.31 | 0.000 |

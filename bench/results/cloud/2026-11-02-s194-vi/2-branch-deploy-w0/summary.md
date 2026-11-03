# single at 9db90f54: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1562 | 1547–1603 | 78.3 | 0.97 | 0.98 | 0.33 | 0.000 |
| sqlite | 1 | cached | 8097 | 8095–8404 | 17.0 | 0.87 | 0.89 | 1.30 | 0.000 |
| sqlite | 1 | insert | 2186 | 2168–2234 | 57.3 | 1.14 | 1.18 | 0.33 | 0.000 |

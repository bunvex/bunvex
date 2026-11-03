# single at 9db90f54: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1553 | 1546–1574 | 77.7 | 0.98 | 0.99 | 0.32 | 0.000 |
| sqlite | 1 | cached | 7173 | 7154–7773 | 18.4 | 0.89 | 0.90 | 1.19 | 0.000 |
| sqlite | 1 | insert | 2171 | 2156–2228 | 62.3 | 1.14 | 1.18 | 0.32 | 0.000 |

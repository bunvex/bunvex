# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1764 | 1723–1810 | 70.6 | 0.95 | 0.97 | 0.42 | 0.000 |
| sqlite | 1 | cached | 8009 | 7022–8272 | 17.6 | 0.85 | 0.87 | 1.35 | 0.000 |
| sqlite | 1 | insert | 2071 | 1939–2108 | 89.9 | 0.99 | 1.02 | 0.34 | 0.000 |

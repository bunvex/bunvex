# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1741 | 1729–1757 | 71.3 | 0.97 | 0.98 | 0.43 | 0.000 |
| sqlite | 1 | cached | 7901 | 6905–8339 | 17.9 | 0.88 | 0.90 | 1.46 | 0.000 |
| sqlite | 1 | insert | 2113 | 2039–2119 | 83.1 | 0.99 | 1.02 | 0.35 | 0.000 |

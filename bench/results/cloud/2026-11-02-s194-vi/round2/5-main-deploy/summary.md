# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1752 | 1600–1772 | 72.3 | 0.97 | 0.99 | 0.47 | 0.000 |
| sqlite | 1 | cached | 7186 | 6380–7472 | 18.2 | 0.87 | 0.89 | 1.24 | 0.000 |
| sqlite | 1 | insert | 2317 | 2245–2362 | 55.9 | 1.10 | 1.14 | 0.35 | 0.000 |

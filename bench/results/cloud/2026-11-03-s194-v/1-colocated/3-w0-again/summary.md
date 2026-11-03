# single at 121fa495: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1528 | 1470–1532 | 83.9 | 0.99 | 1.27 | 0.45 | 0.000 |
| postgres | 1 | cached | 7769 | 7137–7817 | 17.9 | 0.86 | 0.89 | 1.60 | 0.000 |
| postgres | 1 | insert | 2487 | 2460–2498 | 47.2 | 0.93 | 1.16 | 0.42 | 0.000 |

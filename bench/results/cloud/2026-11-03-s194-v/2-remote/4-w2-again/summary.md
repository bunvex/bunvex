# single at 7bf69e23: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 2242 | 2229–2362 | 66.9 | 2.40 | 2.42 | 1.71 | 0.000 |
| postgres | 1 | cached | 7578 | 6807–7632 | 18.7 | 0.87 | 0.88 | 1.48 | 0.000 |
| postgres | 1 | insert | 1584 | 1533–1627 | 103.8 | 0.72 | 0.72 | 0.42 | 0.000 |

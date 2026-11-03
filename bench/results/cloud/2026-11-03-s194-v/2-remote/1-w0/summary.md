# single at cec8c553: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1614 | 1613–1696 | 77.0 | 0.99 | 1.01 | 0.75 | 0.000 |
| postgres | 1 | cached | 7675 | 7174–8458 | 17.8 | 0.86 | 0.88 | 1.53 | 0.000 |
| postgres | 1 | insert | 1688 | 1627–1702 | 70.7 | 0.71 | 0.71 | 0.43 | 0.000 |

# single at 121fa495: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1773 | 1725–1780 | 84.5 | 1.99 | 2.84 | 0.47 | 0.000 |
| postgres | 1 | cached | 7961 | 7489–8099 | 18.0 | 0.87 | 0.89 | 1.58 | 0.000 |
| postgres | 1 | insert | 2351 | 2321–2401 | 54.4 | 0.95 | 1.18 | 0.38 | 0.000 |

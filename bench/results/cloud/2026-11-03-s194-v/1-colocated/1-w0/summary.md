# single at 121fa495: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | uncached | 1554 | 1515–1604 | 80.4 | 0.98 | 1.27 | 0.44 | 0.000 |
| postgres | 1 | cached | 7935 | 7650–8583 | 17.6 | 0.84 | 0.86 | 1.58 | 0.000 |
| postgres | 1 | insert | 2484 | 2479–2507 | 49.0 | 0.91 | 1.12 | 0.40 | 0.000 |

# single at 2b5c23c7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | insert | 3761 | 3693–3761 | 40.6 | 2.01 | 2.07 | 0.59 | 0.000 |
| sqlite | 1 | increment1000 | 2655 | 2620–2655 | 101.8 | 2.45 | 2.50 | 0.45 | 0.000 |
| sqlite | 1 | increment1 | 345 | 341–345 | 1205.8 | 1.09 | 1.15 | 0.13 | 0.126 |
| sqlite | 1 | mix | 3694 | 3619–3694 | 39.7 | 2.54 | 2.57 | 0.86 | 0.000 |
| sqlite | 1 | uncached | 3169 | 3087–3169 | 40.3 | 2.53 | 2.54 | 0.79 | 0.000 |

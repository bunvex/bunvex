# single at 2b5c23c7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | insert | 3728 | 3700–3728 | 42.8 | 2.00 | 2.05 | 0.58 | 0.000 |
| sqlite | 1 | increment1000 | 2639 | 2623–2639 | 103.4 | 2.44 | 2.49 | 0.45 | 0.000 |
| sqlite | 1 | increment1 | 345 | 342–345 | 1189.7 | 1.10 | 1.15 | 0.14 | 0.128 |
| sqlite | 1 | mix | 3670 | 3643–3670 | 41.0 | 2.53 | 2.57 | 0.86 | 0.000 |
| sqlite | 1 | uncached | 3233 | 3063–3233 | 42.8 | 2.50 | 2.51 | 0.79 | 0.000 |

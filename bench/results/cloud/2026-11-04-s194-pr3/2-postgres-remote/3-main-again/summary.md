# single at a86df6a2: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | insert | 2293 | 2282–2293 | 46.8 | 0.79 | 0.79 | 0.58 | 0.000 |
| postgres | 1 | increment1000 | 1372 | 1360–1372 | 250.9 | 1.00 | 1.01 | 1.56 | 0.002 |
| postgres | 1 | increment1 | 136 | 135–136 | 1267.0 | 0.49 | 0.51 | 0.83 | 0.311 |
| postgres | 1 | mix | 3424 | 3269–3424 | 75.2 | 2.28 | 2.30 | 1.20 | 0.000 |

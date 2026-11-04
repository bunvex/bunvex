# single at a86df6a2: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | insert | 2292 | 2217–2292 | 75.9 | 0.76 | 0.77 | 0.58 | 0.000 |
| postgres | 1 | increment1000 | 1389 | 1386–1389 | 178.3 | 0.99 | 1.01 | 1.61 | 0.001 |
| postgres | 1 | increment1 | 136 | 135–136 | 1277.4 | 0.50 | 0.51 | 0.84 | 0.318 |
| postgres | 1 | mix | 3453 | 3368–3453 | 63.7 | 2.29 | 2.31 | 1.10 | 0.000 |

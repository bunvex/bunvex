# single at a86df6a2: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | insert | 3205 | 3188–3205 | 42.0 | 1.18 | 1.23 | 0.50 | 0.000 |
| sqlite | 1 | increment1000 | 1727 | 1689–1727 | 122.0 | 1.07 | 1.10 | 0.31 | 0.001 |
| sqlite | 1 | increment1 | 374 | 364–374 | 1185.2 | 0.74 | 0.78 | 0.15 | 0.141 |
| sqlite | 1 | mix | 3720 | 3648–3720 | 40.5 | 2.38 | 2.42 | 0.85 | 0.000 |
| sqlite | 1 | uncached | 3213 | 3187–3213 | 43.5 | 2.52 | 2.52 | 0.78 | 0.000 |

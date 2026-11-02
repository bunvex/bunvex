# single at a2b0b410: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 3178 | 3169–3182 | 45.7 | 2.50 | 2.52 | 0.67 | 0.000 |
| sqlite | 1 | cached | 7089 | 6176–7431 | 18.5 | 0.88 | 0.90 | 1.25 | 0.000 |
| sqlite | 1 | insert | 2101 | 2090–2202 | 61.3 | 1.08 | 1.12 | 0.32 | 0.000 |

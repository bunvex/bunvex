# single at 8a26b776: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1716 | 1659–1820 | 71.1 | 0.96 | 0.97 | 0.43 | 0.000 |
| sqlite | 1 | cached | 7946 | 7696–8137 | 18.2 | 0.88 | 0.90 | 1.47 | 0.000 |
| sqlite | 1 | insert | 2078 | 2016–2088 | 74.2 | 0.99 | 1.03 | 0.35 | 0.000 |

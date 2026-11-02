# single at 8a26b776: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1929 | 1929–2007 | 62.6 | 0.95 | 0.97 | 0.49 | 0.000 |
| sqlite | 1 | cached | 8420 | 6849–8908 | 17.2 | 0.86 | 0.88 | 1.57 | 0.000 |
| sqlite | 1 | insert | 2273 | 2253–2341 | 89.7 | 0.93 | 0.96 | 0.38 | 0.000 |

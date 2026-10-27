# single at 8d856153: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 2052 | 1982–2109 | 31.4 | 0.99 | 1.00 | 0.68 | 0.000 |
| sqlite | 1 | insert | 1919 | 1877–1922 | 54.6 | 0.79 | 0.83 | 0.40 | 0.000 |

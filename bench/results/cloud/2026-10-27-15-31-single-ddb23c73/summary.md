# single at ddb23c73: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1984 | 1961–2070 | 32.0 | 1.00 | 1.01 | 0.56 | 0.000 |
| sqlite | 1 | insert | 2083 | 2061–2098 | 46.3 | 0.87 | 0.91 | 0.37 | 0.000 |

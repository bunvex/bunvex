# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1925 | 1837–1961 | 62.4 | 0.97 | 0.99 | 0.49 | 0.000 |
| sqlite | 1 | cached | 7153 | 6966–7553 | 18.1 | 0.87 | 0.89 | 1.24 | 0.000 |
| sqlite | 1 | insert | 2648 | 2631–2683 | 50.7 | 1.06 | 1.12 | 0.39 | 0.000 |

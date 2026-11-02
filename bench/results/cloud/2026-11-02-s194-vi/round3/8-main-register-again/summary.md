# single at 8243ffe7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1953 | 1895–1984 | 63.8 | 0.96 | 0.97 | 0.47 | 0.000 |
| sqlite | 1 | cached | 8163 | 7816–8485 | 17.9 | 0.88 | 0.89 | 1.52 | 0.000 |
| sqlite | 1 | insert | 2309 | 2306–2371 | 77.1 | 0.93 | 0.97 | 0.39 | 0.000 |

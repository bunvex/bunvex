# single at 9db90f54: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 3128 | 2976–3244 | 46.9 | 2.49 | 2.49 | 0.59 | 0.000 |
| sqlite | 1 | cached | 7122 | 6431–7255 | 19.2 | 0.88 | 0.89 | 1.08 | 0.000 |
| sqlite | 1 | insert | 2160 | 2154–2200 | 69.2 | 1.13 | 1.17 | 0.30 | 0.000 |

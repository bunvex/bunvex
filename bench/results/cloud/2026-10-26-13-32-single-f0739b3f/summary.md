# single at f0739b3f: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | cached | 6613 | 6503–6759 | 20.6 | 0.89 | 0.90 | 1.54 | 0.000 |
| sqlite | 1 | uncached | 1881 | 1820–2041 | 63.4 | 0.98 | 1.00 | 0.59 | 0.000 |
| sqlite | 1 | insert | 1604 | 1556–1634 | 230.8 | 0.62 | 0.65 | 0.32 | 0.000 |
| sqlite | 1 | increment1000 | 1076 | 1054–1151 | 298.2 | 0.76 | 0.79 | 0.25 | 0.001 |
| postgres | 1 | cached | 7473 | 7282–7726 | 18.4 | 0.91 | 0.93 | 1.66 | 0.000 |
| postgres | 1 | uncached | 1581 | 1576–1599 | 81.7 | 0.98 | 1.33 | 0.52 | 0.000 |
| postgres | 1 | insert | 2017 | 1990–2095 | 82.5 | 0.72 | 0.96 | 0.40 | 0.000 |
| postgres | 1 | increment1000 | 999 | 964–1024 | 402.3 | 0.97 | 2.13 | 0.22 | 0.002 |

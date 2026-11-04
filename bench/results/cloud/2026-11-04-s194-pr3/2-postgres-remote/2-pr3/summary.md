# single at 2b5c23c7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | insert | 2784 | 2745–2784 | 40.5 | 1.47 | 1.48 | 0.72 | 0.000 |
| postgres | 1 | increment1000 | 1789 | 1782–1789 | 158.8 | 2.03 | 2.04 | 2.05 | 0.001 |
| postgres | 1 | increment1 | 129 | 127–129 | 1284.6 | 0.73 | 0.76 | 0.88 | 0.326 |
| postgres | 1 | mix | 3583 | 3521–3583 | 63.6 | 2.42 | 2.43 | 1.23 | 0.000 |

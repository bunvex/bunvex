# single at 2b5c23c7: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8280 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| postgres | 1 | insert | 2832 | 2811–2832 | 41.6 | 1.46 | 1.46 | 0.70 | 0.000 |
| postgres | 1 | increment1000 | 1825 | 1767–1825 | 155.7 | 2.00 | 2.03 | 2.07 | 0.001 |
| postgres | 1 | increment1 | 132 | 130–132 | 1278.3 | 0.73 | 0.75 | 0.87 | 0.324 |
| postgres | 1 | mix | 3455 | 3387–3455 | 62.6 | 2.42 | 2.43 | 1.24 | 0.000 |

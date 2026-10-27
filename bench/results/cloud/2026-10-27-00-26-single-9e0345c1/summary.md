# single at 9e0345c1: server 4 vCPUs, Intel(R) Xeon(R) Platinum 8168 CPU @ 2.70GHz

| store | servers | scenario | req/s (median) | range | p99 ms | server cores | box cores | load box cores | errors |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite | 1 | uncached | 1964 | 1936–2059 | 32.5 | 0.97 | 0.98 | 0.62 | 0.000 |
| sqlite | 1 | insert | 1868 | 1842–1869 | 66.6 | 0.82 | 0.85 | 0.38 | 0.000 |

`9e0345c1` is a measurement-only commit, never pushed: `2c68d478` with the codec bypassed (the request and the outcome passed as objects through the same boundary), to separate the codec's cost from the boundary's (STUDY-190 PR 2a).

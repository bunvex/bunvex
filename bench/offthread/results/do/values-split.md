Bun 1.4.4, linux/x64, N=20000

| main-thread work per query (20 documents) | µs |
|---|---:|
| decode: JSON.parse + fromJsonValue of 20 stored documents | 23.0 |
| result: surrogate walk, two sizes, toJsonValue, JSON.stringify | 78.5 |
| hand-off: the 20 values as objects, both ways (structured clone) | 53.4 |
| hand-off: 20 stored JSON texts in, one result text out (strings) | 7.9 |
| hand-off: one result text each way (strings) | 2.3 |

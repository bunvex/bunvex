Bun 1.4.4, darwin/arm64, N=20000

| main-thread work per query (20 documents) | µs |
|---|---:|
| decode: JSON.parse + fromJsonValue of 20 stored documents | 9.5 |
| result: surrogate walk, two sizes, toJsonValue, JSON.stringify | 30.1 |
| hand-off: the 20 values as objects, both ways (structured clone) | 18.0 |
| hand-off: 20 stored JSON texts in, one result text out (strings) | 2.5 |
| hand-off: one result text each way (strings) | 0.9 |

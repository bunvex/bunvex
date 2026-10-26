Bun 1.4.4, darwin/arm64, N=50000, WINDOW=64

| payload | round trip, 1 in flight (µs) | per message, pipelined (µs) | messages/s | main thread CPU per message (µs, Linux) |
|---|---:|---:|---:|---:|
| string 100 B | 7.8 | 0.54 | 1851k | — |
| string 3.4 KiB | 8.7 | 0.69 | 1449k | — |
| 20 objects (clone) | 40.4 | 19.45 | 51k | — |
| 20 docs as bytes (transfer) | 12.2 | 2.07 | 482k | — |
| sync call (SharedArrayBuffer + Atomics.wait), no payload | 0.2 | — | — | — |

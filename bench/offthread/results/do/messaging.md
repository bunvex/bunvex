Bun 1.4.4, linux/x64, N=50000, WINDOW=64

| payload | round trip, 1 in flight (µs) | per message, pipelined (µs) | messages/s | main thread CPU per message (µs, Linux) |
|---|---:|---:|---:|---:|
| string 100 B | 23.6 | 2.39 | 419k | 2.40 |
| string 3.4 KiB | 19.9 | 2.04 | 489k | 2.00 |
| 20 objects (clone) | 141.0 | 70.19 | 14k | 62.00 |
| 20 docs as bytes (transfer) | 35.0 | 6.42 | 156k | 6.20 |
| sync call (SharedArrayBuffer + Atomics.wait), no payload | 1.2 | — | — | — |

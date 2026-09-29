# ENGINE-00 — microbenchmark results (29 Sep 2026)

`bun bench/run.ts all` (`SECS=5`), Bun 1.4.2, in-process, **no HTTP, no function runtime, no reactivity**:
these measure the engine core's headroom, not an end-to-end number. The VPS is the Hostinger KVM2 used for
every `convex-bench` run (2 vCPU AMD EPYC 9354P, 8 GB, real fsync); the Mac is an M1 Pro (macOS `fsync`
is not durable, so its durable-write numbers are optimistic).

## M1 — key encoding (C1)

| | Mac | VPS |
|---|--:|--:|
| order mismatches (20 000 mixed-type tuples, incl. −0, ±MAX, ±2^53, NUL bytes) | 0 | 0 |
| encodes/s, one core, `(tenantId, createdAt, uuid)` | 3.64 M | 3.24 M |

## M2 — durable commits (C2 + C3): 1 document + 2 index entries per commit, group commit

commits/s (p99 ms):

| storage | durable | conc 1 | conc 16 | conc 128 |
|---|---|--:|--:|--:|
| S-A `bun:sqlite` (WAL, `synchronous=full`) | **VPS** | 2 080 (1.4) | 10 064 (8.8) | **14 259** (20.2) |
| S-B memory + log (`fdatasync` per group, off-thread) | **VPS** | 1 695 (1.3) | 19 315 (2.4) | **42 394** (12.7) |
| S-A | Mac | 8 176 (1.0) | 15 264 (10.0) | 19 925 (18.5) |
| S-B | Mac | 14 265 (0.1) | 93 643 (0.6) | 158 293 (2.8) |
| S-A, not durable | VPS | 15 271 | 24 358 | 30 848 |
| S-B, not durable | VPS | 17 739 | 58 029 | 66 918 |

At concurrency 1 each commit pays one fsync (~0.5 ms on the VPS); group commit amortises it (group size
= concurrency here).

## M3 — snapshot range read (C7): `withIndex(by_tenant_created, eq).order(desc).take(20)` + 20 document fetches, 100 000 documents, one core

| storage | Mac q/s (p99) | VPS q/s (p99) |
|---|--:|--:|
| S-A `bun:sqlite` | 7 201 (0.24 ms) | 6 185 (0.25 ms) |
| S-B memory | 152 689 (0.014 ms) | 54 957 (0.039 ms) |

## M4 — OCC validation (C4)

| commits since the snapshot | 1 | 10 | 100 | 1 000 |
|---|--:|--:|--:|--:|
| µs per validation (VPS) | 0.06 | 0.27 | 2.4 | 23.6 |

Read-modify-write over 1 000 distinct keys, 32 transactions in flight, 200 000 attempts: **3.01 %
conflicts, 0 false conflicts** (every conflict is a real same-key collision). The same workload under
Postgres SERIALIZABLE in minivex aborted 59 % of attempts (index-page SIREAD locks).

## Against Convex self-hosted on the same VPS (end-to-end, `convex-bench`)

| | Convex (HTTP + V8 + engine + Postgres) | bunvex core S-A | bunvex core S-B |
|---|--:|--:|--:|
| durable insert / s | 427 | 14 259 (33×) | 42 394 (99×) |
| uncached indexed read / s | 298 | 6 185 (21×) | 54 957 (184×) |

The ratios are headroom, not the final result: HTTP, validation, the function runtime and reactivity
still have to be paid. On this box the HTTP layer with k6 co-located capped raw Bun + Postgres at about
9 800 req/s, so end-to-end bunvex is expected to be bound by HTTP, not by the engine. Next: M5 (the
`convex-bench` functions in-process) and the HTTP server, then the same `convex-bench` run.

## Caveats

- M3's `rss_mb` is not a memory measurement (the process held M2's storages); M6 measures memory alone.
- S-B keeps every version in RAM and has no retention, snapshotting or log replay yet.
- One run per point.

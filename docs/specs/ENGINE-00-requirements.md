# ENGINE-00 — bunvex: a Convex-style engine in Bun, with its own storage engine

> **v0, requirements and measurement plan.** Name is temporary. Written 29 Sep 2026 against the Convex
> source cloned at `~/sandbox/convex-backend` and the numbers from `~/sandbox/convex-bench`.

## 0. The goal

Rebuild what Convex's Rust backend does — its own database on top of a dumb durable store — in Bun +
TypeScript, **without Postgres**, and beat Convex self-hosted on the same `convex-bench` harness.

## 1. What Convex actually asks of its storage

Convex's persistence layer is two generic tables plus a globals table
(`crates/sqlite/src/lib.rs:608-640`), identical for every app:

```sql
documents (id, ts, table_id, json_value, deleted, prev_ts)   -- every VERSION of every document
indexes   (index_id, ts, key BLOB, deleted, document_id)     -- every index entry, as sortable bytes
```

and the `Persistence` trait (`crates/common/src/persistence/mod.rs`) needs only: an atomic batched
`write`, `index_scan` / `index_get` (an ordered range of binary keys **as of timestamp `ts`**),
`load_documents` (the log by time range), `previous_revisions`, and globals. It is an **ordered, versioned
key-value store**. Everything that makes it a database is Convex's own code. bunvex does the same.

## 2. The components

| # | component | what it does | MVP? |
|---|---|---|---|
| C1 | **key encoding** | order-preserving bytes for values (null, bool, number as f64, string, id, arrays) so index order = byte order | yes |
| C2 | **storage engine** | durable, ordered, versioned KV: the log of document versions + index entries; group commit; crash recovery | yes |
| C3 | **timestamp oracle + committer** | ONE writer assigns strictly increasing commit timestamps and serialises commits | yes |
| C4 | **transactions (OCC)** | a mutation reads at a snapshot `ts`, records its read-set (index intervals) and write-set; at commit the committer checks the read-set against writes committed after `ts`; conflict → retry | yes |
| C5 | **in-memory write log** | the last N seconds of commits, for C4 validation and C8 invalidation | yes |
| C6 | **index maintenance** | on write, compute the old/new entries of every declared index | yes |
| C7 | **query engine** | `withIndex(eq/range).order().take()/paginate()` over C2 at a snapshot, plus filters | yes |
| C8 | **reactivity** | subscriptions keep their read-set; each commit is intersected with them; affected ones re-run and push | yes |
| C9 | **query cache** | results keyed by (function, args, identity), invalidated by C8 | yes |
| C10 | **function runtime** | query / mutation / action functions. Convex uses V8 isolates; bunvex runs them in-process (like minivex) — sandboxing is a later decision | yes (no sandbox) |
| C11 | **wire** | HTTP one-shot API compatible with `convex-bench` + WebSocket sync protocol | yes |
| C12 | **schema** | validators, table/index registry, migrations of index definitions (backfill) | minimal |
| C13 | **retention / GC** | delete versions older than the retention window; compaction | later |
| C14 | **scheduler, crons, file storage, auth, search, vector** | the rest of Convex's surface | later |
| C15 | **snapshot export / import, backup** | | later |

## 3. The storage-engine decision (C2) — the one that decides performance

| option | model | pros | cons |
|---|---|---|---|
| **S-A `bun:sqlite`, Convex's two tables** | SQLite is the ordered KV (B-tree), WAL mode | embedded, no network, crash-safe, trivially durable; exactly Convex's shape | one writer; every read is a SQL call (≈µs, but JS↔native per row); versioned reads need `max(ts) ≤ T` per key |
| **S-B in-memory state + append-only log** | the latest state and indexes live in RAM (sorted structures); durability = an append-only commit log fsync'd per group; SQLite / files for snapshots | reads never touch disk or SQL; fastest possible | memory bound by data size; restart = replay log from a snapshot; MVCC must be done in memory (keep recent versions) |
| **S-C LMDB / RocksDB via bindings** | a real ordered KV store | fast, mature, MVCC (LMDB) | native bindings under Bun must be validated; not the goal of "own engine" unless needed |
| **S-D a remote store** (FoundationDB, Postgres as KV) | Convex's cloud-like shape | multi-node durability | network per read; this is what made Convex+Postgres slow |

v0 measures **S-A and S-B**; S-C only if both fail their targets.

## 4. The bar (Convex self-hosted, measured with `convex-bench`)

| scenario | Mac M1 Pro, Postgres (req/s · p99) | VPS 2 vCPU, Postgres (req/s · p99) |
|---|--:|--:|
| query, cached | ~26 000 · 0.7 ms | 4 850 · 19 ms |
| query, uncached (index, 20 docs) | ~1 750 · 16 ms | 298 · 61 ms |
| insert | ~2 300 · 8 ms | 427 · 141 ms |
| increment, spread | ~1 790 · 9 ms | 337 · 220 ms |
| increment, one doc | ~230, OCC failures | 129, OCC failures |
| action (runQuery + runMutation) | ~880 · 19 ms | 139 · 1.3 s |
| mix 90/10 | ~1 600 · 16 ms | 299 · 290 ms |
| fan-out 10 000 subscribers | OOM at 6.7 GB (raw profile) | — |

These are END-TO-END (HTTP + V8 + engine + storage). The microbenchmarks below measure bunvex's engine
core IN-PROCESS; they show the headroom, not the final number. The final comparison is the same
`convex-bench` run against bunvex's HTTP server.

## 5. Measurement plan (v0 microbenchmarks, `bench/`)

| # | what | pass (Mac and VPS) |
|---|---|---|
| M1 | C1 encode + compare throughput | ≥ 1 M encodes/s per core |
| M2 | C2 durable commits: 1 document + 2 index entries per commit, group commit, fsync on | S-A and S-B ≥ 5× Convex's end-to-end insert on the same box |
| M3 | C7 snapshot range read, `take(20)` over 100 k docs | ≥ 10× Convex's uncached query |
| M4 | C4 OCC validation cost per commit vs write-log size, and the false-conflict rate on 1 000 distinct keys (Convex and minivex's weak spot) | < 5 µs per commit; ~0 false conflicts |
| M5 | C3+C4+C6 end-to-end in-process: the `convex-bench` mutations and queries without HTTP | ≥ 5× Convex |
| M6 | memory per 100 k documents / per subscription | report |

## 6. Risks

- **R1 — one committer in one JS thread** caps writes. Group commit and doing only validation + ts
  assignment inside the committer keep it short; measured in M2/M5.
- **R2 — GC pauses** with large in-memory structures (S-B). Measured as p99, not only throughput.
- **R3 — durability semantics** of `bun:sqlite` WAL (`synchronous=FULL` vs `NORMAL`) and of a raw
  append log (`fsync` / `fdatasync` in Bun). macOS `fsync` is not durable — VPS numbers are the ones
  that count.
- **R4 — memory** (S-B) bounds dataset size per node.
- **R5 — single node.** Like Convex self-hosted. Horizontal scaling of reads (replicas fed by the commit
  log) is a later spec.

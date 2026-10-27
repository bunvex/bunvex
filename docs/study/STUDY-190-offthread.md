# STUDY-190 — Work off the one JS thread
<!-- index: Work off the one JS thread (STUDY-184 Q2): how Convex's backend spreads over cores, fresh per-request profiles of bench/server.ts (Mac, Linux VPS, DigitalOcean), the cost of a message between Bun threads, five candidates prototyped in bench/offthread/ (SQLite commits on a writer thread, SQLite readers, value work, HTTP front threads, execution on workers) and a ranked plan of PRs | decided (owner, 2026-10-26): every §8 recommendation; DV-573, DV-574; PR 1 in #878 -->

- **Status:** decided (owner, 2026-10-26): every §8 recommendation; DV-573, DV-574. PR 1 (the SQLite writer thread) is #878:
  on DO `c-4` (sfo2, Xeon 8168), insert +46 % and increment1000 +21 %, reads unchanged
  (`bench/results/cloud/2026-10-26-18-*`). PR 2a (the call boundary in the thread, with its codec; STUDY-194 §9) is
  #895, a draft: the codec costs uncached −15 % and insert −12 % on DO `c-4`, past its 3 % target (STUDY-194 Q7).
  PRs 2b–5 are not built; the prototypes are in `bench/offthread/`.
- **Convex source read:** `precompiled-2026-10-24-bb31399`. Files:
  - `crates/runtime/src/prod.rs`, `crates/common/src/knobs.rs`;
  - `crates/isolate/src/client.rs`, `crates/function_runner/src/in_process_function_runner.rs`;
  - `crates/database/src/{committer,write_batcher,write_log,subscription}.rs`;
  - `crates/sqlite/src/lib.rs`, `crates/postgres/src/connection.rs`;
  - `crates/search/src/{lib,disk_index}.rs`.
- **Related:**
  - [STUDY-184](STUDY-184-horizontal-draft.md) Q2 (owner, 2026-10-26): before any follower, take work off the single
    JS thread inside one process. Its §5.1, §5.4 and §5.5 are where this study starts.
  - [STUDY-24](STUDY-24-horizontal-scaling.md) §4.7 and §5 item 5: "SQLite writes off the JS thread".
  - STUDY-24 A2 (decided, DV-115): execution away from the committer with Convex's begin-timestamp protocol.
  - [STUDY-168](STUDY-168-process-sandbox.md) and [STUDY-171](STUDY-171-function-sandbox-seam.md): the `process`
    executor (AD-44), whose bridge answers every `ctx` operation on the host.
  - STUDY-184 §5.6 (draft PR #876, another session): the sync session re-checks every query on each commit, the
    subscription ceiling today (1 633 commits/s at 10 000 subscriptions, 6 943 when only invalidated queries rerun).
    Its fix (proposed as STUDY-184 Q4) is on-thread work in `packages/server` sync; this study neither counts it as
    off-thread work nor prototypes anything on the subscription path.
  - Raw results: [`bench/offthread/results/`](../../bench/offthread/results/) (`mac/`, `vps/`, `do/`).

## 0. In short

1. **Convex uses every core of its machine with one process** (§1): a tokio runtime with one worker thread per
   core, one OS thread per V8 isolate, and a committer that hands each write batch to its own task, up to 16 in
   flight. Nothing in an app's contract depends on which thread does what.
2. **bunvex's main thread is full in every scenario** (§3). Where its time goes, per request, on a dedicated Linux
   box (DigitalOcean `c-4`):

   | scenario (SQLite) | µs/request | biggest part |
   |---|---:|---|
   | cached query | 126 | Bun's HTTP serving and the server's routing (62 %), the rest of the request path (29 %) |
   | uncached query | 542 | value checks and encoding (39 %), the engine's transaction (26 %) |
   | insert | 436 | the store's synchronous writes, mostly the commit's fsync (33 %) |
   | increment (1 000 keys) | 792 | the engine (31 %), the store's reads (25 %) and writes (17 %) |

   The app's own function code is under 1 % everywhere, as STUDY-184 §5.1 found.
3. **A message between Bun threads is cheap only as a string** (§4.0): about 2 µs of main-thread CPU on Linux for
   a string of a few KiB, 62 µs for 20 documents as objects (structured clone).
4. **Measured gains of the prototypes** on DigitalOcean (64 VUs, median of 2 runs, against the same box's
   baseline):

   | candidate | what moved | gain |
   |---|---|---|
   | (a) SQLite writer thread | a group's rows, commit and fsync | insert **+36 %**, increment +20 %; mixed reads+writes +20 % on the 1-vCPU VPS, +4 % on DO |
   | (b) SQLite reader threads, with (a) | index scans and gets | increment +17 % over (a); uncached reads flat |
   | (c) value work in a thread | checks, sizes, encoding | not built: the clone of the values costs half the work it moves (§4.3) |
   | (d) HTTP front thread | Bun's HTTP parsing and writes | cached **+18 %** with one thread; 2–3 threads worse (§4.4) |
   | (e) execution on workers | the function and its reads, decoding and encoding | not built; the profile bounds the main thread's gain at about 2.6× for uncached reads (§4.5) |

5. **The plan** (§5): first (a), on its own. Then (e) in Convex's funrun shape (A2), each worker reading the store
   through its own connection, which subsumes (b) and (c). (d) comes last, once the main thread no longer runs
   functions. None of these changes what an app observes beyond latency and capacity (§2). Q3 and Q4 ask about
   module state and the number of workers.

## 1. How Convex does it

### 1.1 One process, every core

- **The runtime.** `ProdRuntime::init_tokio` builds a multi-thread tokio runtime (`crates/runtime/src/prod.rs:150-163`).
  Its worker threads are `RUNTIME_WORKER_THREADS`, "0 -> default (number of cores)" (`knobs.rs:58-60`). HTTP
  (axum on hyper, `local_backend/src/main.rs:182`), every sync WebSocket's `SyncWorker` task, the committer and the
  background workers are tasks on this pool, so any of them runs on any core.
- **Dedicated threads.** `spawn_thread` starts an OS thread that blocks on the same runtime handle
  (`prod.rs:104-133, 230-239`). Each V8 isolate gets one.

### 1.2 Functions: a pool of isolate threads

- `SharedIsolateScheduler` keeps one worker thread per isolate and sends it requests over a channel of size 1
  (`crates/isolate/src/client.rs:1150-1190`). It creates threads lazily, up to `max_workers`, before reusing the
  least recently used one (`client.rs:1447-1470`). Each is named `isolate`.
- **Knobs:** `MAX_ISOLATE_WORKERS` (300, "Maximum number of isolate worker threads in a function runner process",
  `knobs.rs:1018-1020`), `FUNRUN_ISOLATE_ACTIVE_THREADS` ("maximum number of CPU cores that can be used
  simultaneously by the isolates. Zero means no limit", `knobs.rs:1490-1493`), `V8_THREADS` (V8's own platform
  threads, 0 = cores, `knobs.rs:1037-1038`, used at `client.rs:503`). The in-process runner gives one client the
  whole pool (`in_process_function_runner.rs:144-146`).
- **What actually bounds concurrency** is `APPLICATION_MAX_CONCURRENT_QUERIES` / `_MUTATIONS` (16), `_V8_ACTIONS`
  (64) per backend (STUDY-184 §1.1). bunvex already has these, with Convex's names
  (`packages/server/src/action-permits.ts`).
- A function's `ctx.db` calls are ops answered in the isolate's own task, against the transaction it carries; the
  reads go to the persistence reader from there. So **a function, its reads, the decoding of what it read and the
  serialization of its result all run on its isolate's thread**, not on a shared one.

### 1.3 The committer: validation on the committer task, writes on other tasks

- One committer task fed by a channel (`committer.rs:342`). Pre-validation of a batch runs in a spawned task under
  `block_in_place` (`committer.rs:1183-1195`).
- Each accepted commit's write is spawned "so it doesn't block the committer thread" (`committer.rs:1254-1275`) and
  goes through the `WriteBatcher` (`write_batcher.rs:162-204`):
  - writes are combined only once `COMMITTER_BATCH_WRITE_THRESHOLD` (3) are in flight, waiting at most
    `COMMITTER_MAX_COMMIT_DELAY` (1 ms) for more;
  - up to `COMMITTER_MAX_CONCURRENT_WRITE_BATCHES` (16) batches are written at once (`knobs.rs:420-441`);
  - results come back through a `FuturesOrdered` (`committer.rs:285`), so commits are published in timestamp
    order whatever order the writes finish in.
- The write log and the subscription manager do their CPU work under `block_in_place` too
  (`write_log.rs:699-889`, `subscription.rs:494`), which tells tokio to move other tasks off that thread.

### 1.4 Persistence and search

- **SQLite** is one connection behind a `parking_lot::Mutex` (`crates/sqlite/src/lib.rs:83-106`); `write` runs the
  statements synchronously inside its async function (`lib.rs:291-330`). Reads and writes are serialized on that
  connection, but they block only the tokio worker that runs them, never the HTTP of other requests.
- **Postgres** is a pool of up to `POSTGRES_MAX_CONNECTIONS` (128) connections (`postgres/src/connection.rs:474-486`,
  `knobs.rs:1298-1299`), all asynchronous.
- **Search** queries its in-memory index under `block_in_place` (`crates/search/src/lib.rs:491-650`) and opens disk
  indexes with `spawn_blocking` (`disk_index.rs:75`).

## 2. What an app can observe

Only latency and capacity. Every candidate below keeps:

- **The commit order and its durability.** A commit is acknowledged only after its group is durable, and commits are
  published in timestamp order (Convex: §1.3; bunvex: one flush at a time, `packages/core/src/committer.ts:665-680`).
- **Snapshot reads.** A query reads at one timestamp. bunvex's store keeps every version keyed by timestamp, so any
  connection that sees every commit up to that timestamp gives the same answer. A commit is published only after
  it is committed, so a connection that starts reading after the publication sees it (SQLite WAL).
- **OCC.** Validation stays in the one committer, against the write log, on the main thread.
- **Subscriptions.** The read sets and their invalidation stay on the main thread.

So **none of (a)–(d) is a divergence**. (e) has one observable edge, module-level state (Q3). A change of timing
alone (a request answered sooner or later) is what Convex's own threads produce too.

## 3. How bunvex does it today

- One JavaScript thread does the HTTP, the request path, the engine (transactions, caches, read sets, the
  committer), every function and, on SQLite, the store's synchronous statements. On Postgres the store's I/O is
  asynchronous, but the driver's parsing and writes are on the same thread.
- The `process` executor (STUDY-171, AD-44) runs a function in a child process and answers every `ctx` operation
  on the host's transaction: the reads, their decoding and the result's checks stay on the host.

### 3.1 Profiles

`bench/offthread/profile.ts` starts `bench/server.ts` with `bun --cpu-prof`, waits until its start-up work is done
(the table summaries are restored after it listens, about 1 s of the thread on the seeded store), runs one
`bench/load/k6.js` scenario, and puts every sample of the main thread in a bucket by its stack
(`bench/offthread/buckets.ts`; `stacks.ts` lists the stacks under one function).

- **µs/request** is the bucket's share of the thread's busy time divided by the requests served. The busy time
  caps each gap between samples at twice the interval, since the sampler records nothing while the thread waits
  in its event loop. Rates in profiled runs are 10–40 % lower than unprofiled ones; the shares are what they are
  for.
- **Groups:**
  - *HTTP serving*: Bun's native serving with no JS caller, plus the server's `fetch` handler, `Response` and
    `requestIP`. On Postgres it also holds the driver's native socket reads and writes;
  - *request path*: function dispatch, the function log, metrics, CORS, body parsing and result formatting;
  - *engine*: transactions, the query cache and read sets, schema and shapes, the committer;
  - *values*: `packages/values` (lone-surrogate checks, sizes, `toJsonValue`/`fromJsonValue`);
  - *store read* / *store write*: anything under a persistence driver.
- **Setup:** Bun 1.4.4, k6 2.3.0, the seeded store of `bench/seed.ts`, 20 s per run.
  - **DigitalOcean:** `c-4` server and load boxes in `sfo2`, k6 on the load box, 64 VUs, Postgres 17 in Docker on
    the server box. The cleanest numbers: dedicated vCPUs, client elsewhere.
  - **VPS:** the owner's 2-vCPU EPYC, server on CPU 0 and k6 on CPU 1 (`taskset`), 32 VUs, Postgres in Docker on
    CPU 1. The shared disk's fsync is slow and variable.
  - **Mac:** M1 Pro, 8 cores shared with other work (load average 3–12), 32 VUs.

Per request, µs (and share of the main thread). DigitalOcean
([profiles.md](../../bench/offthread/results/do/profiles.md)):

| scenario | req/s | total | HTTP serving | request path | engine | values | store read | store write |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SQLite cached | 6 808 | 126 | 78 (62 %) | 36 (29 %) | 10 (8 %) | 3 | 0 | 0 |
| SQLite uncached | 1 739 | 542 | 93 (17 %) | 83 (15 %) | 142 (26 %) | 212 (39 %) | 11 (2 %) | 0 |
| SQLite insert | 1 812 | 436 | 63 (15 %) | 65 (15 %) | 127 (29 %) | 36 (8 %) | 0 | 144 (33 %) |
| SQLite increment | 1 101 | 792 | 79 (10 %) | 79 (10 %) | 244 (31 %) | 58 (7 %) | 196 (25 %) | 134 (17 %) |
| Postgres cached | 6 258 | 141 | 83 (59 %) | 42 (30 %) | 10 (7 %) | 3 | 0 | 2 |
| Postgres uncached | 1 401 | 648 | 163 (25 %) | 89 (14 %) | 154 (24 %) | 214 (33 %) | 22 (3 %) | 6 |
| Postgres insert | 1 994 | 357 | 97 (27 %) | 66 (19 %) | 129 (36 %) | 37 (10 %) | 15 (4 %) | 13 (4 %) |
| Postgres increment | 871 | 941 | 310 (33 %) | 94 (10 %) | 369 (39 %) | 80 (9 %) | 71 (8 %) | 15 (2 %) |

VPS ([profiles.md](../../bench/offthread/results/vps/profiles.md)) and Mac
([profiles.md](../../bench/offthread/results/mac/profiles.md)), the same columns:

| scenario | VPS total | HTTP | req. path | engine | values | read | write | Mac total | HTTP | req. path | engine | values | read | write |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| SQLite cached | 101 | 63 % | 29 % | 6 % | 2 % | 0 | 0 | 30 | 64 % | 27 % | 7 % | 2 % | 0 | 0 |
| SQLite uncached | 546 | 23 % | 18 % | 28 % | 28 % | 4 % | 0 | 144 | 13 % | 12 % | 26 % | 47 % | 3 % | 0 |
| SQLite insert | 515 | 14 % | 15 % | 26 % | 7 % | 0 | 38 % | 212 | 5 % | 6 % | 14 % | 4 % | 0 | 70 % |
| SQLite increment | 881 | 9 % | 11 % | 34 % | 8 % | 18 % | 20 % | 272 | 3 % | 4 % | 14 % | 3 % | 33 % | 43 % |
| Postgres cached | 97 | 63 % | 28 % | 6 % | 2 % | 0 | 0 | 30 | 64 % | 27 % | 7 % | 2 % | 0 | 0 |
| Postgres uncached | 779 | 36 % | 16 % | 21 % | 23 % | 5 % | 0 | 145 | 17 % | 12 % | 23 % | 47 % | 1 % | 0 |
| Postgres insert | 320 | 33 % | 20 % | 32 % | 10 % | 3 % | 2 % | 109 | 26 % | 17 % | 37 % | 12 % | 3 % | 5 % |
| Postgres increment | 969 | 48 % | 11 % | 26 % | 6 % | 7 % | 1 % | 223 | 29 % | 12 % | 40 % | 9 % | 7 % | 3 % |

What the stacks say (`stacks.ts`), on every machine:

- **Cached.** The `fetch` handler, `Response`, `requestIP`, the client-version verdict, then the function log's
  `append`/`nextUp`, dispatch (`registryKey`, `loggedRun`), metrics and CORS. The cache lookup itself is 1–2 %.
- **Uncached.** Of the values: `valueHasLoneSurrogate` and `measureRawValue` over the result in `checkReturns`
  (`functions.ts:1829`), `rawValueSize` in `countEgress` (`tx.ts:577`), `toJsonValue` in `stringifyValue`, and
  `fromJsonValue` of each document read (`storeRangeOf`, `tx.ts:1639`). Of the engine: `JSON.parse` in
  `decodeDoc` (`tx.ts:2923`). The store's own reads are small: the index cache (STUDY-136) answers most of them.
- **SQLite insert.** `run` under `flush` (`sqlite.ts:349`): the `commit` statement and its fsync, 86 % of the
  `run` samples on the Mac; the row inserts are the rest.
- **Increment.** The counters' index scan (`sqlite.ts:424`) is 20–30 % of the thread: each increment adds a version
  of its key's index entry, and the scan's `group by key` reads all of them.
- **Write batches** (the committer's `onBatch`): SQLite on the VPS takes 4–6 ms per flush of about 16 commits; DO
  about 3.4 ms. The disk, not the CPU, bounds SQLite inserts on the VPS.
- **Main-thread CPU** (from `/proc/<pid>/task`): 0.94–0.97 of a core for every read scenario on DO; 0.71–0.83 for
  writes, where the rest is the thread blocked in fsync or waiting on Postgres. The other threads (JIT, GC helpers)
  take 0.1–0.25.

## 4. Candidates

### 4.0 What a message between threads costs

`bench/offthread/messaging.ts`: a Worker that echoes. "Pipelined" keeps 64 in flight, so it is the cost per
message when the main thread is the bottleneck; on Linux the main thread's own CPU is read from `/proc`.

| payload | DO round trip (µs) | DO main-thread CPU per message (µs) | Mac per message (µs) |
|---|---:|---:|---:|
| string, 100 B | 23.6 | 2.4 | 0.5 |
| string, 3.4 KiB (a 20-document result) | 19.9 | 2.0 | 0.7 |
| 20 documents as objects (structured clone) | 141 | 62 | 19 |
| 20 documents as bytes (transferred `ArrayBuffer`) | 35 | 6.2 | 2.1 |
| `SharedArrayBuffer` + `Atomics.wait`, both threads hot | 1.2 | — | 0.2 |

- **Strings cross almost for free; objects do not.** A thread boundary is worth it only where what crosses is text
  (a request, a result, stored JSON) and what stays behind is the work on it.
- A round trip with one message in flight is 20–24 µs on Linux: the latency a single request pays per hop.

### 4.1 (a) SQLite commit writes and fsync on a writer thread

- **What moves:** `apply`'s inserts and `flush`'s `commit` (with its fsync), for every write of the store, onto one
  Worker with its own connection. The main connection only reads.
- **Prototype:** `bench/offthread/sqlite-offthread.ts` overrides the driver's `apply`/`flush`/`writeIndexEntries`
  from outside: `apply` collects a group, `flush` sends it to the writer
  (`sqlite-offthread-worker.ts`, which uses the product's driver and statements) and resolves when it is committed.
  The committer is unchanged: it awaits one flush at a time and publishes after it.
- **Cost per request:** one message per write batch (about 15–45 commits), not per request: under 1 µs a commit.
- **Measured** (results in `do/writer.md`, `vps/wb*.md`, `vps/mix*.md`, `mac/writer.md`):

  | box | scenario | baseline | writer thread | change |
  |---|---|---:|---:|---:|
  | DO | insert | 2 001 | 2 728 | **+36 %** |
  | DO | increment | 1 191 | 1 427 | +20 % |
  | DO | mix (9 reads : 1 insert) | 1 759 | 1 824 | +4 % |
  | VPS, one vCPU | insert | 1 652 | 1 764 | +7 %, within the noise (runs 1 212–1 892) |
  | VPS, one vCPU | mix | 1 568 | 1 875 | **+20 %** |
  | Mac | insert | 4 495 | 5 704 | +27 % |
  | Mac | increment | 3 570 | 4 491 | +26 % |

  - On DO, the main thread spends what it saved on more requests until the writer (one flush of 40–50 commits every
    11–15 ms) bounds the rate.
  - On the VPS, the disk bounds inserts either way (4–11 ms per flush); the gain is that **reads no longer wait
    behind a fsync** (mix +20 %). With the server pinned to one vCPU, the writer shares that vCPU, and still helps.
- **Risks, and what the PR must do:**
  - Every write must go through the writer's connection (prunes, globals, `setReadOnly`, backfills), or two
    connections contend for SQLite's write lock (5 s busy timeout).
  - The lock (`ProcessLock`) stays with the main thread; only the process writes, so the lease is unchanged.
  - Failures: a write that fails rejects the flush, which the committer already treats as a failed flush
    (fail-stop or retry, STUDY-25 L4). A crash of the Worker must reject every pending flush.
  - Durability is unchanged: the same `synchronous = full` commit, before the acknowledgement.
  - Today the main connection sees a group's rows before its commit (`readDocumentLog` bounds them out). With the
    writer it never does, which removes that case.

### 4.2 (b) SQLite reads on a reader pool

- **What moves:** `scan`, `get` and `getVersions`, each on one of N Workers with its own read connection (WAL lets
  readers run beside the writer). The prototype is the same class with `OFFTHREAD_READERS=N`.
- **Cost:** a round trip per store read, and the results come back as objects (ids, timestamps, JSON text):
  structured clone of small arrays.
- **Measured on DO, with (a) and 2 readers:** increment 1 675 (+17 % over (a) alone, +41 % over the baseline);
  uncached 1 890, flat (−2 %). On the Mac: uncached +15 %, but the main thread then idled part of the time waiting
  for answers.
- **Why so little:** reads are 2–3 % of an uncached query's main thread (the index cache answers most), and what
  they read must still be decoded on the main thread. The gain on increment comes from one expensive scan (§3.1).
- **Risks:** snapshot visibility, as §2 says, holds because publication follows the commit. Retention pruning
  deletes only versions no reader can need (`ts <= X` within retention), as today.
- **Verdict:** not worth a PR of its own. Each execution worker in (e) needs its own read connection anyway.

### 4.3 (c) Value checks, encoding and JSON in workers

`bench/offthread/values-split.ts`, one uncached result (20 documents):

| | DO (µs) | Mac (µs) |
|---|---:|---:|
| decode: `JSON.parse` + `fromJsonValue` of the 20 stored documents | 23 | 10 |
| result: surrogate walk, two sizes, `toJsonValue`, `JSON.stringify` | 79 | 30 |
| hand-off of the 20 values as objects, both ways | 53 | 18 |
| hand-off of 20 stored texts in and one result text out (strings) | 8 | 2.5 |

- **Moving the value work alone** means cloning the values the function returned: 53 µs to save 79, plus a round
  trip of latency per request. Not worth it.
- **Moving it with the reads that produce the values** (the worker reads the stored text, runs the function and
  sends back the result text) costs 8 µs and moves the whole 102 µs. That is (e).
- **On-thread, separately:** three walks over every result (`valueHasLoneSurrogate`, `measureRawValue`,
  `rawValueSize`) could be one. That is a plain optimization, outside this study.

### 4.4 (d) HTTP parsing and the cached path on front threads

- **What moves:** Bun's HTTP parsing, the public `Request`/`Response` objects and the socket writes, onto front
  Workers, each a `Bun.serve` with `reusePort` on the public port (Linux spreads connections; macOS gives one thread
  all of them, STUDY-184 §5.3). The main thread runs the server's real handler on a copy of the request
  (`bench/offthread/server.ts`, `front-worker.ts`).
- **Cost:** the wire matters. Header arrays as objects cost the main thread 31 µs a request on DO (`postMessage`,
  21 % of its samples, [clonewire](../../bench/offthread/results/do/clonewire/)). One string each way costs about 5.
  The main thread still builds a `Request` and reads a `Response`.
- **Measured** (one-string wire, `do/front*.md`):

  | front threads | DO cached | p99 ms | DO uncached | p99 ms | Mac cached |
  |---|---:|---:|---:|---:|---:|
  | none (baseline) | 7 835 | 18 | 1 920 | 63 | 26 830 |
  | 1 | 9 274 (**+18 %**) | 17 | 1 843 | 53 | 37 868 (+41 %) |
  | 2 | 8 043 | 136 | 1 855 | 604 | — |
  | 3 | 7 491 | 159 | 1 973 | 1 049 | — |

- **Why it stops at one:** the main thread stays at 0.95–0.97 of a core, now on the handler (`fetch` 11 %,
  `Response` 6 %), the request path and the messages. More front threads only accept more requests than it can
  serve: they queue in its message port, and p99 grows tenfold.
- **A failure it found:** with 2 front threads on Postgres, the main thread's queue delayed the lease renewal past
  its 1 250 ms timeout, and the server stopped with `LeaseLostError` (`do/clonewire/front2-postgres.log`). Front
  threads remove the natural backpressure of one accept loop: the request limit (STUDY-110) and the timeouts must be
  enforced on the front threads, before a request crosses.
- **What would make it pay:** the stateless request path on the front threads too (CORS, the client-version check,
  body parsing, the request limit, result formatting), so that only the engine call crosses, as a string. And
  WebSockets need a design of their own: the sync sessions hold subscriptions, which live on the main thread.
- **Verdict:** last. Its ceiling rises only once the main thread no longer runs functions, (e).

### 4.5 (e) Function execution on workers

- **Two shapes exist:**
  - **STUDY-171's `process` executor** moves the function's JavaScript and keeps every `ctx` operation on the host,
    as Convex's ops bridge. Its cost per operation is 40–280 µs and per call 55–140 µs (STUDY-171 §8.10). It moves
    the part of the profile that is under 1 % and adds a hop per read. It is a sandbox (AD-44), not a way to scale.
  - **Convex's funrun shape (A2, decided):** a worker runs the function against the store at the timestamp the
    main thread hands it, with its own reads, and returns the result with its read set (and, for a mutation, its
    writes). The main thread keeps the query cache, the subscriptions and the committer. **On threads, this is the
    same protocol as A2 across processes**, at a hop of a few µs instead of a socket's.
- **What moves, for an uncached query** (DO profile): the values (212 µs), most of the engine's transaction and
  schema work (about 120 µs) and the store's reads (11 µs). The main thread keeps HTTP serving, the request path,
  the cache lookup and the read-set registration: about 200 µs, plus about 8 µs of messages (§4.3).
  - **Main-thread ceiling:** 542 / 208 ≈ **2.6×**.
  - **Machine ceiling:** the work is still there, now on other cores. On the `c-4` (2 physical cores, 4
    hyperthreads), STUDY-184 §5.5's independent processes reached 1.78× with 2 and 2.39× with 4 for uncached reads:
    that is the most threads can do there too.
- **For mutations,** the same, with the writes returned: the main thread keeps validation and the commit, (a) takes
  the store's writes. Insert's values and transaction work (about 160 µs of 436) would move.
- **Risks:**
  - **Snapshots and OCC:** a worker reads at the timestamp the main thread gives it, never newer; a mutation commits
    through the same committer and its OCC check against the write log since that timestamp (STUDY-24 A2: the
    time-based window is already Convex's).
  - **Read sets** cross as key intervals (bytes): each index's intervals as one transferred buffer, not objects.
  - **Caches:** the index cache (STUDY-136) is per thread then. A worker's cache misses go to its own connection.
  - **Module state (Q3):** each worker evaluates the app's modules itself, so a module-level variable is shared
    by the calls that land on that worker, not by every call of the code version (DV-165).
  - **Nested calls** (`ctx.runQuery` inside a mutation) run on the caller's worker, in its transaction.
  - **Pushes:** each worker loads a new code version as the main thread does today (DV-164).
  - **Memory:** a Bun Worker that has loaded the server's modules adds about 2 MiB of RSS before it runs anything.
- **Not prototyped here:** the engine's transaction would have to run in a Worker against its own store
  connection, which is the PR itself. The estimate above is from the profile and the measured hand-off.

### 4.6 What was considered and left out

- **A separate HTTP process** (instead of threads) behind `reusePort`: the same hand-off over a socket, at 20–80 µs
  (STUDY-168 §4.3). Threads first.
- **`SharedArrayBuffer` rings** instead of `postMessage`: 1.2 µs a hop when both threads are hot, but a waiting
  thread must spin or block. Worth trying inside (e) only if the 2 µs of a string message shows in its profile.
- **The subscription path:** no scenario here loads subscriptions. STUDY-184 §5.6 measures it, and its fix is
  doing less work on the main thread, not moving it.
- **Pipelined write batches** (Convex's 16 in flight, §1.3): on Postgres, inserts leave the main thread a third
  idle, waiting on one flush at a time. That matches Convex and is not about threads; it belongs to the committer's
  own study.

## 5. Plan

| # | PR | Expected gain (from §4) | The measurement that proves it |
|---|---|---|---|
| 1 | **SQLite writer thread** (#878: insert +46 %, increment1000 +21 % on DO `c-4`): every write of the SQLite store on one Worker with its own connection; the main connection only reads; Worker failure fails the pending flushes | SQLite insert +30–36 %, increment +20 % (DO); reads beside writes +20 % on a 1-vCPU box | `bench/offthread/profile.ts` insert, increment1000 and mix on DO `c-4` and on the VPS, against the baseline of the same box; PERSIST-01 conformance and the crash tests on SQLite unchanged |
| 2 | **Query workers (A2 on threads, reads)**: queries run on a pool of Workers at the main thread's timestamp, each with its own store connection (SQLite reader, or its own Postgres pool), returning the result text and read set; the cache and subscriptions stay on the main thread | uncached reads up to the machine's ceiling: about 1.6–2× on DO `c-4`; the main thread's ceiling is 2.6× | uncached on DO `c-4` and the VPS; a vm-vs-worker differential test of every query answer, error and read set |
| 3 | **Mutation workers (A2 on threads, writes)**: mutations the same way, their writes and reads committed by the main thread's committer | insert and increment past what PR 1 gives, until the committer or the store bounds them | insert, increment1000 and increment1 (OCC conflicts) on DO; OCC and serializability tests |
| 4 | **Action and HTTP action workers**, as PR 2 | proportional to the action's own work | the `action` scenario |
| 5 | **HTTP front threads** with the stateless request path and the request limit on them | cached +18 % measured with HTTP alone; more once PR 2–4 leave the main thread only the engine | cached on DO; the lease renewal under saturation (§4.4's failure as a test) |

PR 2–4 need STUDY-24 A2's protocol written down first (its own study): it is the same one a follower process will
use, so it is built once, with threads as its first transport.

## 6. Tests

Each PR keeps PERSIST-01 conformance and the existing suites green, and adds:
- PR 1: a flush that fails in the writer; the Worker dying with flushes pending; a write outside a group (prune,
  global) under load; a sabotage that acknowledges before the writer's commit, caught by the crash test.
- PR 2–4: the differential test against the in-thread executor (answers, errors, logs, read sets), snapshot
  isolation across a concurrent commit, and pushes during load.
- PR 5: backpressure (the request limit's 429 under overload) and a saturated main thread that still renews its
  lease.

## 7. Divergences

None is proposed for (a)–(d). For (e), two, asked as Q3 and Q4; recorded in `divergences.md` (owner, 2026-10-26).

| # | Divergence | Why | Decision |
|---|---|---|---|
| Q3 → DV-573 | Module-level state is per code version **and per worker thread** (was: per code version, DV-165); Convex keeps it per request | a Worker cannot share a JS heap | owner, 2026-10-26 |
| Q4 → DV-574 | `MAX_ISOLATE_WORKERS` defaults to the number of cores, Workers created lazily; Convex's default is 300 | a Bun Worker is a whole JS VM; 300 would cost memory for nothing on a small box | owner, 2026-10-26 |

## 7b. Additions (beyond Convex)

None proposed. Q4 asks how the worker count is set; one option would be an addition.

## 8. Owner questions

Decided (owner, 2026-10-26): every recommendation below.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | Start with PR 1, the SQLite writer thread, on its own (§4.1, §5)? | Yes. It is self-contained, changes nothing observable, and measured +36 % on inserts and +20 % for reads beside writes on a 1-vCPU box |
| Q2 | Build execution workers in Convex's funrun shape (A2 on threads: the worker reads the store itself and returns its reads and writes), not by reusing the `process` executor's ops bridge? | Yes. The bridge keeps the reads, decoding and checks on the main thread (§4.5), which is where the time goes. The `process` executor stays the sandbox (AD-44) |
| Q3 | Under execution workers, module-level state is shared by the calls that land on the same worker, not by every call of a code version (DV-165). Accept it as DV-573, or make a worker pool opt-in until decided? | Accept as DV-573. Convex gives each request a fresh context, so no app can rely on module state; DV-165 only describes bunvex's own behaviour |
| Q4 | How is the number of execution workers set? Convex's `MAX_ISOLATE_WORKERS` caps isolate threads (default 300, created lazily); its concurrency limits (16 queries, 16 mutations, 64 actions), which bunvex has, bound how many run at once | Honour `MAX_ISOLATE_WORKERS` as the cap, with Convex's name, and create Workers lazily up to the number of cores by default. The default differs from Convex's (300 Workers would cost memory for nothing on a small box): record it as DV-574 |
| Q5 | HTTP front threads (§4.4) only after PR 2–4, with the request limit enforced on them? | Yes. Before PR 2 they measured +18 % with one thread and made p99 ten times worse with more |

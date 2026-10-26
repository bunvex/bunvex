# STUDY-184 — Horizontal scaling: Convex's real shape, and what one bunvex process does with a core
<!-- index: Horizontal scaling: Convex's real shape, one bunvex process per core | decided (owner, 2026-10-26): Convex's shape, confirmed by measurement 3 (§5.6); DV-114 rewritten, DV-116/118/119 withdrawn; Q4 built (§5.7) -->

- **Status:** rewritten from scratch on 2026-10-26. The earlier draft did not read Convex's source, and its load
  measured the client rather than the server (§5.1). No product change. Decided (owner, 2026-10-26): Q1–Q5.
  Measurement 3 is in (§5.6).
- **Convex source read:** `precompiled-2026-10-24-bb31399`. Files:
  - `crates/database/src/{database,committer,subscription,transaction,retention}.rs`;
  - `crates/postgres/src/{lib,sql}.rs`, `crates/mysql/src/v5/persistence.rs`;
  - `crates/function_runner/src/{lib,server,in_process_function_runner,in_memory_indexes}.rs`;
  - `crates/application/src/{api,lib}.rs`, `crates/application/src/application_function_runner/mod.rs`;
  - `crates/sync/src/{worker,subscription_reconnect}.rs`, `crates/local_backend/src/{lib,main}.rs`,
    `crates/local_backend/src/subs/mod.rs`;
  - `crates/search/src/searcher/`, `crates/common/src/knobs.rs`;
  - `crates/backend_harness/src/provision.rs`;
  - `self-hosted/README.md`, `npm-packages/docs/docs/production/state/limits.mdx`.
- **Related:**
  - [STUDY-24](STUDY-24-horizontal-scaling.md), whose H1–H12 the owner decided (DV-113–DV-121);
  - [STUDY-171](STUDY-171-function-sandbox-seam.md) (the `process` executor, AD-44);
  - `bench/scale/`.

## 0. In short

1. **Convex never scales a deployment's writes or its subscriptions beyond one process.**
   - One backend per deployment holds the committer, the subscriptions and every background worker.
   - Convex Cloud adds stateless function runners ("funrun") that read the database directly at the timestamp the
     backend hands them.
   - It also adds a WebSocket tier ("Usher") that forwards to the backend.
   - There is no follower that applies a commit stream, in the open code or in its hints.
2. **One Convex backend process uses every core of its machine** (Rust and tokio, a pool of V8 isolates).
   - One bunvex process does its HTTP, sync, engine and store work on one JavaScript thread.
   - Measured on an 8-core Mac: one bunvex process saturates about one core while the others stay free (§5).
   - So bunvex needs more processes just to use one machine the way one Convex process does. That is a capacity
     difference an operator sees, not a semantic one.
3. **More processes do pay, when the client is not the bottleneck.** Independent processes on one 8-core machine
   gave 1.7–1.8× with 2 processes and 2.2–2.6× with 3 (§5.2). The earlier draft's "a second process does not pay"
   came from a load generator that was itself one saturated JS thread on the same small box.
4. **STUDY-24's decided design differs from Convex's shape in one place that matters:**
   - H2 and H4: followers run queries and hold subscriptions themselves, fed by a commit stream the leader pushes.
   - Convex keeps invalidation on the one backend and moves only execution and sockets.
   - Both give an app the same answers. They differ in how much machinery bunvex must build and keep correct.
   - §7 Q1 asks whether to keep H2/H4 or follow Convex's shape.
5. **Measurement 3 (§5.6) confirms Convex's shape.**
   - Matching a commit against a million subscriptions costs about 3 µs, and a STUDY-24 follower's apply under 1 µs.
   - The cost is per query update: 43–54 µs in one bunvex process once two avoidable checks are gone (22–29k
     updates/s), against Convex's 2.2 ms (1.0–1.7k updates/s from one backend on every core).
   - Those two checks in the sync session, which Convex does not make, capped one invalidation per commit at 261
     commits/s with a million subscriptions. That was a fix for either design (§7 Q4), now built (§5.7): 3 822.

## 1. How Convex does it

### 1.1 What the open-source code does

- **One committer per deployment.**
  - `Database::load` starts one `Committer` and one `SubscriptionsWorker` over one in-memory write log
    (`database.rs:1086-1094`).
  - The committer is one task fed by a channel (`committer.rs:302-350`).
  - OCC validation checks the read set against the write log and pending writes (`committer.rs:912-929, 1032-1045`).
    The log is kept 30–300 s (`WRITE_LOG_MIN/MAX_RETENTION_SECS`, `knobs.rs:875-881`).
- **The lease is the only cross-process guard.** On Postgres:
  - **Acquiring.** `UPDATE leases SET ts=$1 WHERE id=1 AND ts<$1 …` with `ts` the wall clock at start
    (`postgres/src/sql.rs:730-744`, `lib.rs:1767-1789`). The newest process wins at once, despite the comment
    "Blocks as long as there is another lease holder" (`lib.rs:1753`).
  - **Checking.** Every write transaction checks the lease (`Lease::transact`, `lib.rs:1840-1875`, `FOR SHARE`
    before COMMIT).
  - **Losing it.** The old process exits on its next write (`lease_lost_shutdown`, `local_backend/src/main.rs:144-148,
    202-207`).
  - **Not fenced:** bulk import (`lib.rs:741-745, 810-814, 874-878`).
  - **MySQL v5** does the same (`v5/persistence.rs:1536-1640`). SQLite has no lease.
- **Why the lease exists,** in its own comment (`postgres/src/lib.rs:1731-1738`): "we want to purposefully run
  multiple so that one can coordinate all writes and the others can serve stale reads, and smoothly swap between
  them during deployment and node failure."
- **A function runner reads at the backend's timestamp and returns its read set.**
  - **Running.** `FunctionRunner::run_function` takes the backend's `begin_timestamp` and returns
    `FunctionFinalTransaction { begin_timestamp, reads, writes, … }` ("Reads and writes from a UDF that executed in
    Funrun", `function_runner/src/lib.rs:86-161`).
  - **Merging.** The backend merges it with `apply_function_runner_tx`, refusing a different timestamp ("Timestamp
    mismatch", `transaction.rs:591-618`).
  - **Committing** goes through the normal OCC path.
  - **Reading.** The in-process runner reads the persistence directly at that timestamp
    (`in_process_function_runner.rs:274-279`). It then checks the snapshot was still within retention for queries
    and mutations (`server.rs:222-239`).
- **Followers are prepared for, not built.**
  - `max_repeatable_ts` is bumped "so followers can read this commit" (`committer.rs:474-479`).
    `MAX_REPEATABLE_TIMESTAMP_COMMIT_DELAY` (5 s) is "the delay between a commit and the commit being visible from
    db-verifier and other follower reads" (`knobs.rs:673-679`).
  - `FollowerRetentionManager` is defined and exported (`retention.rs:1657-1777`, `lib.rs:226`) and used nowhere in
    the open code.
  - A follower in Convex's sense reads the **database** at `max_repeatable_ts`. Nothing pushes commits to it.
- **Sync and HTTP.** One `SyncWorker` per WebSocket, inside the backend (`local_backend/src/subs/mod.rs:129-260`).
  Subscriptions go from the committer's log to the managers (`subscription.rs:259-353`) to the socket
  (`sync/src/worker.rs:1201-1203`), all in one process.
- **Search.** `InProcessSearcher` over a disk cache (`search/src/searcher/in_process.rs:136-156`). The flushers that
  build segments run in the backend.
- **Limits are per backend.**
  - Defaults: `APPLICATION_MAX_CONCURRENT_QUERIES` 16, `_MUTATIONS` 16, `_V8_ACTIONS` 64, `_NODE_ACTIONS` 64
    (`knobs.rs:1101-1157`).
  - These are "a per backend limit applied before FunctionRunner implementations", so adding funrun nodes does not
    raise them.
  - Over the limit, after waiting up to 5 s for a permit: 429 `TooManyConcurrentRequests` ("Too many concurrent
    requests. Your backend is limited to N concurrent …", `application_function_runner/mod.rs:576-593`).
- **Self-hosted docs.**
  - "Self-hosted Convex supports all the free-tier features … The cloud-hosted product is optimized for scale"
    (`self-hosted/README.md:129-132`).
  - Nothing describes running several backends for one deployment.

### 1.2 What the code only hints at for Convex Cloud

None of these services is in the repository.

- **Funrun.** `UDF_USE_FUNRUN` (default true): "Whether to run queries, mutations, HTTP actions, and v8 actions in
  Funrun (true) or InProcessFunctionRunner (false)" (`knobs.rs:1354-1356`). It is read only by `backend_harness`,
  which launches private `conductor`, `funrun` and `usher` binaries (`provision.rs:157-174, 438-482`). Funrun keeps
  an index cache across many deployments (`in_memory_indexes.rs:142-161`; `FUNRUN_*` knobs).
- **Usher.**
  - Reconnect replays are limited "per partition within one Usher process" (`subscription_reconnect.rs:18`).
  - `worker.rs:959-961` notes an RPC to the backend "since Usher can't validate auth tokens".
  - `ApplicationApi` says it routes "to the appropriate backend in the hosted version" (`api.rs:83-88`), and remote
    subscription streams exist as a type (`api.rs:558-623`).
- **Searchlight.** Search and compaction on a separate service (`searchlight_knobs.rs`, the `pb::searchlight`
  protocol).
- **Node actions.** They leave the backend for Lambda (`knobs.rs:1143-1153`).
- **Deployment classes** (S16 … D2048) raise the per-backend limits (`limits.mdx:96-146`). Nothing says they run
  more than one backend.

Not verifiable from here:
- whether funrun opens its own database connection;
- whether any Cloud process serves the "stale reads" the lease comment intends.

## 2. What an app observes

- **The same answers, at any scale.** One committer and OCC against one write log mean:
  - serializable mutations;
  - a query's results are those of one timestamp;
  - a subscription is invalidated by every commit that changes its read set.

  Funrun and Usher change none of this. They change latency and capacity.
- **Capacity limits are per deployment** (§1.1). Past them an app sees 429 `TooManyConcurrentRequests`.
- **No stale reads reach an app.** The 5 s `max_repeatable_ts` delay concerns follower reads of the database
  (db-verifier). An app's queries go through the backend's own timestamp.

## 3. How bunvex does it

- **One process holds the lease** and runs the committer, the scheduler, every sync session and every function
  (`packages/server/src/topology.ts:1-3`).
  - The lease is newest-wins on Postgres, MySQL and MongoDB, as Convex (DV-413, DV-416).
  - SQLite and memory use an OS lock (DV-14).
  - The engine fails its committer on `LeaseLostError` (`packages/core/src/engine.ts`).
- **One JavaScript thread** does the HTTP, the sync, the engine, the value checks and, on SQLite, the store's
  synchronous writes. That is the difference from Convex that matters for scaling (§5.1).
- **The `process` executor (STUDY-171, AD-44)** runs queries, mutations and actions in child processes.
  - Every `ctx` operation is still answered by the host's transaction.
  - It is bunvex's nearest thing to funrun on one machine, but the store reads stay on the host thread.
- **STUDY-24's decided plan** (owner, 2026-09-30/10-01):
  - leader plus followers (H1);
  - followers that hold sockets and run queries and subscriptions themselves (H2);
  - mutations forwarded to the leader (A1), then executed off the leader with Convex's begin-timestamp protocol
    (A2) (H3);
  - a commit stream the leader pushes, with by-timestamp catch-up (H4);
  - singletons on the leader (H6);
  - read-your-writes through a "read index" round trip (H10);
  - leader-derived time (H12).

  H5 (a TTL lease) and H11 (the log read from `indexes`) were later reversed toward Convex (DV-413, STUDY-133).
  None of it is built.

### 3.1 Where STUDY-24's plan and Convex's shape differ

| | Convex | STUDY-24 (decided) |
|---|---|---|
| Who runs queries | funrun, reading the database at the backend's timestamp | followers, at their own applied timestamp |
| Who invalidates subscriptions | the one backend's `SubscriptionsWorker` | each follower, from the pushed commit stream |
| How a node learns of commits | it does not need to: the backend owns invalidation; followers read the database at `max_repeatable_ts` | a leader push stream plus catch-up (H4) |
| Sockets | Usher, forwarding to the backend | followers, executing locally |
| Read-your-writes | automatic: everything goes through the backend's timestamp | a "read index" round trip (H10), and a wait-then-refuse for lagging nodes (H9) |
| Mutations | executed on funrun, committed on the backend (begin-timestamp protocol) | A1 forward, then A2 (the same protocol as Convex) |

A2 is already Convex's protocol. H2/H4/H9/H10 are the parts Convex does not have. They exist because a follower
must answer queries from its own state. In Convex's shape, the leader keeps that state and the other processes keep
none.

## 4. Divergences

Nothing new is recorded here. Q1 (owner, 2026-10-26) follows Convex's shape, so DV-114, DV-116, DV-118 and DV-119
were marked as under review in `divergences.md` until measurement 3. DV-113, DV-115, DV-117 and DV-121 hold in both shapes.

Measurement 3 is in (§5.6). Decided (owner, 2026-10-26, Q5), and recorded in `divergences.md`:

| DV | Today (STUDY-24) | Proposal | Why |
|---|---|---|---|
| DV-114 | Followers hold WebSockets and serve queries and subscriptions themselves | **Rewrite:** other nodes hold WebSockets and forward them to the leader, and run queries at the leader's ts (A2); the leader keeps every subscription and its invalidation (Convex Cloud's Usher and funrun) | §5.6: the leader's subscription work stays above one Convex backend's capacity |
| DV-116 | The leader pushes a commit stream; followers catch up by ts | **Withdraw.** No node keeps state from commits: execution reads the store at the leader's ts | Nothing consumes a stream in Convex's shape |
| DV-118 | A lagging node waits briefly, then refuses `Connect` | **Withdraw.** The leader's sync session answers `Connect`, as Convex's does at once | No node serves from its own, possibly lagging, state |
| DV-119 | Follower reads use a "read index" round trip to the leader | **Withdraw.** Every read runs at a ts the leader hands out, so read-your-writes is automatic, as in Convex | No follower snapshot to bring up to date |

## 5. Measurements, 2026-10-26

- **Machine:** an Apple M1 Pro, 8 cores and 16 GB, shared with other work. The load average was 4–17 during the
  runs, so read the ratios, not the absolute numbers.
- **Setup:**
  - Bun 1.4.4;
  - `bench/server.ts` on SQLite with durable writes, seeded by `bench/seed.ts` (100 000 items, 1 000 counters);
  - k6 at 32 VUs for 10 s, scenarios from `bench/load/k6.js`;
  - no errors in any run counted below.

### 5.1 One process: one core

The server's CPU time over the 10 s run, and a profile (`bun --cpu-prof-md`):

| scenario | req/s | server CPU | where the main thread went (self time) |
|---|---:|---:|---|
| cached query | 24 400–31 000 | 1.02 cores | Bun's HTTP serving and `Response` (about half), the server's request path: CORS, function log, metrics (28 %) |
| uncached query | 6 700–8 900 | 1.1–1.3 | value checks and encoding (`valueHasLoneSurrogate`, `byteLength`, JSON) and the store's reads |
| insert | 4 600–5 000 | 0.95–1.0 | SQLite's synchronous statement `run` (51 %), on the JS thread |
| increment (1 000 keys) | 3 600 | 1.1 | the request path and the store |

- The bench functions' own JavaScript is not visible in any profile's top entries. Moving function execution to
  other processes (funrun's shape, or the `process` executor) would not raise these numbers: the thread is busy with
  everything around the function.
- With Postgres the store's work is asynchronous I/O, so the insert profile would differ. Not measured here.
- The first draft's load ran in a Bun process issuing requests on one thread (`bench/scale/two-read.ts`, removed).
  That client held about one core itself, so on 2 and 4 vCPU boxes it, not the server, set the ceiling. Its 8 130
  and 4 000 req/s describe that client.

### 5.2 N independent processes on one machine

`bench/scale/independent.ts`: each process has its own copy of the seeded store and its own port, and its own k6.
Nothing is shared, so this is a **ceiling**. A real follower shares one store and needs invalidation and forwarding,
so it can only do worse.

| scenario | 1 | 2 | 3 | 4 |
|---|---:|---:|---:|---:|
| cached query | 30 930 | 55 619 (1.80×) | 55 616 | 47 696 |
| uncached query | 8 628 | 14 561 (1.69×) | 22 313 (2.59×) | 23 505 (2.72×) |
| insert (separate stores) | 4 691 | 8 547 (1.82×) | 10 385 (2.21×) | 11 737 (2.50×) |

- Past 2–3 processes, each k6 also takes cores, so the machine, not bunvex, sets the ceiling. That is visible when
  cached reads fall at 4.
- The insert row writes to **separate** SQLite files. It says what the JS threads can do, not what one shared store
  can absorb.
- **Measured since:** item 1 in §5.5, item 4 in §5.4 and item 3 in §5.6. **Not measured yet, and needed before
  any follower code:**
  1. ~~the same table on a dedicated Linux box with the load generator on another machine~~ (§5.5);
  2. one shared Postgres store under N processes (the store's group commit becomes the write ceiling). Today two
     bench servers cannot share one store: the store's lease lets only the newest write (PERSIST-01 C7), so this
     needs the first piece of Convex's shape (A2) built;
  3. ~~the cost of invalidation under each design in §3.1~~ (§5.6);
  4. ~~Convex's binary under the same scenarios on the same box~~ (§5.4).

### 5.3 From the earlier draft, kept

On Linux, two processes binding one port with `reusePort` share the connections (195 / 205 of 400). On macOS one
process gets all of them (`bench/scale/reuse-port.ts`). This matches STUDY-24 §4.7. It was not re-run here.

### 5.4 bunvex and Convex, one core each, on Linux

- **Box:** the owner's test VPS, 2 vCPUs (AMD EPYC 9354P), Ubuntu 24.04, shared (about 4.5 % steal).
- **Setup:**
  - the server pinned to CPU 0 and k6 to CPU 1 (`taskset`);
  - 32 VUs, 5 s warm-up, 30 s, 3 runs, a fresh copy of the seeded store each run;
  - Bun 1.4.4, k6 2.3.0, Postgres 17.11 (in Docker on CPU 1, default durability);
  - bunvex at `8832af48`, Convex `precompiled-2026-10-24-bb31399` (its Linux release binary);
  - the same bench functions pushed to Convex with the `convex` CLI 1.46.0, importing from `convex/server`;
  - `MAX_BYTES_WRITTEN_PER_SECOND` lifted on both. Convex's concurrency limits stay at 16: at 32 VUs a request
    waits for a permit and is not refused, so its 16-VU runs give the same rates.

| scenario (req/s, median of 3) | bunvex SQLite | bunvex Postgres | Convex SQLite | Convex Postgres |
|---|---:|---:|---:|---:|
| cached query | 8 184 (k6-bound) | 7 012 (k6-bound) | 4 182 | 4 140 |
| uncached query | 2 729 | 1 755 | 185 | 186 |
| insert | 1 543 | 1 736 | 211 | 250 |
| increment (1 000 keys) | 1 073 | 487 | 162 | 202 |

- Every Convex row is server-bound (0.95–0.98 of the core; SQLite writes 0.72–0.83).
  - A no-op query at one VU costs Convex about 2.8 ms of CPU, an uncached one about 7 ms.
  - Under load its isolate threads take about 60 % of the core and tokio about 30 %: the time is in running each
    function, not in the store.
  - These are large gaps; a CPU profile of Convex (`perf`) should confirm them before any other document quotes
    them.
- **Bounds on the bunvex rows:**
  - its cached rows are bound by k6, which uses 0.93–0.94 of CPU 1;
  - its SQLite writes are bound by fsync latency (the server at 0.6–0.78 of a core; one synchronous 4 KiB write on
    this disk takes about 1.4 ms);
  - its Postgres increment shares CPU 1 between Postgres and k6 (0.86 busy).
- **SQLite durability differs:** bunvex runs WAL with group commit; Convex's file uses the rollback journal with
  `synchronous=FULL`, more fsyncs per commit. On Postgres both run on the same server with the same settings.
- **Both cores, no pinning** (k6 shares them, one run): Convex spreads, with uncached at 317 req/s on 1.84 cores
  (1.7× its pinned rate). bunvex stays on one core (2 283 req/s uncached).
- Raw k6 summaries and scripts: `~/s184` on the VPS.

### 5.5 Dedicated cores, client on another machine (`bench/cloud`)

`bench/cloud/cloud.ts` rents two DigitalOcean CPU-Optimized droplets by the hour, in one region's private network:
a server box and a load box. It runs a suite, writes `bench/results/cloud/`, and destroys them.

- **Droplets:** `c-4` for both (4 dedicated vCPUs, Intel Xeon Platinum 8168 at 2.7 GHz, hyperthreads, so about 2
  physical cores), region `sfo2`. The account allowed nothing larger.
- **Runs:** 64 VUs per server, 30 s, 3 runs, Bun 1.4.4, k6 2.3.0, Postgres 17 in Docker on the server box.
- **Code:** bunvex at `f0739b3f`.
- The "load box" column checks the client: its 4 vCPUs never pass 3.3 busy.

One process ([single](../../bench/results/cloud/2026-10-26-13-32-single-f0739b3f/summary.md)):

| scenario | SQLite req/s | p99 ms | server cores | Postgres req/s | p99 ms | server cores |
|---|---:|---:|---:|---:|---:|---:|
| cached | 6 613 | 20.6 | 0.89 | 7 473 | 18.4 | 0.91 |
| uncached | 1 881 | 63.4 | 0.98 | 1 581 | 81.7 | 0.98 |
| insert | 1 604 | 231 | 0.62 | 2 017 | 82.5 | 0.72 |
| increment (1 000 keys) | 1 076 | 298 | 0.76 | 999 | 402 | 0.97 |

N independent processes, SQLite, each on its own copy of the store
([independent](../../bench/results/cloud/2026-10-26-14-04-independent-f0739b3f/summary.md)):

| scenario | 1 | 2 | 3 | 4 |
|---|---:|---:|---:|---:|
| cached | 7 815 | 12 488 (1.60×) | 13 808 (1.77×) | 14 299 (1.83×), load box 3.3 of 4 |
| uncached | 1 891 | 3 363 (1.78×) | 4 116 (2.18×) | 4 525 (2.39×) |
| insert (separate stores) | 1 711 | 2 824 (1.65×) | 3 626 (2.12×) | 4 198 (2.45×) |

- **One process holds one core here too:** uncached runs at 0.98–1.00 of a core, and raising VUs from 32 to 256
  left the rate flat and raised p99 (an earlier sweep).
- **Past 2 processes the gain bends.** The 4 vCPUs are 2 physical cores with hyperthreads. The cached row is also
  close to the load box's limit at 3–4 processes.
- **Absolute rates are 3–4× under the M1 Pro's in §5.1** (an older x86 core and a hyperthread per vCPU). They
  compare between runs on the same droplet type, not with other machines.
- **Cost:** two `c-4` droplets cost $0.25 an hour; this section's two suites took about an hour.

### 5.6 The cost of invalidation (measurement 3)

The question: in Convex's shape one leader keeps the commit and every subscription. Is the leader's subscription
work the ceiling, before the store's writes are? STUDY-24's shape spreads subscriptions over followers, but each
follower applies every commit. Measured on bunvex as it is, plus Convex's binary for reference.

- **Machine:** the same M1 Pro (8 cores, 16 GB), shared with other sessions' work. The load average was 2–7 during
  the runs. Bun 1.4.4, bunvex at `dcbcc4ce`, Convex `precompiled-2026-10-10-72ce13c` (the differential tests' binary).
- **End to end:** `bench/s184-invalidation.ts`.
  - **Server.** A real server in its own process: `createServer` on the memory store, which writes its log with
    an fsync per group commit, in a fresh directory per cell.
  - **Clients.** N subscriptions held by real WebSocket sync sessions in 4 other processes, over loopback, with 20
    subscriptions per socket (84 at 1M, to stay under macOS's 16k ephemeral ports).
  - **Queries.** Subscription i is `subs:watch({g: i mod G, i})`: the newest document of group g, like a chat room's
    latest message. Each subscription is its own execution, so no two share a result.
  - **Writes.** A commit is `subs:bump({g, t})` over HTTP. It inserts into group g and so invalidates N/G
    subscriptions: G = N (one), 100 (1 %) or 10 (10 %). Inserts read nothing, so writers never conflict.
  - **Splaying is off** (`SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER=0`, on both backends). Convex's default would
    spread a commit that invalidates more than 200 subscriptions over count × 5 ms. That changes latency, not CPU.
  - **Isolated:** commits one at a time, each waiting until the clients received every update it caused. Server
    CPU per commit.
  - **Saturated:** 16 writers as fast as the server answers, for 10 s. Reported: commits/s, query updates the
    clients received per second, and latency from a commit's start to its update at a client. A session folds the
    commits that land while it reruns into one transition, as Convex's does, so updates per commit fall under load.
- **Micro:** `bench/s184-invalidation-micro.ts`, in one process, on the same read-sets:
  - `ReadSetIndex` matching one commit;
  - replacing one read-set after its rerun;
  - one rerun through `engine.queryTracked`;
  - a STUDY-24 follower applying one pushed commit: decoding the binary `{ts, prevTs, writes}` frame of STUDY-24
    §4.3 and appending it to its log.
- **Convex:** `packages/differential/scripts/s184-invalidation-oracle.ts` runs the same bench against Convex's
  local backend on SQLite, a fresh backend per cell, with the same functions (`packages/differential/s184-invalidation-app/`).
  Its CPU comes from `ps` and spans every core.
- **Raw results:** `bench/results/s184-invalidation/`: `bunvex.jsonl`, `prototype.jsonl` (with `prototype.diff`,
  below), `oracle.jsonl` (Convex's) and `micro.jsonl`.

**Matching is not the cost** (micro):

| N subscriptions | match, ~1 invalidated | match, 1 % | match, 10 % | replace one read-set |
|---|---:|---:|---:|---:|
| 1 000 | 0.6 µs | 0.7 µs | 6 µs | 1.5 µs |
| 10 000 | 0.9 µs | 8 µs | 49 µs | 1.9 µs |
| 100 000 | 1.3 µs | 174 µs | 1.8 ms | 3.6–4.4 µs |
| 1 000 000 | 2.9 µs | 2.8 ms | 25 ms | 5–8 µs |

- Finding the invalidated subscriptions costs about 3 µs at a million when a commit touches one of them, and about
  50–280 ns per subscription it does touch. It is proportional to the answer, as Convex's interval map.
- A follower's apply costs **0.45 µs** per commit (a 118-byte frame). One rerun through the engine costs 7.7 µs.

**End to end, bunvex today** (one server process):

| N | invalidated per commit | isolated CPU per commit | saturated commits/s | updates pushed/s | update p50 / p99 |
|---|---:|---:|---:|---:|---:|
| 0 | 0 | 0.24 ms | 10 917 | — | — |
| 1 000 | 1 / 10 / 100 | 0.93 / 2.6 / 9.4 ms | 3 731 / 1 214 / 356 | 3 707 / 11 352 / 21 382 | 4 / 15 / 53 ms ; 12 / 22 / 70 |
| 10 000 | 1 / 100 / 1 000 | 1.1 / 16 / 97 ms | 1 633 / 119 / 30 | 1 630 / 11 171 / 18 965 | 10 / 153 / 612 ms ; 20 / 193 / 804 |
| 100 000 | 1 / 1 000 / 10 000 | 1.1 / 169 / 1 270 ms | 686 / 10 / 3 | 684 / 9 803 / 17 430 | 24 / 1 669 / 6 440 ms ; 49 / 1 984 / 8 663 |
| 1 000 000 | 1 / 10 000 | 2.8 / 9 254 ms | 261 / <1 | 260 / 3 341 | 55 / 27 842 ms ; 193 / 41 395 |

- **Setup:** 1M subscriptions took 28 s to subscribe and about 3.1 GB of the server's heap, so about 3 KB each.
- **1M at 10 % was not run:** at about 1 ms per invalidated subscription it would take some 100 s of CPU per
  commit.
- **The server holds 1.1–1.4 cores in every saturated cell:** the JS thread plus Bun's own threads.

**What sets these numbers.** The profiles (`PROFILE=<dir>`) show two costs that Convex does not have, both in the
sync session:

- **Every transition re-checks every query of its session against the write log.** The check is
  `changedBetween(q.exec.reads, q.validAt, ts)` before the reruns, and again after them. It scans every write into
  the index since the session's last transition.
- **A rerun first checks whether the key's latest result is still valid.** That is `resultAt`'s `valid`, with the
  same scan, from the result's own ts.
- So a commit that invalidates one subscription costs O(queries per session × commits since that session last
  moved). That cost grows with N, since each session moves more rarely.
- In the profiles, the first check took 32 % of the server's CPU at 1 000 subscriptions. With it removed, the second
  took 44 % at 10 000.
- **Convex reruns only what was invalidated.** Its `need_fetch` takes the queries whose subscription is gone
  (`crates/sync/src/state.rs:379-391`). The subscription manager drops them when a commit hits them, so valid
  queries are not looked at (`worker.rs:1080-1135`).

The same bench on a **prototype that is not in this PR** shows what that costs. The prototype takes a session's
stale queries from the keys the hub matched, and trusts a key's latest result unless the hub saw a commit hit it
since. Every `sync*` test passed with it.

| N | invalidated per commit | isolated CPU per commit | saturated commits/s | updates pushed/s | update p50 |
|---|---:|---:|---:|---:|---:|
| 1 000 | 1 / 10 / 100 | 0.82 / 1.5 / 5.1 ms | 7 892 / 2 337 / 485 | 7 832 / 21 751 / 29 295 | 2 / 9 / 41 ms |
| 10 000 | 1 / 100 / 1 000 | 0.84 / 6.5 / 44 ms | 6 943 / 261 / 52 | 6 938 / 24 554 / 28 817 | 3 / 77 / 390 ms |
| 100 000 | 1 / 1 000 / 10 000 | 0.86 / 62 / 511 ms | 6 065 / 24 / 5 | 6 063 / 22 936 / 26 144 | 3 / 847 / 4 068 ms |
| 1 000 000 | 1 / 10 000 | 0.85 / 1 187 ms | 4 027 / 1 | 4 025 / 11 021 | 4 / 10 894 ms |

- **With one invalidation per commit, the commit rate no longer falls with N:** 6–8k commits/s up to 100k, 4k at
  a million, against 261 today.
- **What is left is per update:** 43–54 µs of CPU for each query update at saturation, about 22–29k updates/s
  from one process. At a million subscriptions it is 119 µs, with a 3 GB heap.
- **Where an update's CPU goes** (10 000 subscriptions, 10 %):
  - replacing the read-set in the `ReadSetIndex`, 25 %;
  - running the query (engine, transaction, functions, values), about a third;
  - the session's transition, its JSON and the socket send, the rest.

**Convex's binary on the same Mac** (one backend, every core):

| N | invalidated per commit | isolated CPU per commit | saturated commits/s | updates pushed/s | backend cores | update p50 / p99 |
|---|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 2.1 ms | 2 094 | — | 4.6 | — |
| 1 000 | 1 / 10 / 100 | 4.6 / 27 / 235 ms | 1 087 / 474 / 232 | 1 082 / 1 591 / 834 | 5.2 / 4.7 / 2.9 | 23 / 744 / 1 327 ms ; 34 / 1 237 / 3 044 |
| 10 000 | 1 / 100 / 1 000 | 5.1 / 233 / 2 167 ms | 1 034 / 715 / 505 | 1 032 / 1 674 / 1 410 | 5.4 / 5.8 / 4.8 | 24 / 4 397 / 3 645 ms ; 55 / 6 465 / 5 630 |
| 100 000 | 1 | 5.6 ms | 1 134 | 1 132 | 6.4 | 24 ms ; 41 |

- **Convex spends about 2.2 ms of CPU per invalidated subscription,** about 40× bunvex's prototype. It delivers
  1.0–1.7k query updates/s however many cores it uses.
- **Its commit rate holds while its updates fall behind.** Commits run on other threads than the sync workers, so
  a wide fan-out shows as seconds of update latency, not fewer commits. bunvex's one thread slows the writers
  instead.
- **Its 100 000 row ran with 200 subscriptions per socket** (500 sockets). With 20 per socket, Convex's backend
  stopped accepting subscriptions at about 680 sockets (13 600 subscriptions in 10 min). Not investigated.
- Its 1 % and 10 % rows at 100 000 and beyond were not run: at 2.2 ms per invalidated subscription a commit takes
  some 20 s of CPU.

**Measured as asked, and what is a model.**

- The end-to-end numbers use real sync sessions over loopback, the client in other processes on the same machine.
  The clients took 4 other cores at most.
- The commit stream of STUDY-24 is not built, so its follower is a model from the micro numbers. So is the leader
  of Convex's shape, which bunvex does not have either: its execution off the leader (A2 for queries) and its
  socket tier are not built.

**What saturates first in Convex's shape.** The leader keeps the commit, the matching, each invalidated read-set's
replacement and the session's transition. Execution moves to other processes and sockets to a forwarding tier.

- **The leader's load per second** is `W × c_commit + U × c_update`:
  - W is commits/s and U is query updates/s;
  - `c_commit` is 0.12 ms today (10.9k/s on 1.33 cores), less once mutations execute elsewhere (A2);
  - `c_update` is what stays on the leader: the prototype's 43–54 µs minus the run, so about 30–40 µs;
  - the matching is a few µs per commit.
- So one leader core carries about **25–33k query updates/s** when it commits little, and fewer as it commits more.
- **At the store's write ceiling** (§5.1: 4.6–5k inserts/s on SQLite here), the leader keeps up while a commit
  updates about 2–4 subscriptions on average. Past that, its subscription work saturates before the store does.
- **On the droplets** (§5.5: 1.6–2k inserts/s on 0.6–0.7 of a core), every cost is 3–4× higher, and the same
  arithmetic gives about 2 updates per commit.
- **Today it saturates much earlier:** with one invalidation per commit, 1 633 commits/s at 10 000 subscriptions
  and 261 at a million. That is below every write ceiling in §5.1, §5.4 and §5.5, and it is the two costs above,
  not anything Convex's shape requires.

**STUDY-24's shape, as a model.** With k followers sharing N subscriptions:

- **Per follower:** `W × (a + m(N/k)) + (U/k) × c_full`:
  - `a` = 0.45 µs to apply a commit, plus its socket read (not measured here);
  - `m(N/k)` = 1–3 µs to match it;
  - `c_full` = 43–54 µs per update, including the run.
- **Per leader:** `W × (c_commit + k × s)`, with s the push of a frame to one follower. STUDY-24 §4.5 measured
  about 6 µs per socket per 1 KB message.
- At W = 5k commits/s, a follower's own share costs about 2 % of a core (4 % with a socket read as dear as the
  leader's send), and the leader's push to 8 followers about 24 %. Update capacity then grows about linearly with k: 8 followers would carry some 200k updates/s.
- **Assumptions:**
  - followers' reruns read the shared store at their own applied ts, at the same cost as on the leader;
  - subscriptions spread evenly over followers;
  - deduplication across followers is lost (two followers watching one key both rerun it);
  - the stream's catch-up, gaps and lag handling (H4, H9, H10) are free in steady state. They cost code, not CPU.

**Reading.**

- **The per-commit apply that STUDY-24 adds is cheap:** under 1 µs, and about 3 µs of matching even at a million
  subscriptions. That is not what makes Convex's shape preferable.
- **STUDY-24's shape scales update fan-out past one core; Convex's does not.** Convex does not either: its one
  backend delivered 1.0–1.7k updates/s here, and bunvex's one process, with the two costs fixed, carries 13–29×
  that. A bunvex leader in Convex's shape stays above what a Convex deployment's one backend does, which is the
  bar parity sets.
- **The number that matters today is the session's revalidation, not the design.** Until it is fixed, a commit
  that invalidates one subscription costs 0.3–4 ms of leader CPU, growing with N, in either design. In STUDY-24's
  each follower would pay it for its own sessions.

### 5.7 Q4 built: a session reruns only what a commit invalidated

**The change.** The sync hub now keeps each execution's validity, as Convex's subscription worker keeps each
subscription's (`crates/database/src/subscription.rs`: a valid subscription's ts follows the manager's processed
ts, and an invalid one keeps its invalid ts).

- **While an execution is a watched key's latest,** the hub's `onCommit` records the first commit that wrote into
  its reads, commit by commit, before it tells any session.
- **A transition** (`stale`), **its end** (a commit that landed during it), **and a reuse** (`resultAt`) ask
  `SyncHub.validAt`. For a tracked execution the answer is O(1), as Convex's `extend_validity` reads its
  subscription's ts.
- **An execution no longer tracked** (another run replaced it) is checked with `Committer.earliestChange` from the
  ts it was last known valid at, and the answer is remembered.
- **A new result is checked once, when it is registered,** against the commits that landed while it ran, as
  Convex's `subscribe` refreshes a new subscription through the write log. If one of them wrote into it, the
  session that ran it reruns it at once. Its other watchers wait for their own, possibly splayed, notification.
- **A subscription nothing wrote into now stays valid past the write log's retention, as Convex's does.** Before,
  a session whose last transition left the log reran every query (and logged the runs).

**Before and after,** on the same bench and Mac (load average 3–6), at `f7d55c81`:

| N | invalidated per commit | saturated commits/s, before → after | updates/s, before → after | update p50, before → after |
|---|---:|---:|---:|---:|
| 0 | 0 | 10 039 → 10 975 | — | — |
| 1 000 | 1 / 10 / 100 | 2 678 / 1 202 / 320 → 7 905 / 2 347 / 534 | 2 661 / 11 119 / 19 361 → 7 848 / 21 894 / 29 783 | 6 / 15 / 58 → 2 / 9 / 38 ms |
| 10 000 | 1 / 100 / 1 000 | 1 392 / 118 / 30 → 6 879 / 241 / 41 | 1 389 / 11 073 / 17 576 → 6 873 / 22 872 / 27 704 | 12 / 158 / 632 → 3 / 83 / 463 ms |
| 100 000 | 1 / 1 000 / 10 000 | 660 / 12 / 3 → 5 990 / 22 / 4 | 659 / 10 437 / 14 509 → 5 988 / 20 565 / 24 351 | 25 / 1 544 / 6 615 → 4 / 920 / 4 133 ms |
| 1 000 000 | 1 / 10 000 | 249 / — → 3 822 / <1 | 248 / — → 3 820 / 6 357 | 59 / — → 4 / 21 705 ms |

- **One invalidation per commit:** 15× the commit rate at a million subscriptions, and 9× at 100 000. The rate
  now falls only from 7.9k to 3.8k across three orders of magnitude of N.
- **Wide fan-outs:** 20–30k query updates/s from one process, against 10–19k before.
- **The isolated CPU per commit at 100 000 subscriptions and one invalidation** went from 1.5 to 0.71 ms.
- **The prototype's numbers hold.** A first version kept the validity in a `WeakMap`, and at a million executions
  that halved the commit rate (1 783/s): garbage collection walks every entry. It is now a field of the execution.
- 1M at 1 % before was not rerun here (§5.6 has 9.3 s of CPU per commit). Raw results:
  `bench/results/s184-invalidation/q4-before.jsonl` and `q4-after.jsonl`.

**The one failure seen.** One run of 1M subscriptions at 1 % on the first version (the `WeakMap`) had 16
`QueryFailed` in its saturated phase, with updates 16–31 s late. Its message was not captured. The bench now prints
each failed query's message on the client, and on the server each failed run from its function log. What was
found:

- **Not seen again.** The cell ran 5 more times on the final code at 1M and 1 %, 5 times at 100 000 and 10 %, and
  3 times with the `WeakMap` version restored (load average 3–14). None had a failure.
- **The only failure this bench can produce is a timeout, and `origin/main` produces it too.** A query's time
  waiting on its store calls counts against `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS` (15 s, as Convex's). A store
  call's answer that waits behind thousands of reruns on the one thread, or behind a long collection, counts as
  that wait. With the limit at 1 s, `origin/main` (`a90013ff`) at 100 000 and 10 % failed 3 queries while other
  sessions held the machine at a load average of 19: "Your request timed out performing too many system
  operations." The branch had none in that pair of runs. Neither had any in two more pairs at a load average of
  4–7.
- **A probe holds the thread for 1.2 s while a sync rerun waits on its store call,** with the limit at 1 s. It gives
  the same `QueryFailed` on `origin/main` and on the branch, and the same entry in the function log (`Query m:list
  SyncWorker`, "Uncaught Error: Your request timed out performing too many system operations.").
- **So the 16 are most likely this timeout, reached by the first version's heavier collections under a 16–31 s
  backlog.** The `WeakMap` held a million entries. Validity tracking cannot fail a query: it only decides whether
  one runs, and no test or run showed a wrong or missing result.

## 6. Additions

None proposed.

## 7. Owner questions

Decided (owner, 2026-10-26): every recommendation below. Q1's direction is Convex's shape; measurement 3 confirms
it before any follower code.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | Keep STUDY-24's H2/H4 (followers execute queries and own subscriptions, fed by a pushed commit stream), or follow Convex's shape: the leader keeps the commit and the subscriptions, and other processes take execution against the store at the leader's timestamp (A2, already decided) and sockets forwarded to the leader? | Follow Convex's shape. It needs no commit stream, no read index and no lag handling, and its read-your-writes is automatic. Its cost is that the leader's subscription work does not spread; §5.1 did not load subscriptions, so measurement 3 in §5.2 decides it |
| Q2 | Before any follower: take work off the one JS thread inside one process first, for example SQLite's synchronous writes (51 % of an insert's main thread) and the per-request value checks? | Yes. It raises what one process does, and every design in §3.1 needs it |
| Q3 | Run §5.2's missing measurements on the owner's Linux box, with k6 on a second machine? | Yes. Without them, neither Q1 nor A1 has a number behind it |

Measurement 3 (§5.6) is in. **It confirms Q1:** matching and a follower's apply cost microseconds at a million
subscriptions, and a bunvex leader that keeps every subscription carries more query updates than one Convex backend
does. Two questions it raised, decided (owner, 2026-10-26) as recommended:

| # | Question | Recommendation (decided) |
|---|---|---|
| Q4 | Make the sync session rerun only the queries a commit invalidated, as Convex's `need_fetch` does, instead of re-checking every query against the write log on each transition and each rerun? | Yes, in its own PR with tests and a measurement. It is not a divergence: apps see the same transitions, sooner. §5.6's prototype gives 15× the commit rate at a million subscriptions. **Built** (§5.7): 15× at a million, as the prototype |
| Q5 | Withdraw DV-116, DV-118 and DV-119, and rewrite DV-114 as §4 proposes? | Yes. Convex's shape needs none of the three, and DV-114 then describes Convex Cloud's shape |

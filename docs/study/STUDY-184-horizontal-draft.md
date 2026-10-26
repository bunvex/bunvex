# STUDY-184 — Horizontal scaling: Convex's real shape, and what one bunvex process does with a core
<!-- index: Horizontal scaling: Convex's real shape, one bunvex process per core | decided (owner, 2026-10-26): Convex's shape, pending measurement 3 -->

- **Status:** rewritten from scratch on 2026-10-26. The earlier draft did not read Convex's source, and its load
  measured the client rather than the server (§5.1). No product change. Decided (owner, 2026-10-26): every §7
  recommendation.
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
are marked as under review in `divergences.md`. They are withdrawn or rewritten once §5.2's measurement 3 is in.
DV-113, DV-115, DV-117 and DV-121 hold in both shapes.

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
- **Not measured yet, and needed before any follower code:**
  1. the same table on a dedicated Linux box with the load generator on another machine;
  2. one shared Postgres store under N processes (the store's group commit becomes the write ceiling);
  3. the cost of invalidation under each design in §3.1;
  4. Convex's binary under the same scenarios on the same box, to see what one multi-core Convex process gives.

### 5.3 From the earlier draft, kept

On Linux, two processes binding one port with `reusePort` share the connections (195 / 205 of 400). On macOS one
process gets all of them (`bench/scale/reuse-port.ts`). This matches STUDY-24 §4.7. It was not re-run here.

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

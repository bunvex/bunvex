# STUDY-24 — Horizontal scaling

- **Status:** draft v2 — an exploration, not a design. v1 was reviewed on 30 Sep 2026 by seven independent
  passes (Convex claims, lease and fencing, commit stream, follower reads and remote mutations, multi-core
  on one machine, singletons and failover, prior art), four of them with throwaway experiments on the real
  engine and drivers (Postgres 17, MySQL 8.4; MongoDB and PgBouncer not available). Decisions H1–H12 (§6)
  await the owner, except H5, H7 and H8 (decided 2026-09-30).
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend, plus
  [How we horizontally scaled function execution](https://stack.convex.dev/horizontally-scaling-functions)
  and [Self-hosted: develop and deploy](https://stack.convex.dev/self-hosted-develop-and-deploy)
  (marked **[blog]**).
- **bunvex read at:** `main` @ `080c7f0` (and `feat/sync-session` @ `0c40e25` where noted).
- **Related:** ENGINE-00 R1/R5, PERSIST-01, STUDY-06 (OCC; D9 wall-clock ts, decided and built in #64; D10 log window), STUDY-08 (cache and
  subscriptions), STUDY-09 D6 (by-ts log read: built on `indexes` as PERSIST-01 C11), STUDY-21 (OCC retries), STUDY-22 (mutation order),
  STUDY-23 (sync protocol v1).

**Why this study exists.** One of bunvex's goals is to be faster than Convex **and** to scale
horizontally. Self-hosted Convex is one process that cannot run as N replicas.

**Numbers.** Measured on an 8-core Apple Silicon Mac, shared with the other experiments. Absolute values
are indicative; ratios are what count. Linux figures must be re-measured on the VPS.

## 1. How Convex does it

### 1.1 Self-hosted: one process, one writer

`crates/local_backend/src/lib.rs:154-233` (`make_app`) builds everything in one process:

- the `Database`: committer, snapshot manager, write log, subscriptions;
- `InProcessFunctionRunner` (V8);
- `InProcessSearcher`;
- a local Node subprocess for Node actions;
- the query cache;
- the sync (WebSocket) worker;
- every background worker.

**The persistence lease** (`crates/postgres/src/lib.rs:1745-1893`, `sql.rs:721-755`; MySQL the same in
`mysql/src/v6/persistence.rs:1282-1363`):

- Acquiring is `UPDATE leases SET ts=$1 WHERE id=1 AND ts<$1`. It **never blocks**: the process with the
  newest wall-clock ts takes the lease at once. With clock skew, a newcomer whose ts is lower fails at
  startup.
- **No expiry and no heartbeat.**
- Each write transaction runs a non-locking advisory check. `SELECT … FOR SHARE` on the lease row runs only
  at the **end, just before COMMIT**, "to minimize the time spent holding the row lock".
- The loser only learns on its **next persistence write** (`LeaseLostError`), then exits
  (`local_backend/src/main.rs:202-207`). An idle loser "may never notice" (`retention.rs:667-676`). It keeps
  serving stale reads and subscriptions for up to the idle `max_repeatable_ts` bump, about 1–2 h.
- It is not a ping-pong: the newcomer keeps the lease. It only thrashes if an orchestrator restarts the
  loser.
- **SQLite, the self-hosted default, has no lease at all.**

**No follower mode exists in the open code.**

- `FollowerRetentionManager` and `new_static_repeatable_recent` exist, but have no follower caller.
- The `read_only` table is a freeze flag, not a follower mode (`postgres/src/lib.rs:330-334`).

### 1.2 The write path

- **One task.** One `"committer"` task (`crates/database/src/committer.rs:295-352`).
- **Parallel around it:** pre-validation, 32 concurrent; persistence write batches, 16 concurrent.
- **Serial inside it:**
  - The timestamp is `max(latest_snapshot_ts+1, wall clock, last_assigned_ts+1)` (:1387-1399).
  - OCC checks against the in-memory `WriteLog` and `PendingWrites` (:888, :1007).
- **Windows:**
  - The write log keeps 30–300 s, with a 50 MiB soft cap (`knobs.rs:870-885`).
  - Transactions begin within `MAX_TRANSACTION_WINDOW` = 10 s.
- **`max_repeatable_ts`** (:807-870, :1401-1412): every later commit gets a ts above it. With pending writes
  it is `min_pending − 1`. It is persisted as a global, at most 5 s after a commit, and every 1–2 h when
  idle.
  - A new leader writes it at load under the lease. That both fences the old leader and puts new
    timestamps above everything persisted (`common/src/persistence/mod.rs:723-746`).

### 1.3 How Convex Cloud scales

Convex Cloud keeps one committer per deployment but **does** scale everything around it:

- **Funrun** executes functions [blog].
  - Why: V8 capped a backend at about 128 concurrent functions.
  - Routing: rendezvous hashing, at most 32 requests at a time per funrun node.
  - Protocol:
    1. The backend begins the transaction **at its own latest repeatable ts** and passes that ts to funrun
       (`application_function_runner/mod.rs:403-470`).
    2. Funrun trusts that ts and reads the shared database at it.
    3. It returns `FunctionFinalTransaction {begin_timestamp, reads, writes}` (`function_runner/src/lib.rs:150-156`).
    4. The backend checks that `begin_timestamp` matches ("Timestamp mismatch", `transaction.rs:527-530`) and
       commits through the **normal** OCC path, recomputing index writes from its latest pending snapshot.
  - Too old a snapshot gives `OutOfRetention`: outside the 10 s window at begin, or below the write log's
    purged ts at commit (`write_log.rs:571-613`). The sync worker retries it.
- **WebSocket sync runs outside the backend.**
  - The self-hosting post lists "handling WebSocket connections" among the services that scale
    independently.
  - `ApplicationApi` routes to "the appropriate backend in the hosted version" (`application/src/api.rs:83-86`).
  - Its `SubscriptionClient` is a **remote subscription stream** to the backend's `SubscriptionsWorker`
    (:559-620).
  - `SubscriptionReconnectRateLimiter` paces reconnect replays "per partition within one Usher process"
    (`sync/src/subscription_reconnect.rs:18-20`).
  - So N stateless **Usher** nodes hold the sockets, and only invalidation and the commit stay on the one
    backend.
- **Other services:**
  - Searchlight handles search; its gRPC protocol is open, the service is not.
  - Node actions leave the backend in Cloud; Lambda per the knob comments.
  - Conductor is multi-tenant across deployments.
- **What stays single:**
  - the committer and the subscriptions worker;
  - every background worker: scheduler, crons, retention, index backfill, table summaries, search
    flush/compaction, export/import (`application/src/lib.rs:760-947`, `database.rs:1071-1103`).
  - The scheduler explicitly assumes one instance: see §4.6.
- **No sharding and no multi-writer** for one deployment exists in open code or the blog: "each customer
  deployment corresponds to a single backend process" [blog].

### 1.4 Execution limits (why "V8 limits things")

| Limit | Value | Where |
|---|---|---|
| Heap | 64 MiB + 32 MiB | `knobs.rs:1163-1169` |
| Query / mutation time | 1 s user, 15 s system | `knobs.rs:984-996` |
| V8 action time | 1800 s | |
| Node action time | 600 s | |
| Isolate workers | 300 | `knobs.rs:1021` |
| `APPLICATION_MAX_CONCURRENT_QUERIES` / `_MUTATIONS` | 16 / 16 | `knobs.rs:1097-1154` |
| `_V8_ACTIONS` / `_NODE_ACTIONS` | 64 / 64 | `knobs.rs:1097-1154` |

The concurrency caps apply per backend **before** the function runner, so they cap Cloud too. They, not the
database, bound a self-hosted backend under load.

## 2. What an app can observe

Scaling must not change any of these:

- **Serializable mutations** over the whole deployment, with Convex's OCC retry budget and error (STUDY-06, STUDY-21).
- **One snapshot per result.** All queries of a transition advance together (STUDY-23).
- **Read-your-writes, everywhere a Convex app gets it from having one backend:**
  - **WebSocket.** After `await mutation()` resolves at ts T, the next transition is at ≥ T. A node that
    receives the mutation's response before its own view reaches T must wait before sending the
    transition. Otherwise `await` can hang.
  - **Reconnect.** A node behind the client's `maxObservedTimestamp` must not serve it. Convex **fails the
    Connect** and the client reconnects (`sync/src/worker.rs:619-638`).
  - **HTTP.** A mutation response carries no ts. A mutation followed by a query from server code expects to
    see the write. Self-hosted Convex never shows otherwise.
  - **`consistentQuery`.** `/api/query_ts` then `/api/query_at_ts` (`public_api.rs:508, 526`). A ts obtained
    on one node must be answerable on another, or fail the way Convex does.
  - **Inside an action, and in scheduled functions.** `ctx.runMutation` then `ctx.runQuery` reads at ≥ the
    mutation's ts. A scheduled function reads at ≥ the commit that scheduled it.
- **`Date.now()` and `_creationTime`.**
  - A transaction's creation time is max(wall clock, latest ts + 1, snapshot ms) (`database.rs:2015-2017`,
    `document.rs:225-245`), so that `_creationTime ≥ Date.now()`.
  - Across nodes, clock skew breaks this unless it is derived from the leader.
  - Cached queries that read `Date.now()` expire after query timeout + 1 s (`cache/mod.rs:121`), on every node.
- **Pagination cursors** are portable across nodes.
- **Mutation order per connection** (STUDY-22) and **exactly-once per request id** (STUDY-23 P5, `_session_requests`).
- **Scheduled mutations and crons run exactly once. Scheduled actions run at most once.** A crash mid-action
  shows as `failed("Transient error while executing action")` (`scheduled_jobs/mod.rs:1015-1030`), never as
  a re-run.
- **Not observable, so free to change:** the topology, which node ran a function, how commits travel.
  Subscription latency may differ.

## 3. How bunvex does it today

bunvex is strictly single-process. ENGINE-00 R5 defers "replicas fed by the commit log" to a later spec.

| State | Where | Notes |
|---|---|---|
| Commit ts | `max(appliedTs + 1, wall clock in µs)`, as Convex (STUDY-06 D9, #64) | Seeded from `persistence.maxTs()`. **Sparse**: `ts + 1` is not the next commit, so gaps are not visible from timestamps alone (§4.3). |
| Visible ts | `Committer.visibleTs` | Advances after `flush()`. Flushes are serial today. |
| OCC log | last 20 000 commits | Counted, not timed: 0.5–1.4 s at the engine's 14–42k commits/s |
| Catalog | `Engine` | Extended only in the process that created the table |
| Instance secret | generated if absent | |
| Query cache | per process, 1000 entries FIFO | Linear invalidation per commit |
| Subscriptions | per process | Linear matching per commit (STUDY-08 D9) |
| Memory-driver data | maps + B-trees; log replayed at open | |

**User functions run in the server's realm.** "This is not a sandbox"; there are no time or memory limits
yet (ARCH-01 §6.3).

**Measured ceilings** (throwaway experiments, 30 Sep 2026):

- **About one core per process.** The JS thread runs at 88–98 %; Bun's native HTTP code and the GC add
  0.1–0.25 of a core (0.75 with a large heap, as extra CPU, not throughput).
- Memory driver, one process:
  - cached query: 45–58k req/s;
  - insert: 18k/s.
- **Durable SQLite runs *under* one core** (7.3k inserts/s at 72 %): `bun:sqlite` fsync blocks the JS thread.
- **Engine + real driver, 64 writers:** Postgres about 20–22k commits/s, MySQL about 12–15k (64 commits per
  group).
- **Remote Postgres flush:** about 16 ms at 2.4 ms RTT, roughly 6 round trips per flush. Worth reducing.

### 3.1 Bugs found by this study (independent of scaling)

| # | Bug | Evidence |
|---|---|---|
| S1 | **Two processes on one store corrupt it silently.** | See details below. |
| S2 | **`maxTs()` ignores index-only commits.** On SQLite, Postgres and MySQL it is `max(ts)` over `documents`, but backfill commits write index rows only. After a crash right after such a commit, its ts is handed out again. On Postgres and MySQL it is also a full scan (50 ms at 1.26M rows, 150 ms on MySQL). | Reproduced by two passes |
| S3 | **`open()` can wedge.** An idle-in-transaction session (a paused process) blocks `PostgresPersistence.open()`'s `create … if not exists` DDL forever. | Reproduced; hung 10 min |
| S4 | **`Committer.validate` skips its window check when the log is empty** (`this.log.length && …`). An old snapshot would be accepted unvalidated. Latent today; real once snapshots can come from elsewhere. | Code reading |
| S5 | **Startup backfill blocks all writes** (`engine.ts:149-191`). It runs synchronously in `init()`. A failover to a store with a `backfilling` index blocks writes until it finishes. Convex backfills in the background. | Code reading |

**Status (30 Sep 2026):** S1 fixed on every driver by PERSIST-01 C7 (Postgres #62; MySQL #67; SQLite
and memory #70, an OS lock; MongoDB #84, a transaction per flush on a replica set). S2 fixed with it (the
durable prefix is recorded by each fenced flush). S3 fixed on Postgres (#62), MySQL (#67) and MongoDB
(#84). S4 fixed in #64 (the write log's window is tracked explicitly). S5 open.

S1 in detail:

- **Postgres and MySQL**, reproduced with two engines:
  - 3 and 300 acknowledged increments were lost;
  - 5 timestamps were shared by different commits;
  - snapshots changed after the fact (a reader at snapshot 13 saw k0 go 0 → 1);
  - a concurrent first boot made two catalogs (22 duplicate `_tables`/`_index` rows) and **two different
    instance secrets**;
  - two concurrent `open()`s crash on DDL.
- **MongoDB** (from code): `open()` deletes rows above the marker without a lock, and there are no unique
  indexes, so duplicates are never detected.
- **The memory driver and SQLite** share the same flaw on a shared directory or file. Several servers
  opened the same `./.data` log with no error.

## 4. Options, with what the review settled

### 4.1 Who commits

| | A. One leader, N followers (**recommended**) | B. Sharded committers | C. The database commits | D. One ts oracle + partitioned OCC validation (FoundationDB) |
|---|---|---|---|---|
| Semantics | Convex's: one ts order, one OCC log | Cross-shard needs 2PC; ts order per shard | Serializable, but the DB's conflict rules and errors. No bunvex-usable commit ts: a sequencer would still be needed. | Kept (strict serializable) |
| Write ceiling | The shared DB's durable group-commit rate binds first (PG about 20k commits/s here). A single FDB resolver thread does about 280k TPS; a TSO about 260M ts/s. | Scales | The DB's, without group commit or in-memory OCC | Beyond one core |
| Complexity | Lease + commit stream | Very high: the community fork `horizontal-scaling-convex` (NATS KV oracle, Raft per partition, 2PC) is alpha, with 2PC, durability and workers unfinished | Medium; still needs a change feed | A commit waits for every resolver it touches; false aborts |
| Precedent | Convex, Zero (replication-manager → view-syncers), Firestore (ordered changelog → handlers) | — | Hasura-style polling | FoundationDB |

**Recommendation: A now, with D as the documented growth path.**

- D is worth it only above roughly 50–100k commits/s sustained, which one shared database primary will
  not absorb anyway.
- To keep D open, **keep OCC validation a pure function** of `(readSet, snapshotTs, writeLog)` so it can be
  split by key range later. The first split would be across `Worker`s inside the leader.
- **Calvin-style deterministic ordering is out:** it needs read/write sets before execution, which dynamic
  JS mutations cannot give.

### 4.2 Where mutations run

- **A1: followers forward mutations to the leader, which executes and commits them.** Measured in a spike
  with the real engine:
  - The leader alone, taking HTTP itself: **18k inserts/s**.
  - Leader + 1–3 followers forwarding over a unix socket: **28–29k inserts/s (+55 %)**. The leader stops
    parsing HTTP and serializing responses.
  - One forward costs 20–50 µs: a unix socket carries over 300k msg/s, TCP localhost about 140k, HTTP
    `fetch` about 60k. **Do not forward over HTTP.**
- **A2: execute on any node, commit on the leader.** Simulated against the real committer: 32 clients,
  Convex's retry budget, invariants checked (bank total, no negative balances, counter = successes, unique
  names).
  - **The current committer validates remote read sets unchanged.** It needs the snapshot ts, **all** read
    intervals (including ranges), the docs and the index writes.
  - **Sabotage broke the invariants,** as it should:
    - the wrong snapshot gave a bank total of 1,000,164 and a counter of 103 for 2,155 successes;
    - dropping range reads gave 704 users for 200 names.
  - **Executing at the follower's lagged snapshot is wrong.** On a hot counter, throughput fell from 79 to
    2 per second as lag grew from 5 to 500 ms, because every retry is again `lag` behind.
  - **Convex's shape fixes it:**
    - the leader hands out the begin ts (its latest);
    - the node reads the **shared database** at that ts;
    - **retries run on the leader**;
    - the leader **recomputes index writes** from document writes, so a node with a stale catalog cannot
      send incomplete index writes.

    With leader-side retries the hot counter held about 145/s whatever the lag, and uniform keys stayed
    within budget at every lag.
  - A2 needs a **time-based OCC window**: at lag 500 ms under load, 60 % of attempts conflicted with the
    count-based one. It also needs S4 fixed.

**Recommendation.**

- A1 first. It is cheap and already raises the write ceiling.
- A2 after pipelined commit and the time-based window, with Convex's begin-ts protocol.
- Writes still stop scaling at one core of mutation execution under A1. That is A2's job.

### 4.3 How commits reach followers

**What a follower needs per commit:**

- the ts;
- the index-key write set `(index, key, doc id | null)`, which is exactly `LogEntry.writes`;
- the leader epoch;
- whether the catalog changed. That is derivable: writes on the `_tables`/`_index` indexes.

Documents are not needed: the follower reads them at its snapshot. The leader validates A2 against its own
log, so followers need the write set **only** for cache and subscription invalidation.

**The persisted log.**

- **`indexes`, not `documents`, is the complete log.** Every accepted commit writes by-id index rows;
  backfill commits write no documents.
- This is a divergence from Convex, which reads `documents` by ts using `prev_ts`. bunvex has no `prev_ts`
  (STUDY-09 D6).
- The by-ts index is **mandatory**. Without it a poll is a sequential scan that grows with the store (26 ms
  at 350k commits); with it, 0.24 ms, and catch-up runs at 563k commits/s. It costs 0–14 % of write
  throughput and a small index. **Built** on every driver: §4.3.1 (PERSIST-01 C11).

**Delivery options,** measured with the real committer and Postgres driver. Latency is from the durable
flush to the follower knowing the ts and write set:

| Option | p50 / p99 at 5k commits/s | Cost and risk |
|---|---|---|
| **Leader push over TCP** (N = 1 / 16) | 0.03 / 0.35 ms ; 0.24 / 4.3 ms | No DB load; needs a queue bound |
| Poll by ts every 20 ms | 14 / 29 ms | One 0.24 ms query per poll per follower |
| Postgres `LISTEN/NOTIFY` + read (N = 16) | 8.6 / 157 ms | See below |
| Postgres logical replication (pgoutput) | 0.07 / 4.6 ms | See below |
| MySQL binlog | — | See below |
| MongoDB change streams | — | Require a replica set; the driver does not assume one |

- **NOTIFY: rejected.**
  - The payload is capped at 7999 B, so it can only be a wake-up.
  - It costs up to 34 % throughput inside the flush.
  - It takes a global commit lock: 64 writers dropped 40 %.
  - A stuck listener fills the queue and then **fails the leader's flush**.
- **Logical replication: rejected** despite being fast.
  - Postgres only.
  - It needs `wal_level=logical` (a restart) and the REPLICATION privilege.
  - Each slot decodes the WAL separately: four consumers halved leader throughput.
  - A dead consumer pins WAL (about 20 GB/h at 5k/s).
  - Managed providers restrict slots (Hasura's reason too).
- **MySQL binlog:** the available client crashed on 8.4 before delivering an event.

**Recommendation:**

- **Leader push is the delivery; the by-ts read is the source of truth.** It keeps self-hosting to "bunvex
  + your database".
- **Frames:** one binary length-prefixed frame per group, `{epoch, entries: [{ts, writes}]}` plus a
  catalog flag. The leader pushes only after the flush.
- **Gaps:** timestamps are sparse since D9 (#64), so each frame entry carries `prevTs`, the ts of the
  commit before it. The follower checks `prevTs === last` and fills any gap by the by-ts read. A slow
  poll (100 ms–1 s) is a safety net. **Followers drop frames from an older epoch.**
- **Back-pressure:** one follower stalled 3 s at 5k/s grew the leader's queue to 1.8 MB with no bound.
  - Cap each follower's queue, at about 4–8 MB or 2 s.
  - Past the cap, disconnect it. It catches up by the by-ts read: subscribe first, buffer, then fill.
- **Follower `visibleTs` is the highest ts up to which the `prevTs` chain is unbroken.** Under pipelined commit, ts 3 can become
  durable before ts 2, and a naive poller then skipped ts 2 forever. Reproduced.
- **MongoDB** (owner's choice, 2026-09-30: **a transaction per flush on a replica set**): log reads are bounded by the lease's `maxTs` (the durable prefix, written in each flush's transaction), read at majority.
- **Fan-out cost at the leader** is O(followers), never O(clients).
- **For the spike,** polling every 20 ms is enough.

### 4.3.1 Built: the by-ts log read (PERSIST-01 C11)

Built on 2026-10-01 after H11 was decided. Every driver has `readLog(afterTs, upToTs, limit)`: the
commits with `afterTs < ts ≤ min(upToTs, maxTs)`, whole, in ts order, each `{ts, prevTs, writes}` where
`writes` is the commit's index write set (the committer's `LogEntry.writes`) and `prevTs` the ts of the
commit before it, so a reader detects a gap by `prevTs !== last`. Conformance K25 checks it on all five
drivers, and through the engine against the committer's own commits.

**How Convex compares** (STUDY-09 §1.5). Convex reads `documents` by ts (`load_documents`,
`crates/common/src/persistence/mod.rs:562`), bounded by a repeatable ts (`mod.rs:774`), with
keyset paging on `(ts, table_id, id)` in Postgres (`crates/postgres/src/sql.rs:269`). Its `prev_ts` is the
previous version of the same document, for revision pairs and retention; it does not detect a missed
commit, which is what bunvex's per-commit `prevTs` is for. Streaming export never splits a commit across
pages (`document_deltas`, `crates/database/src/database.rs:2190`); `readLog` does the same with `limit`.

**Per driver:**

| Driver | Index | Bound (never an unflushed group) | Read |
|---|---|---|---|
| memory | the commits in an array, appended in ts order | the last flushed ts | binary search, then a walk |
| sqlite | `indexes_by_ts (ts)` | the last committed ts while a group sits in this connection's open transaction | one statement + one probe for `prevTs` |
| postgres | `indexes_by_ts (ts)` | the lease row's `max_ts`, in the same statement | one statement: a loose index scan finds the `limit` commits |
| mysql | `indexes_by_ts (ts)` | the lease row's `max_ts`, in the same statement | one statement |
| mongodb | `{ts: 1}` | the lease's `maxTs`, read at majority | a cursor on the ts index, batches sized to `limit` |

The index is created with the tables. A store written before C11 gets it when the lease is acquired
(Postgres, MySQL, SQLite: a plain build blocks writers, so only the holder runs it, as an upgrade would);
MongoDB at open, like its other indexes.

**Measured** (8-core Apple Silicon Mac; Postgres 17, MySQL 8.4, MongoDB 8.3 single-node replica set; all
on one machine). `bun bench/readlog.ts write|catchup`.

Write throughput through the engine (one insert per mutation: one document, three index entries), with and
without the ts index, three interleaved 10 s runs per cell, alternating which goes first:

| Driver | Writers | With the ts index (commits/s) | Without | Cost (medians) |
|---|---|---|---|---|
| Postgres | 64 | 23 648 / 24 077 / 23 994 | 24 256 / 24 525 / 24 896 | 2.2 % |
| Postgres | 1 | 2 521 / 2 525 / 2 507 | 2 528 / 2 556 / 2 547 | 1.0 % |
| SQLite (durable) | 64 | 9 421 / 9 472 / 9 446 | 10 163 / 10 163 / 10 138 | 7.1 % |
| SQLite (durable) | 1 | 4 876 / 4 968 / 4 950 | 5 668 / 5 585 / 5 682 | 12.7 % |

Postgres is within the 0–14 % measured in review; SQLite pays more, since its commits are local and the
extra B-tree insert per index entry is a larger share of each one.

Catch-up: 100 000 commits (three index entries each) read back from 0 in pages, and a poll at the tail
(nothing new), with the ts index:

| Driver | Pages of 1 000 (commits/s) | Pages of 100 | Tail poll p50 |
|---|---|---|---|
| memory | 13–16 M | 11 M | < 0.01 ms |
| sqlite | 540–561 k | 486 k | 0.011 ms |
| postgres | 195–201 k | 143 k | 0.22 ms |
| mysql | 169 k | 124 k | 0.17 ms |
| mongodb | 145–156 k | 82 k | 0.16 ms |

Without the index, catch-up is a scan per page: SQLite 24 k / 2.5 k commits/s (pages of 1 000 / 100),
MySQL 4.7 k / 0.5 k, MongoDB 5.4 k / 0.5 k, Postgres (with a `select distinct` form of the query) 19 k /
2.4 k with a 13–28 ms tail poll. With the final Postgres query (a loose index scan, one probe per commit),
a store without the index is far slower still: such a store only exists until its first lease.

Two findings along the way:

- **Postgres plans `select distinct ts … order by ts limit n` from statistics.** On a log that has just
  grown they describe a small range, and Postgres hashed the whole range (270k rows) and sorted it: 54 ms
  for 1 000 commits instead of 3 ms. The query now walks the index one commit at a time
  (`order by ts limit 1`, which no estimate turns into a scan), and inlines its integer bounds so a generic
  plan cannot replace it.
- **MongoDB's default `getMore` takes up to 16 MB**: the first page beyond the 101-document first batch
  pulled the rest of the log. Batches sized to `limit` took catch-up from 1.2 k to 82 k commits/s
  (pages of 100).

### 4.4 Leadership and fencing

**Mechanism: a lease row `(epoch, holder, expires_at, max_ts)`, checked inside every flush transaction.**

- **Advisory and session locks do not fence.** Tested: after the lock connection was killed, the standby
  took the lock and the old leader's pool **still wrote**. This holds for `pg_try_advisory_lock` and MySQL
  `GET_LOCK`. PgBouncer transaction pooling does not support session advisory locks at all. They remain
  fine for serializing bootstrap DDL (`pg_advisory_xact_lock`).
- **The fenced lease row is safe.**
  - Paused-leader test (Kleppmann's scenario, flush delayed past the lease): unfenced, the old leader's
    commit was **acknowledged at a ts the new leader also used**. Fenced, it was refused with `lease lost`
    and no rows landed.
  - SIGSTOP/SIGCONT runs: zero old-epoch rows above the new `maxTs`.
- **Cost:**
  - A separate check statement costs exactly **one round trip per flush**: +0.1 ms on loopback, +5 ms at
    2.4 ms RTT, with nothing gained from pipelining.
  - **Folded into the first insert as a data-modifying CTE**, which also records `max_ts`, it cost nothing
    measurable. It also makes `maxTs()` O(1) and fixes S2.
  - The fence is paid once per group, so only the hot-key, latency-bound path feels it.
- **Expiry is liveness, not safety.**
  - Expiry uses the **database clock** (`clock_timestamp()`, `NOW(6)`); the epoch check gives safety.
  - A leader paused *inside* a flush transaction holds the row lock. The takeover then waits for that
    transaction to end, which is safe. Set `idle_in_transaction_session_timeout` (Postgres) or
    `wait_timeout` (MySQL) to about TTL/2, or it waits indefinitely.
- **Failover,** killed with SIGKILL at a random phase, 100k documents, 3 runs per TTL:

  | Lease TTL | Write outage | Acknowledged writes lost |
  |---|---|---|
  | 2 s | 1.5–2.0 s | 0 |
  | 5 s | 3.7–5.1 s | 0 |
  | 10 s | 7.0–10.0 s | 0 |

  - Rebuilding `maxTs`, the catalog and the secret took 17–41 ms.
  - **Under A1 the write log need not be rebuilt**: every new transaction starts at or after `maxTs`.
    Under A2 it is needed, starting at a `logStartTs` (S4).
- **Planned handover:** `releaseLease()` lets a deploy hand over at once instead of waiting a TTL.
- **Differences from Convex:**
  - Convex's lease has no expiry: the newest process wins at once.
  - bunvex's followers wait for expiry or release (H5).
- **MongoDB:**
  - Rows are written by `insertMany` outside any transaction, before the marker. A stale leader's late
    insert can land after the new leader's cleanup and then be covered by the new marker, so fencing the
    marker alone is **not enough**. Two options:
    - a replica set and a transaction per flush that includes a conditional update of the lease document
      (unmeasured);
    - epoch-tagged rows, where readers accept a row only if its epoch owned that ts.
  - `w:1` with `j:true` is not durable across a replica-set failover; that needs `w:"majority"`.
- **SQLite and memory+log** need an exclusive OS lock on the file or directory.
- **Side effects outside the database are not fenced:** actions, external calls, scheduler firing. They are
  covered by fenced claims (§4.6).

### 4.5 Followers: reads, cache, subscriptions, connections

- **Reads at `visibleTs` are safe on Postgres and MySQL.** With one fenced writer and serial flushes, every
  row at ts ≤ `visibleTs` is durable and immutable, and a group is one transaction, so no partial group is
  visible. MongoDB is safe up to the marker. The leader should publish the durable-prefix ts explicitly:
  `max_ts` in the lease row, updated in the fenced flush. Pipelined commit breaks "max(ts) = prefix".
- **Stream equivalence.** Cache and subscription invalidation from the stream is equivalent to today's
  in-process `onCommit`, under these rules:
  - apply events contiguously in ts order;
  - move `visibleTs` and run the listeners in the same tick;
  - apply catalog changes before `visibleTs` passes them;
  - use a time-based window.
- **Read-your-writes:**
  - **WebSocket.** After a forwarded mutation returns at ts T, the node waits until its `visibleTs` ≥ T
    before scheduling a transition.
    - On one node this already holds (#50): `Committer.commit()` resolves only once `visibleTs` has
      reached the commit's ts (`committer.ts`, after `flush()`), and after sending the `MutationResponse`
      the mutating session always schedules a transition, overlap or not (`sync.ts`, `mutation()` →
      `schedule()`), at `visibleTs ≥ ts` and sent even when empty. The test is `sync.test.ts` "a mutation
      that changes nothing watched still advances the ts".
    - With forwarding (A1), the follower gets `ts` from the leader while its own `visibleTs` may still be
      behind, so it must `waitForVisible(ts)` before that `schedule()`; otherwise the transition can come
      out at a ts below the mutation's and the client's `await` waits for a later one. This is one line in
      `SyncSession.mutation()`, added with the forwarding work.
    - For `Connect` behind `maxObservedTimestamp`: Convex refuses. The recommendation is a short bounded
      wait, then refuse (H9).
  - **HTTP, actions, scheduled functions and `query_at_ts`: "read index".** Before a read, a follower asks
    the leader for its current `visibleTs` (one fetch shared by concurrent requests) and waits to reach it.
    This costs one round trip, needs no client change, and makes follower reads linearizable.
    - Sticky routing is not enough: it breaks on failover and on rebalancing.
- **Subscription cost is the real scaling risk,** more than the writer. Meteor tailed the whole oplog on
  every server against every observer and collapsed. Supabase's per-subscriber authorization caps
  Postgres Changes at about 64 changes/s. Rules:
  - **Match sublinearly:** an interval index over subscribed read-set ranges, per index. This replaces
    today's linear scan (STUDY-08 D9).
  - **Dedup:** run each distinct `(function, args, identity-if-read)` once per node and fan the result out.
    Queries that do not read the identity keep an identity-free key.
  - **Coalesce:** fold many commits into one transition per tick, so a write burst is not one push per
    commit.
  - Optionally route subscriptions by a rendezvous hash of the query.
- **Fan-out** costs about 6 µs of CPU per socket per 1 KB message: about 60 ms of one core for 10k sockets.
  Spreading sockets over 4 processes costs 24 % more CPU in total, but each process is blocked about 3×
  less.
- **Reconnect storms:** a follower that dies sends its clients elsewhere, and they all re-run their
  queries. Use jittered backoff and a readiness gate that stays "not ready" until the node has caught up
  and loaded the catalog. Zero budgets 10 minutes for a new node.
- **Retention:** a follower lagging past the retention window must refuse reads, as Convex's
  `min_snapshot_ts` requires.

### 4.6 Singletons: scheduler, crons, retention, backfill

Settled by reading Convex's scheduler and simulating N executors on a real Engine: 400 jobs, half
mutations, half actions.

- **Scheduled mutations must not be claimed.**
  - Convex runs a mutation job in **one transaction**: read the job, stage `inProgress` visible only to
    itself, run the mutation, complete.
  - OCC retries have no cap (100 ms → 60 s backoff); system errors reschedule (500 ms → 2 h).
  - This is exactly-once with any number of executors. A committed claim would expose `inProgress` and
    need a recovery that either re-runs the job or fails it, both non-Convex.
- **Actions: commit the claim first.**
  - The job becomes `inProgress{requestId, executionId}` durably **before** running. That gives
    at-most-once.
  - Sabotage (running before the claim commits): 200/200 actions ran more than once, 1,600 runs in all.
- **Recovery must know the owner.**
  - Convex's rule, "`inProgress` and not in my running set means it crashed", is only true with one
    executor. On 8 executors it failed 2 of 200 healthy running actions.
  - Record `owner: node/epoch` in the internal document, not in the virtual table. Fail a job only when its
    owner's epoch is dead.
- **Crons have no ticker.** A run and its next time are one transaction (`cron_jobs/mod.rs:430-760`), so
  crons follow the job rules.
- **Herding.** With 8 nodes racing for the head of the queue on Postgres, 3× the mutation executions were
  wasted and 42 retry budgets exhausted. **Keep the queue loop on the leader**, like Convex's single
  executor, and hand action execution to any node through the same placement as client actions.
  - Under A1, distributing mutation jobs buys nothing: the leader executes them anyway.
- **`nextTs` is wall-clock milliseconds**, read on whichever node schedules. Clock skew on other nodes lets a job
  start early.

| Work | Where |
|---|---|
| Scheduler and cron loops | Leader; action execution anywhere after a fenced, owner-tagged claim |
| Mutation job / cron mutation | Wherever mutations run (the leader under A1) |
| Retention | Leader only: it deletes beneath MVCC, and is fenced |
| Index backfill | Leader, in the background (S5) |
| `_session_requests` / `_scheduled_jobs` cleanup | Leader (idempotent, could be claimed) |
| Catalog reconcile, instance secret | Leader |
| Query cache, subscriptions, per-connection mutation queue | Per node |

- **Failover as apps see it:**
  - **WebSocket mutations stay exactly-once** if three things hold: `_session_requests` commits with the
    mutation, the ack is sent only after the durable flush, and the fence is inside the flush.
  - **Scheduled mutations** mid-run are uncommitted and re-run once.
  - **Actions on the dead leader** become `failed(Transient)`, as after a Convex restart. **Actions on live
    followers** keep running.
  - **HTTP mutations** have no request id: the outcome is in doubt, as on Convex.
- **Design the Phase 3 scheduler now so it can move:**
  - use Convex's data model;
  - start the executor through a `whenLeader(start, stop)` hook; single-node is always the leader;
  - run mutation jobs as one transaction;
  - fence and owner-tag action claims;
  - send every scheduler write through the committer.

### 4.7 More than one core on one machine

- **Processes, not `Worker`s.**
  - Workers share no JS objects, so each needs its own engine anyway.
  - Their IPC is only about 1.5× cheaper, and IPC is already negligible.
  - A crash or out-of-memory error takes all of them down.
  - Processes keep one code path for one machine and for many.
- **One public port:**
  - **Linux** `SO_REUSEPORT` balances per connection. WebSockets stay where they land, so imbalance builds up.
  - **macOS** `reusePort` does **not** balance: one process took 100 % of connections. Bun's `node:cluster`
    relies on it too.
  - A proxy written in Bun is a one-core bottleneck (27k req/s, against 58k for one backend hit directly).
  - Use Linux `reusePort`, or distinct ports behind a **native** proxy (nginx, HAProxy, Caddy).
- **Read scaling is sublinear.** Cached reads measured 1.5× with 2 processes and 1.7× with 6, on a
  saturated shared laptop. Expect about 0.7–0.85× per added core on a dedicated Linux box. That is an
  estimate to re-measure.
- **Topology:**
  - One leader that serves **no public traffic** by default: committer, A1 execution, singletons, on a unix
    socket. N−1 followers take HTTP and WebSockets.
  - On 2 vCPUs, let the leader also take public traffic, behind a flag.
- **SQLite fsync off the JS thread** would help durable SQLite writes more than extra processes.

### 4.8 What does not scale out

- **Memory and SQLite are single-node,** and even there they need the file lock (S1).
- **Horizontal scale needs Postgres, MySQL or MongoDB.** The shared database then bounds writes (its
  group-commit rate) and cache-missing reads, until DB read replicas are used. With replicas, a follower
  must also wait for replica replay to reach its ts.

## 5. Readiness: what to build, in order

**Now: foundations that are worth it even single-node.**

1. **Single-writer safety (S1–S3), a new PERSIST-01 clause C7:**
   - `acquireLease({holder, ttlMs}) → {epoch} | null`, `renewLease()`, `releaseLease()`;
   - `flush()` fails with `LeaseLostError` and leaves nothing visible under a stale epoch;
   - `maxTs()` is O(1) and includes index-only commits;
   - `open({role: "follower"})` never writes, never runs DDL, never recovers;
   - recovery runs only under the lease and is safe against a stale epoch's in-flight writes;
   - an OS lock for SQLite and memory+log;
   - no DDL when the schema already exists, or `lock_timeout`.

   Per driver: Postgres uses the CTE fence; MySQL uses an `UPDATE … WHERE epoch=?` first statement;
   MongoDB uses one of §4.4's two options.

   Conformance tests K10–K18, each with a sabotage check:

   | # | Test |
   |---|---|
   | K10 | A second acquire while the lease is live returns null |
   | K11 | Takeover within TTL + ε after the holder stops renewing; the epoch strictly increases |
   | K12 | A stale flush is refused (delayed-flush hook, and SIGSTOP/SIGCONT); zero old-epoch rows above the new `maxTs` |
   | K13 | A stale flush in flight across the takeover is all-or-nothing and ≤ the new `maxTs` |
   | K14 | A leader paused inside a flush: the takeover completes within a bound |
   | K15 | K6 (crash recovery) under the lease |
   | K16 | `maxTs` covers index-only commits |
   | K17 | A concurrent first boot yields one catalog and one secret |
   | K18 | Release, then an immediate acquire |

2. **The by-ts log read** (STUDY-09 D6) on `indexes`, with its index on every driver. **Built** (2026-10-01): PERSIST-01 C11, `readLog(afterTs, upToTs, limit)`, conformance K25; measured in §4.3.1.
3. **The catalog reloadable** on catalog writes, and the instance secret race-free (K17).
4. **Fix S4 and S5:** a `logStartTs` in the committer; backfill in the background.
5. **Engine hygiene that single-node needs anyway, and scaling needs more:**
   - interval-indexed subscription and cache matching;
   - a time-based OCC window;
   - fewer round trips per remote flush;
   - SQLite writes off the JS thread.
6. **The spike: leader + followers on one machine,** in throwaway code. Numbers already in hand:
   - A1 forwarding: +55 % writes;
   - stream delivery options and their latencies;
   - failover: about the TTL, zero acknowledged writes lost.

   Still to measure:
   - read index;
   - subscriptions on followers with coalescing;
   - reconnect storms;
   - **Linux `reusePort` and per-core scaling on the VPS**.

   Then write SCALE-01.

**Wait for:**

- **Protocol v1 sessions and idempotency** (STUDY-23 steps 2–3, in flight): forwarding and reconnecting to
  another node rely on them. The `visibleTs ≥ T` wait (§4.5) belongs in that work.
- **Auth** (Phase 3): identity in cache and subscription keys (B13) before results are shared across nodes.
- **The scheduler** (Phase 3), built leader-aware from the start (§4.6).
- **Pipelined commit** (the hot-key fix), before A2. It changes how `visibleTs` and the stream work.
- **Sandboxing and limits** (ARCH-01 §6.3): not blocking, but decide "user code on N nodes" and "user code
  in workers" together.

## 6. Divergences and decisions

| # | Divergence or decision | Why | Decision |
|---|---|---|---|
| H1 | Leader + followers for one deployment (Convex self-hosted: one process) | The scaling goal; precedents: Convex Cloud (Usher + funrun), Zero, Firestore | owner |
| H2 | Followers hold WebSockets and serve queries and subscriptions | Same as Convex Cloud's Usher, but followers run queries themselves | owner |
| H3 | Mutations: A1 now; A2 later with Convex's begin-ts protocol | +55 % writes measured with A1; A2 scales execution CPU | owner |
| H4 | Commit stream: leader push + by-ts catch-up on `indexes`; no NOTIFY, logical replication or external bus | Measured (§4.3); self-hosting stays bunvex + DB | owner |
| H5 | The lease expires (TTL on the DB clock) and has a graceful release; no stealing (Convex: newest wins at once, no expiry) | Replicas must not preempt each other; release keeps deploys instant | **Decided (owner, 2026-09-30): as proposed.** A second process fails with `LeaseHeldError` (or waits, `lease.waitMs`); default TTL 5 s. PERSIST-01 C7, #62 |
| H6 | Scheduler loop on the leader; action execution anywhere after an owner-tagged claim | No herding; at-most-once kept | owner |
| H7 | Memory and SQLite stay single-node, protected by a file lock | Their data is in one process or file | **Decided (owner, 2026-09-30): yes** — an exclusive OS lock (#70) |
| H8 | Fix S1–S3 now, before any scaling work | Silent corruption today on every driver | **Decided (owner, 2026-09-30): yes, Postgres first** (#62); MySQL, MongoDB, SQLite and memory follow |
| H9 | A lagging node waits briefly, then refuses `Connect` (Convex refuses at once) | Fewer reconnect round trips; only latency differs | owner |
| H10 | Follower HTTP reads use "read index" (a round trip to the leader) | Keeps self-hosted Convex's read-your-writes for HTTP, actions and scheduled functions | owner |
| H11 | The persisted log is `indexes` by ts, not `documents` + `prev_ts` | bunvex has no `prev_ts`; every commit writes `indexes` rows | **Decided (owner, 2026-10-01).** Built: PERSIST-01 C11 (§4.3.1) |
| H12 | `_creationTime` and `Date.now()` derive from the leader (begin ts / leader clock), not each node's clock | Skew would reorder `by_creation_time` and break `_creationTime ≥ Date.now()` | owner |

## 7. Tests

- **Conformance:** K10–K18 (§5), each with a sabotage check.
- **Multi-node:**
  - Jepsen-style linearizability on a counter and a bank transfer across nodes;
  - read-your-writes after reconnect to a lagging node, and over HTTP via read index;
  - a subscription on a follower sees a write made through another node;
  - a write burst gives one transition per tick;
  - scheduled mutations run once and actions at most once with N nodes;
  - a killed leader loses nothing acknowledged;
  - a killed follower: measure the database load when its clients reconnect.
- **Benchmarks:**
  - single-process against 1 leader + N followers, on one machine and then several, on Linux;
  - reads, subscriptions, fan-out p99, writes under A1 and A2;
  - follower lag and failover time per TTL.

## 8. Open questions

- The lease TTL: failover takes about the TTL. Is 2–5 s acceptable?
- Membership: how does the leader find followers, and followers the leader? Static config, a DB-registered
  node table, or DNS?
- DB read replicas behind followers: worth it, given the extra wait for replica replay?
- A dedicated leader wastes a core on read-heavy apps with 2 vCPUs. Should the default flip by core count?

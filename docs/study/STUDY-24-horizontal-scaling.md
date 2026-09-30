# STUDY-24 — Horizontal scaling

- **Status:** draft — an exploration, not a design. Decisions H1–H8 (§6) await the owner.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend, plus the public post
  [How we horizontally scaled function execution](https://stack.convex.dev/horizontally-scaling-functions)
  (marked **[blog]**).
- **bunvex read at:** `main` @ `080c7f0` (and the unmerged `feat/sync-session` @ `0c40e25` where noted).
- **Related:** ENGINE-00 R1/R5, PERSIST-01, STUDY-06 (OCC, D9 counter ts, D10 log window), STUDY-08 (cache
  and subscriptions), STUDY-09 D6 (no by-ts log read), STUDY-23 (sync protocol v1, `maxObservedTimestamp`).

Why this study exists: one of bunvex's goals is to be **faster than Convex and easy to scale
horizontally**, where self-hosted Convex is one process that cannot run as N replicas. This study
records what Convex does, where bunvex is, the options, and what must exist before anything is built.

## 1. How Convex does it

### 1.1 Self-hosted: one process, one writer

`crates/local_backend/src/lib.rs:157-300` (`make_app`) builds everything in one process:

- the `Database` (committer, snapshot manager, write log, subscriptions);
- V8 through `InProcessFunctionRunner`;
- search through `InProcessSearcher`;
- Node actions through a local Node subprocess (`node_executor/src/local.rs:130-204`);
- the query cache;
- the sync (WebSocket) worker;
- every background worker.

A second replica does not share load, because of the **persistence lease** (`crates/postgres/src/lib.rs:1745-1800`):

- The comment says: "one can coordinate all writes and the others can serve stale reads."
- Acquiring the lease is `UPDATE leases SET ts=$1 WHERE id=1 AND ts<$1`, so the newest process wins (`sql.rs:746-755`).
- Every write transaction first runs `SELECT … FOR SHARE` on the lease (`sql.rs:721-730`).
- The loser gets `LeaseLostError` and shuts down (`common/src/errors.rs:832-837`).
- MySQL has the same mechanism.

Two replicas therefore take the lease back and forth, and one of them shuts down each time.

### 1.2 The write path is a single in-memory task

- **One task.** `Committer::start` spawns one `"committer"` task (`crates/database/src/committer.rs:295-352`).
- **Parallel around it.** Pre-validation and persistence writes run in parallel around that task:
  - `COMMITTER_MAX_CONCURRENT_PRE_VALIDATIONS` = 32;
  - `…_WRITE_BATCHES` = 16;
  - `…_COMMITS` = 512.
- **Serial inside it.** Timestamp assignment and final OCC validation happen in the task itself.
- **Timestamps.** `next_commit_ts` is `max(latest_snapshot_ts+1, wall clock, last_assigned_ts+1)` (:1387-1399). It is in memory and correct only because there is one writer.
- **OCC.** The read set is checked against the in-memory `WriteLog` and the `PendingWrites` (:888, :1007).
  - The write log keeps recent commits for 30–300 s, capped by size (`knobs.rs:869-884`).
  - The snapshot window is `MAX_TRANSACTION_WINDOW` = 10 s.
- **Followers.** After a commit is durable, `bump_max_repeatable_ts` persists a `MaxRepeatableTimestamp` global "so … followers can know this timestamp is repeatable" (:807-870).

### 1.3 Reads can leave the writer; subscriptions cannot

- **Read replicas are in the design.** `FollowerRetentionManager` (`retention.rs:1658-1730`) and `new_static_repeatable_recent` (`common/src/persistence/mod.rs:862`) let a non-writer read persistence at the published `max_repeatable_ts`.
- **Query cache.** It lives in the process: 100 MiB by default, or 1 GiB shared across tenants in cloud (`knobs.rs:67-73`). A cached result stays valid by *refreshing its read-set token* against the write log (`write_log.rs:623-700`), not by eviction.
- **Subscriptions.** `SubscriptionsWorker` (`subscription.rs:258-310`, `advance_log` :492) intersects each new write-log entry with the subscribed read sets, and the sync worker lives in the backend process (`local_backend/src/subs/mod.rs:245, 429-471`).
  - No feed carries commits to other nodes.
  - So only the writer's process can serve subscriptions.

### 1.4 How Convex Cloud scales

Convex scales **around** one stateful backend per deployment; it never splits it.

- **Funrun** runs queries, mutations and actions. It is multi-tenant, uses rendezvous hashing for cache locality, and reads a snapshot directly from the database.
  - It hands the mutation's reads and writes back to the backend, which validates and commits them (`FunctionFinalTransaction`, `function_runner/src/lib.rs:150`).
  - It was built because V8 capped one backend at about 128 concurrent functions **[blog]**.
  - The `FunctionRunner` trait (`function_runner/src/lib.rs:84`) is open. The remote client and server are not.
  - `UDF_USE_FUNRUN` defaults to true (`knobs.rs:1305-1307`).
- **Other services:**
  - **Searchlight** handles search. Its gRPC protocol is open, the service is not.
  - **AWS Lambda** runs Node actions.
  - **Usher** is a routing proxy (`knobs.rs:1813-1820`).
  - **Conductor** is the backend, multi-tenant across deployments.
- **What stays single.** The committer, the WebSocket sync, subscriptions and every background worker stay on the one backend. These singletons include:
  - index backfill;
  - search flush and compaction;
  - table summaries;
  - retention;
  - the scheduler and crons;
  - exports and imports.

  They are started in `application/src/lib.rs:769-947` and `database.rs:1071-1103`.
- **What is not there.** No sharding and no multi-writer exists for a single deployment, in the open code or in the blog.

### 1.5 Execution limits (relevant to "V8 limits things")

| Limit | Value |
|---|---|
| Heap | 64 MiB + 32 MiB |
| Queries / mutations | 1 s user time, 15 s system time |
| V8 actions | 1800 s user time |
| Node actions | 600 s |
| Isolate workers per backend (pool) | 300 |
| `APPLICATION_MAX_CONCURRENT_QUERIES` / `…_MUTATIONS` | 16 / 16 |
| `…_V8_ACTIONS` / `…_NODE_ACTIONS` | 64 / 64 |

Sources: `knobs.rs:984-1169`. These caps, not the database, are what limit a self-hosted backend under load.

## 2. What an app can observe

Scaling must not change the contract. These are the guarantees a multi-node bunvex must keep, all already
specified elsewhere:

- **Serializable mutations.**
  - OCC over the whole deployment, with no cross-shard anomalies (STUDY-06).
  - Convex's retry budget and error (STUDY-21).
- **Consistent queries.** A query and a subscription result reflect one snapshot at one ts, and all queries of a transition advance together (STUDY-23).
- **Read-your-writes across reconnects.** After a mutation returns at ts T, the next query and subscription reflect ts ≥ T.
  - The client carries `maxObservedTimestamp`.
  - A backend that is behind must not answer it; Convex's parity row calls this linearizability across backends (`client-sync.md:92`, STUDY-23).
- **Mutation order per connection** (STUDY-22) and **exactly-once per request id** (STUDY-23 P5, `_session_requests`).
- **Scheduled jobs and crons** run once.
- **Not observable, so free to change:** the process topology, which node ran a function, how commits reach other nodes. Subscription latency may differ.

## 3. How bunvex does it today

bunvex is strictly single-process, single-node. ENGINE-00 R5 says so and defers "replicas fed by the
commit log" to a later spec (`docs/specs/ENGINE-00-requirements.md:94-95`). Everything below is in one
Bun process:

| State | Where | Notes |
|---|---|---|
| Commit ts | `Committer.appliedTs`, `++` per commit (`packages/core/src/committer.ts:176`) | seeded from `persistence.maxTs()` at open; a counter, not wall clock (STUDY-06 D9) |
| Visible ts | `Committer.visibleTs` | advances after `flush()` |
| OCC write log | `log: LogEntry[]`, last 20 000 commits (`committer.ts:89,182`) | a snapshot older than the log is a conflict (D10) |
| Catalog | `Engine` (`engine.ts:74`) | loaded at init; extended locally on table creation |
| Instance secret | generated and stored if absent (`engine.ts:135-147`) | first-boot race if two processes start |
| Query cache | process `Map`, 1000 entries FIFO (`engine.ts:79,203-240`) | invalidated by scanning each commit's writes |
| Subscriptions | `Subscriptions` `Map` (`subscriptions.ts:35-60`); `SyncHub` on `feat/sync-session` | fed by `committer.onCommit`, in process only |
| Data (memory driver) | maps + B-trees, log replayed at open | cannot be shared |

- **User functions run in the server's own realm.** Determinism is patched in, but "This is not a sandbox" (`determinism.ts:1-13`). There are no time or memory limits yet (parity: missing), and sandboxing is an open decision (ARCH-01 §6.3).
- **Two processes on one database: nothing detects it.**
  - PERSIST-01 has no lease and no fencing.
  - Both processes seed their counter from the same `maxTs` and hand out the same timestamps.
  - Neither OCC log sees the other's writes, so updates are lost, and snapshots stop being immutable.
  - The two catalogs can allocate the same table number.
  - Unique keys catch only exact `(key, ts)` collisions, and those make the flush fail and stop the process.
  - **MongoDB is destructive:** at open it deletes every row above the commit marker (`packages/persistence/src/mongodb.ts:43-46`), which wipes the other process's in-flight group.

  This is a safety bug today, independent of any scaling plan.
- **Where the ceiling is.**
  - The VPS end-to-end numbers are bound by HTTP and CPU on 2 vCPU (`docs/bench/E2E-VPS-2026-09-29.md:58`).
  - The engine alone commits 14–42k/s (`docs/bench/ENGINE-00-microbench.md`).
  - Bun runs JS on one thread, so **one bunvex process uses about one core**.
  - The weak spot is a single hot key (about 130–220/s on remote stores). That is a commit-pipelining problem, not a scaling one (`E2E-VPS:59-63`).

## 4. Options

The components below are independent choices. For each, the options, pros and cons, and a recommendation.

### 4.1 Who commits: one leader, several, or the database

| | A. One leader, many followers (recommended) | B. Sharded committers | C. The database commits (every node writes, e.g. Postgres SERIALIZABLE) |
|---|---|---|---|
| Semantics | Same as Convex: one ts order, one OCC log | Cross-shard mutations need 2PC or break serializability; ts order per shard only | Serializable, but conflict rules become the DB's, not Convex's (retries, error shapes, read-set granularity differ) |
| Write ceiling | One process: 14–42k commits/s in-engine; far above Convex (~430/s here) | Scales with shards | The DB's; loses group commit and in-memory OCC, the reason bunvex is fast |
| Complexity | Leader election + commit stream | Very high (placement, rebalancing, distributed txns) | Medium, but subscriptions still need a change feed |
| Convex parity | Matches Convex Cloud's own model | Divergent | Divergent |

**Recommendation: A.**
- The writer is not the bottleneck; function execution, HTTP, WebSockets and reads are.
- Convex itself never split the writer.
- B and C give up the two things that make bunvex bunvex: Convex's semantics and in-memory OCC.

### 4.2 Where mutations run

- **A1. Forward the whole mutation to the leader, which runs it.** Simplest, with no new protocol. The leader's one core does all mutation execution.
- **A2. Run on any node, commit on the leader.** This is funrun's model.
  - The node executes at its snapshot, then sends the read set, write set and snapshot ts to the leader.
  - The leader validates against its write log and commits.
  - The leader does only validation, ts assignment and persistence. The OCC window must cover follower lag.

**Recommendation:** A1 first, A2 once measured. A2 is the step that scales write-heavy workloads.

### 4.3 How commits reach followers (the commit stream)

A follower needs, per commit:
- the ts;
- the index-key writes, to invalidate its cache and subscriptions and to validate A2 mutations.

It reads documents from persistence at its snapshot. Options:

| Option | Latency | Infra | Notes |
|---|---|---|---|
| a. Poll persistence by ts | poll interval | none | Needs a by-ts read (STUDY-09 D6); robust catch-up |
| b. DB notify + read: Postgres `LISTEN/NOTIFY`, Mongo change streams, MySQL binlog | low | none extra | Per-driver; MySQL binlog is heavy; still needs (a) for catch-up |
| c. Leader pushes over a socket to followers | lowest | membership/discovery | Carries write sets directly; needs (a) for gaps and new followers |
| d. External bus (NATS, Redis Streams, Kafka) | low | a new service to run | Easy fan-out, but one more thing to self-host |

**Recommendation:** (c) for latency, with (a) as the source of truth for catch-up.
- The persisted log is authoritative, and the push is only a hint.
- It keeps self-hosting to "bunvex + your database".
- (b) is a good driver-level optimization later.

### 4.4 Leadership and fencing

- **The mechanism: a lease with an epoch, in the database.** Every write carries the epoch (a fencing token), and a stale leader's writes are refused.
  - Postgres: an advisory lock or a lease row, like Convex's.
  - MySQL: a lease row.
  - MongoDB: a lease document with a conditional update.
  - SQLite and the memory driver: single-node only.
- **Failover.** A standby that tails the stream takes the lease, then:
  - rebuilds `maxTs`, the recent write log (needs the by-ts read) and the catalog;
  - starts committing.

  Writes pause for roughly the lease timeout; reads keep working on followers.
- **Unlike Convex,** the newest process should not steal the lease, because that is what makes Convex's replicas thrash. Followers should wait for expiry.

### 4.5 Reads, cache and subscriptions on followers

- **Snapshot.** Each node has its own `visibleTs`, the last ts it received and which is known durable.
- **Queries** run locally at that snapshot. The **cache** is per node and invalidated by the stream.
  - Optionally, route by `hash(function, args)` for cache locality, which is Convex's rendezvous idea.
- **WebSockets** terminate on any node. The node's `SyncHub` is fed by the stream.
- **`maxObservedTimestamp`** makes reconnecting to another node safe. A node behind the client's ts waits or refuses, which is already in STUDY-23.
- **Per-connection mutation order** (STUDY-22) is local to the node that holds the socket.

### 4.6 Singletons: scheduler, crons, retention, backfill

- **Option 1: run them on the leader.** Simple, and the same as Convex.
- **Option 2: distribute job execution.**
  - Claiming a job is itself a mutation, so OCC guarantees one winner, and any node can run jobs.
  - Cron *ticking* and retention stay on the leader.

**Recommendation:** leader first; distributed claiming when the scheduler is built (Phase 3). Design the scheduler with it in mind.

### 4.7 Using more than one core on one machine

- A Bun process runs JS on one thread, so using more cores **is the same problem** as using more machines: N processes (or `Worker`s, which share no JS objects) behind one port.
- The leader/follower design gives multi-core for free: run 1 leader and N−1 followers on one box.
- It is also the cheapest place to test the design: one machine, no network partitions.

### 4.8 What does not scale out

- **The memory driver.** Its dataset is inside the leader, so it is single-node.
- **SQLite.** Single-node, unless replicated underneath (e.g. LiteFS). That is out of scope.
- **Horizontal scale needs a shared database:** Postgres, MySQL or MongoDB. That database then becomes the capacity limit for reads that miss the cache, which is why follower caches and read replicas of the DB matter later.

## 5. Readiness: what exists, what is missing, what order

**Can start now.** These are foundations, and each is useful even single-node:

1. **Single-writer safety (a bug today).**
   - Add a lease + epoch to PERSIST-01 and all drivers, and refuse to open a database another process holds.
   - Fix MongoDB's recovery delete to run only under the lease.
   - Conformance tests: two opens, then the second fails; a stale epoch's write is rejected.
2. **The by-ts log read** (STUDY-09 D6): read commits in `(from, to]` with their index-key writes. Retention, backfill, export and write-log rebuild all need it too.
3. **Catalog and secret re-derivable from the database:** reload `_tables`/`_index` on a stream event. Pin the instance secret with configuration or a race-free first write.
4. **A spike:** one leader and one read-only follower process on one machine.
   - The follower tails by polling, serves cached queries and subscriptions, and forwards mutations (A1).
   - Measure throughput and subscription latency against single-process.
   - Throwaway code; the output is numbers.

**Better to wait for:**

- **Protocol v1 sessions and idempotency** (STUDY-23 steps 2–3, in flight). Forwarding mutations and reconnecting to another node rely on `maxObservedTimestamp`, request ids and `_session_requests`.
- **Auth** (Phase 3). Cache and subscription keys must include identity (B13) before results are shared across nodes.
- **Scheduler and crons** (Phase 3). Build them leader-aware from the start, rather than retrofitting.
- **Execution limits and sandboxing** (ARCH-01 §6.3). They are not blocking, but "run user code on N nodes" and "run user code in workers" should be one decision.
- **Pipelined commit** (the hot-key fix). It changes the committer's inner loop; do it before A2, so A2 is designed against the final committer.

**Suggested order:**

1. Lease/fencing.
2. The by-ts log read.
3. The spike.
4. A spec (SCALE-01) from the spike's numbers.
5. Leader + followers with A1.
6. Failover.
7. A2 after pipelined commit.

## 6. Divergences

Convex self-hosted is single-node; Convex Cloud scales execution but keeps one backend. Every item here is
a place where bunvex would differ from self-hosted Convex. None changes what an app can observe (§2), if
done as described.

| # | Divergence | Why | Decision |
|---|---|---|---|
| H1 | Leader + follower nodes for one deployment (Convex self-hosted: one process) | The goal of horizontal scale | owner |
| H2 | Followers serve queries, subscriptions and WebSockets (Convex: only the backend) | Scale reads and connections | owner |
| H3 | Mutations run on any node, committed by the leader (A2) — later | Scale write-heavy CPU; like funrun, but open | owner |
| H4 | Commit stream: leader push + persisted-log catch-up (no external bus) | Keep self-hosting to bunvex + database | owner |
| H5 | Lease never stolen by a newer process; followers wait for expiry (Convex: newest wins) | Replicas must not thrash | owner |
| H6 | Singletons on the leader; job execution claimable by any node (later) | Scheduler throughput | owner |
| H7 | Memory and SQLite drivers stay single-node | Their data lives in one process or one file | owner |
| H8 | Fix the single-writer safety bug now, before any scaling work | Two processes silently corrupt data; Mongo deletes | owner |

## 7. Tests

- **Conformance.**
  - A second open on a held database fails.
  - A write with a stale epoch is rejected.
  - Crash recovery still holds under the lease.
- **Multi-node.**
  - Linearizability of mutations across nodes: a Jepsen-style history check on a counter and a bank transfer.
  - Read-your-writes on reconnect to a lagging node.
  - A subscription on a follower sees a write committed through another node.
  - A scheduled job runs exactly once with N nodes.
  - A leader killed mid-group loses nothing acknowledged.
- **Benchmarks.** Single-process against 1 leader + N followers on one machine, then on several:
  - read and subscription throughput;
  - fan-out p99;
  - write throughput with A1 and A2;
  - follower lag.

## 8. Open questions

- The lease timeout against failover time: how long may writes pause?
- Stream membership: static configuration, DB-registered nodes, or DNS?
- Should followers also read from DB read replicas? Then the replica lag and the follower's `visibleTs` must agree.
- A2's validation window: how far behind can a follower's snapshot be before its mutations always conflict?

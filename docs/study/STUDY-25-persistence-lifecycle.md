# STUDY-25 — Persistence lifecycle: open, schema, timeouts, retries, shutdown

- **Status:** accepted. L1–L12 (§4) decided by the owner: L9 and L10 on 2026-09-30, the rest on 2026-10-01
  ("approve all recommendations"). L1, L3 (#107, §3.4), L4 and L5 (#112, §3.5; DV-123, DV-124) are done; L6–L8 are to be built.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend. **Convex run:** the self-hosted
  binary `precompiled-2026-09-26-27ef234` (native arm64) against a throwaway Postgres 17 and SQLite, on
  30 Sep 2026.
- **Related:** STUDY-09 (persistence layout: tables, keys, scans — not repeated here), PERSIST-01 v2 (C7,
  single writer), STUDY-24 (S1–S5), #62 (the lease, Postgres).

**Why this study exists.** bunvex's drivers were written before the rule "study Convex first". STUDY-09
covered what they store. It did not cover how they open a store, create and version the schema, time
out, retry, or shut down. Several of the bugs STUDY-24 found (S1, S3) lived in exactly that code.

## 1. How Convex does it

### 1.1 Opening a store

**Driver and database name**

- The driver is chosen by configuration, not stored in the database: `sqlite`, `postgres-v5`,
  `mysql-v5`, `mysql-v5-multitenant`, `mysql-v6-multitenant` (`crates/clusters/src/db_driver_tag.rs:17-47`).
- **Self-hosted Postgres:**
  - The database name is derived from the instance name, `-` → `_` (e.g. `convex_self_hosted`), and the URL
    must not name a database (`crates/clusters/src/lib.rs:53-66`).
  - `sslmode=require` and `target_session_attrs=read-write` are added (`:39-50`); `DO_NOT_REQUIRE_SSL`
    turns SSL off.
  - The operator creates the database (`self-hosted/advanced/postgres_or_mysql.md:53-64`).
- **MySQL** selects the database per connection. With `require_leader`, every new connection checks
  `@@global.innodb_read_only OR @@global.read_only` (`crates/mysql/src/connection.rs:670-690`).

**Pools**

| | Postgres (`crates/postgres/src/connection.rs:455-617`, `knobs.rs:1249-1263`) | MySQL (`connection.rs:653-665`) |
|---|---|---|
| Max connections | 128 | 128 (min 0) |
| Idle connections closed after | 90 s | 90 s |
| Other | 128 cached statements | lifetime 600 s with jitter |

- **Session settings:** none. No `statement_timeout`, `lock_timeout`, `application_name` or
  `idle_in_transaction_session_timeout`.
- **Isolation:** the server default. Postgres uses READ COMMITTED; MySQL uses REPEATABLE READ, and READ
  COMMITTED for retention deletes.

**Schema creation**

- **Postgres** (`crates/postgres/src/lib.rs:294-336`, `sql.rs:43-257`):
  - Every object is created inside a `DO $$ … IF to_regclass('x') IS NULL THEN CREATE … END IF $$` block.
  - The comment says why: even a no-op `CREATE … IF NOT EXISTS` takes an ACCESS EXCLUSIVE lock.
  - Tables: `documents`, `indexes`, `leases`, `read_only`, `persistence_globals`.
  - The statements run one by one, outside a transaction. Concurrent first starts are not serialized.
- **MySQL** creates the schema only when tables are missing:
  - v5 counts tables in `INFORMATION_SCHEMA` (`v5/persistence.rs:157-173`, citing MySQL bug 63144).
  - v6 checks a sentinel table, and refuses to initialize over a v5 or unversioned database
    (`v6/persistence.rs:207-270`).
- **SQLite** runs `CREATE TABLE/INDEX IF NOT EXISTS` on every open (`crates/sqlite/src/lib.rs:92-106`).

**Versioning.** No version row is stored.

- The layout version (V5/V6) comes from configuration (`common/src/types/mod.rs:175-197`).
- The layout evolves in place through guarded, idempotent DDL, e.g. adding a primary key if
  `documents_pkey` is missing (`sql.rs:87-99, 153-164`).
- `persistence_globals` holds `max_repeatable_ts`, bootstrap ids and table summaries.

**Startup order** (`postgres/src/lib.rs:299-345`, `database/src/database.rs:1043-1090`):

1. The guarded DDL.
2. If `read_only` has a row, refuse to start (`ConnectError::ReadOnly`, "data migration in progress").
3. `is_fresh` = `documents` is empty.
4. Take the lease: `UPDATE leases SET ts = now_ns WHERE id = 1 AND ts < now_ns`. It always succeeds; the
   newest process wins.
5. Initialize system tables if fresh, write `max_repeatable_ts` under the lease, load the snapshot, and
   check `snapshot_ts == max_ts`.

### 1.2 Timeouts and retries

- **Timeouts are on the client side** (`crates/postgres/src/connection.rs:108-135`, `knobs.rs:1197`):
  - Postgres wraps every call in 30 s (`POSTGRES_TIMEOUT_SECONDS`); MySQL uses 19 s (`MYSQL_TIMEOUT_SECONDS`).
    Both are environment variables read once (`env_config`).
  - **"Every call" is every round trip:** getting a pooled connection (which includes opening a new one,
    `connection.rs:553`), `BEGIN`, each statement or prepare, each row of a streamed result
    (`wrap_query_stream`, `:335-341`), and `COMMIT` (`:447`). A transaction of N statements can therefore take
    up to N timeouts; no single wait exceeds one. MySQL is the same (`mysql/src/connection.rs:143-153`, call
    sites `:352-614`, pool `:722`).
  - The error is `DatabaseTimeoutError` ("Database Timeout (Postgres)", `common/src/errors.rs:841`), an
    *operational* internal error, and transient (`is_transient_db_error`, `:857`).
  - A timeout or a closed connection **poisons** the connection, so it is never reused
    (`handle_error`, `postgres/src/connection.rs:209-220`; `Drop` does not return a poisoned connection to
    the pool, `:382-397`). MySQL never retries after a timeout and discards the connection, because "the
    mysql protocol doesn't support cancellation" (`mysql/src/connection.rs:280-318`; it is disconnected in
    the background, since disconnecting can hang too).
  - **Exception:** deferred `CREATE INDEX` statements at startup run without a timeout
    (`batch_execute_no_timeout`, `postgres/src/lib.rs:887-903`).
  - **MongoDB:** Convex has no MongoDB driver, so there is nothing to match; bunvex follows the Postgres
    driver (§3.4).
- **Transient errors** (`is_transient_db_error`, `common/src/errors.rs:855-859`) are a
  `DatabaseTimeoutError` or a `DatabaseOperationalError`. Which errors are "operational" depends on the
  driver:
  - **MySQL** (`classify_mysql_error`, `mysql/src/connection.rs:88-118`, applied to every call by
    `with_timeout`, `:143-153`): the pool disconnected, the connection closed, any IO error, and the server
    codes 1290 (read-only), 2013 (server lost), 1053 (shutdown), 1040 (too many connections), plus 1105 with
    four Vitess messages.
  - **Postgres:** nothing. The Postgres driver never calls `database_operational_error` (it is used only in
    `crates/mysql`), so on Postgres **only a timeout is transient**. A connection that closes in the middle of
    a write is a plain error.
  - Serialization failures, deadlocks and lock-wait timeouts are not classified anywhere; with one writer they
    are not expected.
  - `LeaseLostError` is an operational *internal server error* (`:833-837`), but not a
    `DatabaseOperationalError`: it is not transient.
- **Retries of reads and init (once, on a fresh connection):**
  - **Postgres** (`with_retry`, `postgres/src/connection.rs:236-264`): the call runs once more if it
    *poisoned* its connection, i.e. the connection closed or the call timed out (`handle_error`, `:209-220`).
    The retry takes a new connection, not a pooled one, "in case other pooled connections are also stale"
    (`:259-261`). Never after a statement was prepared (the comment at `:239-241`). So a read can wait two
    timeouts.
  - **MySQL** (`handle_errors_with_retries`, `mysql/src/connection.rs:280-318`): an operational error is
    retried up to `MYSQL_MAX_QUERY_RETRIES` = 1 time (`knobs.rs:1245-1246`) on another connection, for the
    read calls (`query_optional`, `query_collect`, `:362-447`). **A timeout is never retried** ("we want the
    caller to receive some backpressure", `:291-299`); its connection is discarded. `execute_many` (DDL)
    uses 0 retries (`:326-345`).
  - **Opening a write transaction on Postgres** (`transact`, `postgres/src/lib.rs:1822-1846`): `BEGIN` is
    retried once on a fresh connection if the connection was poisoned. Once the transaction began, nothing
    inside it is retried.
- **Retries of commit writes** (`write_batch`, `database/src/write_batcher.rs:205-246`):
  - A failed `persistence.write` that is transient is retried, as many times as it takes: **there is no
    limit** on the number of attempts or on the total time. The commits of the batch wait.
  - Between attempts, a full-jitter exponential backoff: `min(initial · 2^failures, max) · random()`
    (`Backoff::fail`, `convex/sync_types/src/backoff.rs:34-44`), with `INITIAL_PERSISTENCE_WRITES_BACKOFF_MS`
    = 100 and `MAX_PERSISTENCE_WRITES_BACKOFF_MS` = 10 000 (`knobs.rs:2083-2091`). Each failure is logged
    ("Failed to write to persistence because database timed out") and reported.
  - A retry writes the same batch (same documents, same timestamps) with `ConflictStrategy::Error`.
  - Any other error ends the loop. The committer then stops with the error's context "Write failed. Unsure if
    transaction committed to disk." (`committer.rs:440`) — whatever the error, since a failed write may or
    may not have landed. The process restarts and recovers.
  - **Ambiguous commits:** if an attempt did commit but its client saw an error (the answer to COMMIT was
    lost, or came after the timeout), the retry inserts rows that exist already: a duplicate key on the
    primary key of `documents` or `indexes`, which is not transient. The committer stops as above, and the
    store holds the batch exactly once.

### 1.3 Shutdown

- **Only SIGINT is handled** (`crates/local_backend/src/main.rs:208`): drain HTTP, then
  `Application::shutdown` → `Database::shutdown` → the committer task is **aborted** (`committer.rs:1573`).
  A second Ctrl-C forces the exit.
- **SIGTERM is not handled.** `run_backend.sh` `exec`s the binary, so `docker stop` kills it at once, and
  Convex relies on crash-safety.
- **In-flight commits** are aborted: the caller gets an error, and the write may or may not have landed.
- **Nothing is released.** The lease row stays; the next process takes it anyway.

### 1.4 SQLite

- No pragmas are set: the rollback journal (`DELETE`), `synchronous=FULL`, one connection behind a mutex.
- **Nothing stops a second process** from opening the same file.

### 1.5 Measured on the real binary

Throwaway runs, 30 Sep 2026:

| Scenario | Result |
|---|---|
| **Two processes on one SQLite file** | Both start, with no warning. **419 of 1,402 acknowledged increments were lost.** The same commit ts was given to different commits of the two processes. There were crashes on `UNIQUE constraint failed: documents.ts, …`. A document created through one process was invisible to the other (`db.get` null ×1000), and functions deployed through one were missing on the other. `unique()` invariants broke. **Convex has STUDY-24 S1 on its default store.** |
| **Two processes on one Postgres** | The newest takes the lease; an old process that is writing dies within milliseconds (`Lease Lost`). No acknowledged write was lost across three handoffs. **An idle old process keeps serving stale queries and subscriptions:** 5 min 27 s in one run, until a table-summary checkpoint hit the lease. The bound depends on which background write comes first: retention (~60 s, only after recent commits), table summaries (≤10 min), the `max_repeatable_ts` idle bump (1–2 h). |
| **Old process paused (SIGSTOP) holding `FOR SHARE` on the lease row** | The new process's lease `UPDATE` blocks. It gives up after the 30 s client timeout and exits, but **its UPDATE stays queued in Postgres**. When the old process resumes, its commit completes, then the orphaned UPDATE applies and the old process dies with `Lease Lost`. **No live backend remains**, and the outage lasts until a manual restart. |
| **Startup DDL while the old process is paused (STUDY-24 S3)** | **No wedge.** The guarded DDL runs nothing on an existing schema; the only wait was the lease `UPDATE`. |

## 2. What an app can observe

- **Nothing on the happy path.** How a store is opened, versioned, timed out or shut down is invisible to
  functions and clients.
- **Operators observe:**
  - which configuration is accepted (URL, database name, SSL);
  - what happens with two processes on one store;
  - how long a hung database stalls the process;
  - whether a network blip kills it;
  - how a deploy hands over;
  - whether an incompatible store is refused.
- **Clients observe only side effects:** an outage, lost writes (a bug), stale reads from a deposed
  process.

## 3. How bunvex does it

### 3.1 Opening a store

- **The Postgres driver since #62** (`packages/persistence/src/postgres.ts`):
  - DDL runs only when a table is missing (`to_regclass`), in one transaction, under
    `pg_advisory_xact_lock` and `lock_timeout 10s`.
  - Each connection sets `application_name = bunvex-<random>` and `idle_in_transaction_session_timeout = 2.5 s`.
  - The lease (PERSIST-01 C7) is taken before `maxTs()`.
- **The MySQL driver** runs two unguarded `create table if not exists` on every open.
- **The MongoDB driver** runs three `createIndex` on every open, and deletes every row above the commit
  marker, with no lease.
- **SQLite** uses WAL, `synchronous=FULL|OFF`, no `busy_timeout` and no exclusive lock.
- **memory+log** opens its log file with no lock.
- **All drivers:**
  - The URL is used as given; there is no database-name derivation and no SSL default.
  - Pools are 16.
  - No layout version is stored and none is checked.

### 3.2 Timeouts, retries, shutdown

- **Timeouts on database calls** (L3): before §3.4 there were none (except `lock_timeout` in the Postgres
  bootstrap and lease acquisition), and a hung connection hung startup, a query or a commit forever.
- **Any flush error was fail-stop at once** before §3.5: the committer stopped and the server exited
  (`committer.ts`, `server.ts`), with no retry of transient errors and no retry of reads.
- **Shutdown:**
  - `Engine.close()` waits for the committer to go idle, releases the lease and closes the store.
  - `server.shutdown()` calls it. `bench/server.ts` calls it on SIGINT and SIGTERM.
  - The product CLI does not exist yet.

### 3.3 Where bunvex already differs by design (#62)

- **A live lease is never taken** (STUDY-24 H5): a second process fails with `LeaseHeldError`.
- **A deposed process stops within one renewal** (TTL/3, about 1.7 s). It cannot keep serving stale data
  for minutes or hours.
- **Waiting for a paused holder is bounded by the server** (`lock_timeout 1s`), so no orphaned UPDATE can
  remain. An expired holder paused mid-flush has its sessions ended (conformance K13/K14).

### 3.4 Timeouts on database calls (L3, as Convex)

- **Every remote driver bounds every database call on the client side, per round trip**
  (`withTimeout` in `@bunvex/core/persistence`; `progress()` re-arms the timer after each round trip of a
  transaction, so a transaction is bounded per statement as in Convex). The call rejects with
  `DatabaseTimeoutError` ("Database Timeout (Postgres): no answer within 30000 ms").
- **Values, as Convex:** Postgres 30 s, MySQL 19 s. MongoDB 30 s (no Convex counterpart; the MongoDB
  driver's own defaults for connecting and server selection are 30 s too). Each is an open option
  (`timeoutMs`; 0 disables it), and the server reads `POSTGRES_TIMEOUT_SECONDS` and `MYSQL_TIMEOUT_SECONDS`
  (Convex's names) and `MONGODB_TIMEOUT_SECONDS`.
- **A timed-out connection is never reused:**
  - **MySQL:** the connection is destroyed (out of the pool, socket closed), as Convex.
  - **Postgres:** postgres.js does not expose its connections, so **the whole pool is retired**: the next
    calls go to a fresh pool, calls already running on the old one may finish, and whatever still waits
    after one more timeout is destroyed. Convex drops only the one connection (it does reconnect with a
    fresh connection on retry "in case other pooled connections are also stale"). **Divergence, pending:**
    healthy idle connections are reopened after a timeout (DV-122).
  - **MongoDB:** the driver's `socketTimeoutMS` (= the timeout) closes a connection that waits longer for an
    answer; `connectTimeoutMS`, `serverSelectionTimeoutMS` and `waitQueueTimeoutMS` bound the other waits.
    A guard around each call is still needed: the driver retries a timed-out read (`retryReads`) and a
    transaction (`withTransaction`, for up to 120 s) on its own. (The driver's `timeoutMS` would cover all
    of it, but it is experimental.)
- **Connecting** is bounded too: postgres.js `connect_timeout` (whole seconds), mysql2 `connectTimeout`.
  `open()` (bootstrap DDL) and `close()` are bounded by the same timeout.
- **A flush that times out is fail-stop**, unchanged: the committer stops and the process exits, as on any
  flush error. That is what Convex does for a commit in doubt (its write retries end in "Unsure if
  transaction committed to disk" when the commit may have landed).
- **The lease (bunvex's own, L10 / DV-14)** needs two more rules, recommended here for the owner:
  - **A renewal is bounded by a quarter of the TTL** (or the call timeout, if shorter; `renewTimeoutMs`).
    With a 5 s TTL and a 30 s call timeout, a renewal stuck on a dead connection would otherwise wait 30 s
    while the lease expires after 5 s. The engine renews every TTL/3, so a stuck renewal has failed, and
    its connection is gone, before the next renewal is due; that one runs on a fresh connection, and the
    lease survives one dead connection.
  - **The engine stops when a renewal is still pending at the TTL** (before, only a *failed* renewal past
    the TTL stopped it, and a renewal that never returned kept a deposed process serving). This holds for a
    third-party driver without timeouts too.
- **Tests:** conformance **K20** (a freezable TCP proxy between the driver and the real store; §5) and
  `packages/core/test/timeout.test.ts`, `lease.test.ts` (a renewal that never returns).
- **Not in this change** (follow-ups, built in §3.5): retrying a flush after a transient error (L4),
  retrying a read once on a fresh connection (L5).
- **Superseded by §3.5:** a flush that times out is no longer fail-stop; it is transient and retried.

### 3.5 Retries of transient errors (L4, L5, as Convex)

**Where the policy lives.** The retry loop of a flush is in the committer (`flushWithRetries`,
`packages/core/src/committer.ts`), around `persistence.flush()`; the classification is the driver's (a new
optional `Persistence.isTransient(e)`). Reasons:

- One policy for every driver, as Convex's write batcher is one loop above every `Persistence`: the
  backoff, its options, the logging, and how the loop ends when the committer stops (a lost lease) are
  written once.
- The committer already holds the group (its commits wait for the flush), so a retry costs no copy.
- Only the driver knows which of its errors mean "the connection is gone" or "the server is not serving".
- The embedded drivers (memory, SQLite) do not implement `isTransient`: any flush failure stays fail-stop.

**Flush retries (L4).**

- A flush that fails with an error the driver calls transient is retried with Convex's backoff: full jitter
  over `min(100 ms · 2^n, 10 s)`, as many times as it takes (`Engine` option `flushRetry`:
  `initialBackoffMs`, `maxBackoffMs`, `onRetry`; each retry is logged by default). Anything else stops the
  committer with "write failed, unsure if the group committed to disk: …" (Convex's context).
- **The same group, behind the same fence.** A driver that fails a flush keeps the group: the next `flush()`
  writes the same rows at the same timestamps, and its first statement is the lease fence again (PERSIST-01
  C7). A `LeaseLostError` is not transient: fail-stop at once. The commits of the group (and every commit
  queued behind it) wait; nothing becomes visible until the flush lands.
- **No limit on the attempts, as Convex.** In practice the lease bounds them: while the store does not
  answer, lease renewals fail too, and the engine stops the committer once the TTL (5 s by default) passes
  without a renewal. A stop wakes the backoff, so the group's commits are refused at once.
- **What each driver calls transient:**

| Driver | Transient in a flush | Reads and init: one more run, on a fresh connection, after | Ambiguous commit (the first attempt landed) |
|---|---|---|---|
| Postgres | A timeout or a lost connection (**DV-123**, owner 2026-10-01; Convex: only timeouts, so a connection lost inside a write is fatal there). A connection lost **before** the transaction began is also retried once inside the flush, on a fresh pool (Convex's `transact`) | A lost connection or a timeout (Convex's `with_retry`); the pool is retired first, so the retry gets a fresh connection (DV-122 covers it, owner 2026-10-01) | Before the retry, the lease record (DV-124) → acknowledged. A duplicate key (23505) that still happens → `UnsureCommitError` |
| MySQL | A timeout or an operational error (Convex's `classify_mysql_error`, same codes); an operational error destroys its connection | An operational error, once (`MYSQL_MAX_QUERY_RETRIES` = 1); not after a timeout | Before the retry, the lease record (DV-124) → acknowledged. A duplicate key (1062) that still happens → `UnsureCommitError` |
| MongoDB (no Convex counterpart; **owner-approved**, 2026-10-01) | A timeout or an operational error, after the MySQL list: network errors (codes 6, 7, 89, 9001 too), server selection, a cleared pool or a pool checkout that timed out, a server shutting down or not primary (codes 91, 189, 10107, 11600, 11602, 13435, 13436) | A timeout (as Postgres); a network error is retried once by the driver's own `retryReads` | After ending the failed attempt's session, the lease record (DV-124) → acknowledged. The fence still finding `maxTs` ≥ the group's top under our epoch → `UnsureCommitError` |
| memory, SQLite | Nothing | — | — |

- **A group that already landed is acknowledged (DV-124, owner 2026-10-01; Convex stops).** When the first
  attempt's COMMIT lands but its answer is lost (a timeout, a connection lost after COMMIT), the retry would
  find the group there. Before re-running a group it failed to flush, every remote driver reads the lease
  record, with one rule on Postgres, MySQL and MongoDB: if its epoch is ours and its `max_ts` ≥ the group's
  top, the group committed (the fence writes `max_ts` in the same transaction as the rows, and only our own
  flushes write it under our epoch, in increasing order), so `flush()` returns without writing and the
  commits are acknowledged, exactly once. An epoch that is not ours: `LeaseLostError`. A lease read that fails
  is classified like any flush error (a timeout or a lost connection: the committer retries, still holding
  the group). Only a retry pays this read; the happy path is unchanged.
- **Still unsure.** If the group lands *after* that read (an earlier attempt's COMMIT already on its way), the
  re-run finds it: a duplicate key on Postgres and MySQL; on MongoDB, which has no unique key on bunvex's rows,
  the fence, whose filter also requires `maxTs < top` (a mismatch under our epoch with `maxTs` ≥ the top). That
  stays `UnsureCommitError`, fail-stop, as Convex. Without these checks a MongoDB retry of a landed group would
  insert it twice, silently (measured with the sabotage: 2 documents and 6 index entries for 1 and 3).
- **A failed attempt stays failed.** Found through a flaky K20 on MongoDB (one full run failed with "the
  committer stopped … unsure if the group committed" while 13 isolated runs passed; reproduced in 1 of 25
  isolated K20 runs, and in 3 of 3 with the retry delayed 200 ms after its `killSessions`). A flush that timed
  out did not stop: MongoDB's `withTransaction` retries its callback after a network error (a
  `TransientTransactionError`), so the abandoned attempt kept running in the background, on the same session
  with a new transaction number (the retry's `killSessions` ends the transaction it finds, not later ones).
  Once the store answered again it raced the committer's retry for the lease document; when it won, it
  committed the group and the retry found it there. Instrumented, every K20 run showed the abandoned callback
  running a second time right after the thaw. Postgres had the same flaw, latent: postgres.js lets a
  retired pool's calls finish, so the timed-out transaction sent its next statement and its COMMIT once the
  store answered (the new K20 check sees it in every sabotaged run); the retry would then have stopped on a
  duplicate key. The fix is general: once a call has timed out, `withTimeout`'s `progress()` throws
  `DatabaseTimeoutError`, and every driver calls `progress()` before each statement of a flush, so a timed-out
  attempt issues nothing more (Postgres and MySQL roll back; MongoDB's callback throws an error without the
  transient label, so `withTransaction` gives up). Only a COMMIT already sent can still land, and the lease
  read or the duplicate check above catches it.
- **An abandoned MongoDB transaction.** A MongoDB transaction belongs to its session, not to its connection:
  after a client-side timeout it stays open on the server, holding its write on the lease document, for up to
  `transactionLifetimeLimitSeconds` (60 s), and every retry meets it as a write conflict. Before a retry, the
  driver therefore ends the failed attempt's session (`killSessions`): if it had committed, nothing changes and
  the fence finds the group; if not, it aborts. (Postgres and MySQL end a transaction when its connection
  closes.)
- **`UnsureCommitError`** (`@bunvex/core/persistence`): "unsure if the group committed: …". It reaches the
  operator as the cause of the `CommitterStoppedError`.

**Read retries (L5).** `retryOnce` (`@bunvex/core/persistence`) runs a read once more after a retryable
error. The drivers use it for `get`, `scan` (each page), `scanDocs`, `maxTs`, the audit calls, and the
bootstrap (its statements are idempotent, and a failed run leaves nothing behind); never for a statement
inside a transaction or a flush, nor for the lease calls (a renewal has its own cadence, and a retried
acquisition could find itself as the holder).

**Backoff settings** stay `Engine` options (`flushRetry`) for now (owner, 2026-10-01); environment variables
(`INITIAL_PERSISTENCE_WRITES_BACKOFF_MS`, `MAX_PERSISTENCE_WRITES_BACKOFF_MS`) come with Convex's env names
(DV-88).

**Measured** (§5): conformance K20 and K21 on Postgres 17, MySQL 8.4 and MongoDB 8.3 (single-node replica
set). Commits/s through the engine on Postgres 17 (local, one insert per mutation, 4 s per run, 5 interleaved
runs against the base branch): 64 writers, median 22 480 vs 22 352 (+0.6%; runs 22 288–23 504 vs
16 336–24 960); 1 writer, median 2 135 vs 1 984 (runs 1 216–2 377 vs 1 501–2 265). No measurable cost: the
happy path adds one `try` per group and one per read. Again after the owner's decisions (the landed check
reads the lease only on a retry; `progress()` checks one flag), 5 interleaved runs against the previous head:
64 writers, median 26 336 vs 26 208 (runs 25 664–26 480 vs 24 857–26 464); 1 writer, median 2 524 vs 2 511
(runs 2 138–2 543 vs 2 316–2 549). No measurable change.

## 4. Divergences

| # | Divergence | Convex | bunvex | Risk / why | Recommendation | Decision |
|---|---|---|---|---|---|---|
| L1 | DDL on every open | Guarded (`to_regclass`, table count, sentinel) | Guarded on Postgres (#62). **MySQL: unguarded `IF NOT EXISTS` on every open**; MongoDB: `createIndex` ×3 | A paused peer can wedge startup; MDL contention (MySQL bug 63144) | **Bug.** Guard MySQL (table count, as Convex v5) and MongoDB (index list) | **Decided (owner, 2026-10-01): match Convex.** Done: Postgres (#62), MySQL (#67), MongoDB (#84) (DV-102, resolved) |
| L2 | First-start serialization | None | Advisory lock on Postgres | An improvement: concurrent first opens crashed without it (STUDY-24) | Keep; add the equivalent to MySQL (`GET_LOCK` around bootstrap DDL only) | **Decided (owner, 2026-10-01): keep bunvex's** (an improvement; MySQL has `GET_LOCK`, #67) (DV-103) |
| L3 | Timeouts on database calls | 30 s (Postgres) / 19 s (MySQL) per call; timed-out connections are dropped | Was none; now as Convex (§3.4): 30 s / 19 s per round trip (MongoDB 30 s), timed-out connections dropped (Postgres: the whole pool, DV-122), renewals bounded by TTL/4 | A hung connection hung startup or a commit forever | **Bug.** Per-call timeouts with Convex's values; drop timed-out connections | **As Convex, fixed in #107.** Owner, 2026-10-01: Postgres retires its pool on a timeout (DV-122); MongoDB uses 30 s (`MONGODB_TIMEOUT_SECONDS`); Convex's `POSTGRES_TIMEOUT_SECONDS` / `MYSQL_TIMEOUT_SECONDS` are read as is; lease renewals are bounded by TTL/4 (DV-14) (DV-104) |
| L4 | Transient errors in a flush | Retried, 100 ms → 10 s backoff, no limit; an ambiguous commit is fatal ("Unsure if transaction committed to disk") | Was fail-stop on any error; now as Convex (§3.5): retried in the committer with Convex's backoff, same group behind the same fence; ambiguous commits fail-stop (`UnsureCommitError`; MongoDB detects them through the lease's `maxTs`) | A network blip or database restart killed the process | **Bug (parity).** Classify transient errors, retry the flush, keep fail-stop for "unsure if committed" (the lease makes a retried flush safe) | **As Convex, fixed in #112, with two decided divergences (owner, 2026-10-01):** a lost connection is transient on Postgres too (DV-123); a retried group found already landed through the lease record is acknowledged, not fail-stop (DV-124). MongoDB's classification: owner-approved. Pool retirement before a retry: DV-122. Backoff knobs: `Engine` options until Convex's env names (DV-88) |
| L5 | Retries of reads and init | Once, on a fresh connection (Postgres: after a lost connection or a timeout; MySQL: after an operational error, not a timeout) | Was none; now as Convex, per driver (§3.5) | Spurious query errors after a database restart | Bug (minor). One retry | **As Convex, fixed in #112** (DV-106) |
| L6 | Layout version | Configured (V5/V6), checked against the store (v6 refuses v5) | None stored, none checked | No upgrade path for layout changes (e.g. `prev_ts`, STUDY-09); a foreign or future store fails obscurely | **Bug.** A layout-version record, checked on open; refuse unknown or foreign layouts | **Decided (owner, 2026-10-01): match Convex** (bug; to be built): a stored layout version; unknown or foreign layouts refused (DV-107) |
| L7 | `read_only` flag | Checked at start: "data migration in progress" | None | No safe hook for migrations or import/export | Add with L6 | **Decided (owner, 2026-10-01): match Convex**, built with L6 (DV-108) |
| L8 | Database name and TLS | Name from the instance name; `sslmode=require` and `target_session_attrs=read-write` by default | URL as given | Unencrypted traffic by default; can land on a read replica | Convex's defaults, with Convex's env names as aliases (see platform.md "Database selection") | **Decided (owner, 2026-10-01):** TLS required by default (`sslmode=require`, can be turned off) and `target_session_attrs=read-write`, as Convex (to be built, DV-109); the database name is **not** derived from the instance name, the URL decides (divergence, DV-110). Convex's env names are accepted as aliases (DV-88) |
| L9 | Two processes on SQLite and memory+log | **Unprotected: data loss, measured (§1.5)** | Unprotected | Silent corruption | **Diverge on purpose:** an exclusive OS lock (C7 for embedded stores). Convex has the bug | **Decided (owner, 2026-09-30): lock** (#70; DV-99) |
| L10 | Lease semantics | Newest wins at once, no TTL; an idle deposed process serves stale data for minutes to hours; a paused holder can leave **no leader** | TTL + release, never taken while live; deposed within ~1.7 s; bounded waits | Decided as STUDY-24 H5 (#62) | Keep. Also apply to MySQL | **Decided (owner, 2026-09-30)** (#62; DV-14) |
| L11 | Shutdown | SIGINT only; committer aborted; lease not released; SIGTERM kills | Drain, release, close; SIGINT and SIGTERM (`bench/server`) | Deploys hand over at once; no in-flight commit is left in doubt | Keep; wire into the product CLI when it exists | **Decided (owner, 2026-10-01): keep bunvex's** (DV-111) |
| L12 | Pools | 128; idle 90 s; MySQL lifetime 600 s | 16; driver defaults | Throughput under load; stale connections behind load balancers | Expose `POOL` (exists); add idle and lifetime settings; measure before changing defaults | **Decided (owner, 2026-10-01): keep bunvex's** — 16, settings exposed; defaults change only after measuring (DV-112) |
| — | Multitenant layouts | `instance_name` / `deployment_id` columns | None | Not needed for self-hosting | Not supported (record only) | — |
| — | MongoDB recovery delete | (no MongoDB) | Deletes rows above the marker at open, with no lease | Data loss with two processes (STUDY-24 S1) | Covered by the MongoDB lease (C7) | — |

## 5. Tests

- **L1:** open while another process holds a transaction open (paused), and open finishes.
- **L3 (built: conformance K20):** a TCP proxy between the driver and the real store stops forwarding in
  both directions without closing anything. A read, a flush and a lease renewal (within TTL/4) fail within
  the timeout; the client closes the connections those calls waited on; once the proxy forwards again, the
  same store answers without being reopened; through the engine, a commit whose flush times out stops the
  committer. Sabotaged (timeouts disabled), every call hangs past the suite's guard.
- **L4 and L5 (built: conformance K21, and K20's last check).** The proxy of K20 also resets the connection of
  a request carrying a marker, and can let a COMMIT through and then drop every answer.
  - L5: a read whose connection is lost answers through its one retry; a read that loses its connection twice
    fails.
  - L4: a commit whose flush times out (the store frozen for 2 s, timeout 1.5 s) is held, retried, and
    acknowledged once the store answers, its rows stored once (K20: frozen for 4 s with a 1.5 s timeout).
  - L4: a failed attempt stays failed (K20): the store frozen until the first flush attempt times out, then
    thawed while the committer's retry is held for 1 s; the proxy counts the requests that carry the group's
    rows or commit in that second: 0 on all three. Sabotaged (`progress()` not throwing after a timeout):
    2 on Postgres and MongoDB in every run (the abandoned attempt sends its rows and its COMMIT); MySQL
    destroys a timed-out connection and stays at 0.
  - L4: a connection lost in the middle of a flush: retried and acknowledged once, stored once (all three;
    Postgres since DV-123; MongoDB through its driver's transaction retry).
  - L4: the first attempt commits but its answer is lost: the retry reads the lease record, finds the group
    landed and acknowledges it, exactly once; the committer keeps running, and after a reopen the store holds
    the group exactly once with `maxTs` at its ts (all three; DV-124).
  - Sabotaged, each goes red: no flush retry (the K20 check and the "unsure" check fail on all three drivers);
    no read retry (both L5 checks; MongoDB with `retryReads: false`); a driver that does not keep its failed
    group (Postgres: the commit is acknowledged and its rows are lost); MongoDB without the `maxTs` check (and
    fresh `_id`s): the commit is acknowledged and stored twice; the landed check made to never find the group
    (DV-124): the committer stops as "unsure" on all three (see §3.5 for the numbers).
  - Unit tests: `packages/core/test/flush-retry.test.ts` (backoff, fail-stop cases, a stop during the
    backoff), `packages/persistence/test/transient.test.ts` (each driver's classification).
- **L6:** open a store written by a future layout version; refuse with a clear error.
- **L9:** two processes on one SQLite file or one memory log; the second refuses (the same shape as K10).

These become conformance checks where they apply to every driver.

## 6. Open questions

- ~~L4: how many retries before fail-stop?~~ Answered: Convex retries without limit (`write_batcher.rs`
  has no counter), and bunvex does too; bunvex's lease TTL bounds it in practice (§3.5).
- ~~L4, Postgres: is a connection lost inside a flush transient?~~ **Decided (owner, 2026-10-01): yes, as on
  MySQL** — a divergence from Convex (only timeouts), DV-123, justified by the lease fence and the exact
  landed-group check (DV-124).
- ~~L4, MongoDB's classification (no Convex counterpart)?~~ **Decided (owner, 2026-10-01): as built** — the
  MySQL list for flushes, Postgres's rule (a retry after a timeout) for reads, the driver's `retryReads`, and
  `killSessions` before a flush retry. Owner-approved.
- ~~L4: a retry that finds its group already committed: fail-stop or success?~~ **Decided (owner,
  2026-10-01): acknowledged** — DV-124, an improvement over Convex; one rule on all three stores (the lease
  record read before the re-run). A duplicate key that still happens stays fail-stop "unsure".
- ~~L5, Postgres: does DV-122 cover retiring the pool before a retry after a lost connection?~~ **Decided
  (owner, 2026-10-01): yes**; the DV-122 row says so.
- ~~L4: Convex's backoff knobs as env vars?~~ **Decided (owner, 2026-10-01): `Engine` options (`flushRetry`)
  for now**; `INITIAL_PERSISTENCE_WRITES_BACKOFF_MS` / `MAX_PERSISTENCE_WRITES_BACKOFF_MS` come with Convex's
  env names (DV-88).
- **Found while testing (not this PR):** postgres.js 3.4.9 throws an uncaught `TypeError` (`socket.write` on
  `null`, `connection.js:255`) when a connection closes while a `sql.begin()` transaction has a query in flight
  (its own ROLLBACK is written to the closed socket from a `setImmediate`). Reproduced standalone on Bun 1.4.2
  and Node 24.21.0 (where it ends the process). Already reported upstream: porsager/postgres#1208 (its
  second comment describes this `begin()` path), also #1133, #1154, #1066; fixes open as #1209 and #1168.
- ~~L8: adopt Convex's `POSTGRES_URL` / `MYSQL_URL` / `INSTANCE_NAME` names as the primary configuration, or
  only as aliases?~~ Answered (owner, 2026-10-01): Convex's database env names are aliases of bunvex's
  (DV-88); the database name comes from the URL, not the instance name (DV-110).

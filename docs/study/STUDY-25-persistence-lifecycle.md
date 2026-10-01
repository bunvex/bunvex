# STUDY-25 — Persistence lifecycle: open, schema, timeouts, retries, shutdown

- **Status:** accepted. L1–L12 (§4) decided by the owner: L9 and L10 on 2026-09-30, the rest on 2026-10-01
  ("approve all recommendations"). L1 and L3 (#107, §3.4), L6 and L7 (#114, §3.5) are done; L4, L5 and L8 are to be built.
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

- The layout version (V5/V6) comes from configuration (`common/src/types/mod.rs:175-197`; the driver tags
  in `clusters/src/db_driver_tag.rs:17-47`).
- **A mismatch is refused, by the shape of the database:**
  - MySQL v5 refuses a non-V5 configuration outright: "V5 persistence cannot open a non-V5 database"
    (`mysql/src/v5/persistence.rs:151-153`).
  - MySQL v6 checks a sentinel table, `indexes_latest`, created before any table whose name v5 also uses.
    `documents` without the sentinel is "a V5 or unversioned persistence database", and v6 refuses to
    initialize over it (`v6/persistence.rs:207-225`). It then checks that every shared table has v6's
    columns (`deployment_id`), and refuses otherwise (`:243-271`).
  - Postgres (V5 only) and SQLite run their guarded DDL over whatever is there and check nothing.
- The layout evolves in place through guarded, idempotent DDL, e.g. adding a primary key if
  `documents_pkey` is missing (`sql.rs:87-99, 153-164`).
- `persistence_globals` (`key`, `json_value`) holds `max_repeatable_ts`, bootstrap ids and table summaries
  (`common/src/persistence/mod.rs:210-243`); SQLite has it too (`sqlite/src/lib.rs:641-647`).

**The `read_only` flag** (Postgres and MySQL; SQLite has none):

- A one-row table, `read_only (id BIGINT PRIMARY KEY)`, created by the guarded DDL (`postgres/src/sql.rs:198-215`).
  A row means read-only (`sql.rs:681-715`: check, set, unset).
- A writer's open checks it after the DDL and **before the lease**, and fails with
  `ConnectError::ReadOnly`, "persistence is read-only, data migration in progress"
  (`postgres/src/lib.rs:220-224, 330-334`; `mysql/src/v5/persistence.rs:186-191`;
  `v6/persistence.rs:168-180`), unless `allow_read_only` is set.
- `allow_read_only`: the self-hosted backend passes `false` (`local_backend/src/main.rs:149-155`); readers
  pass `true` and open regardless (`db_connection/src/lib.rs:181-196`).
- `set_read_only(true|false)` inserts or deletes the row, with no lease (`postgres/src/lib.rs:357-389`;
  `db_connection/src/lib.rs:238-262`). For SQLite it fails: "unsupported persistence type" (`:261`). No
  caller exists in the open-source tree; it is a hook for Convex's migration tooling.
- The flag is read only at start: setting it does not stop a running backend.

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
- **Transient errors** are a timeout or an "operational" error: IO, connection closed or lost, server
  shutdown, too many connections, read-only (`mysql/src/connection.rs:88-118`, `common/src/errors.rs:857`).
  Serialization failures and deadlocks are not classified; with one writer they are not expected.
- **Retries:**
  - Reads and init are retried once on a fresh connection, and never after a statement was prepared
    (`postgres/src/connection.rs:236-264`).
  - Commit writes retry transient errors with backoff from 100 ms to 10 s (`database/src/write_batcher.rs:213-235`).
  - If the first attempt did commit, the retry hits a duplicate key. The committer then stops with "Unsure
    if transaction committed to disk" (`committer.rs:440`), and the process restarts and recovers.

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
  - No layout version was stored or checked before L6 was built (§3.5).

### 3.2 Timeouts, retries, shutdown

- **Timeouts on database calls** (L3): before §3.4 there were none (except `lock_timeout` in the Postgres
  bootstrap and lease acquisition), and a hung connection hung startup, a query or a commit forever.
- **Any flush error is fail-stop at once**: the committer stops and the server exits (`committer.ts`,
  `server.ts`). There is no retry of transient errors.
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
- **Not in this change** (follow-ups): retrying a flush after a transient error (L4), retrying a read once
  on a fresh connection (L5; Convex's reads retry once after a timeout, so a read there can wait two
  timeouts, where bunvex fails after one).
### 3.5 Layout version and read-only flag (L6, L7; built as Convex, #114)

**What every store records** (`packages/core/src/persistence/layout.ts`, PERSIST-01 C10):

| Driver | Layout version | Read-only flag |
|---|---|---|
| Postgres, MySQL | row `layout_version` of `persistence_globals (key, json_value)`, JSON text | a row in `read_only (id)` |
| SQLite | the same tables, in the file | the same |
| MongoDB | `meta` `{_id: "layout", version}` | `meta` `{_id: "read_only"}` |
| memory+log | the log's first record, `{"layout":1}` | a file next to the log, `<log>.read-only` |

The names are Convex's (`persistence_globals`, `read_only`). bunvex has one layout, version 1.

**What an open does**, in order:

1. **Read, never write.** No lock and no lease is needed, because refusing is safe:
   - The recorded version must be bunvex's. A newer one, or an unknown one, is refused with `LayoutError`,
     naming what was found. An older one would be upgraded in place if bunvex had an upgrade for it. It has
     none yet (DV-56: no migrations for now), so it is refused too.
   - With no record, `documents` and `indexes` must have bunvex's columns (MongoDB: fields of a sample
     document), or not exist. Anything else, Convex's own tables included, is refused with `LayoutError`,
     and nothing is written. SQLite checks before even the WAL pragma, which would rewrite the file's
     header. A memory log whose first line is neither a header nor a commit record is refused; before L6 it
     was "torn" and **truncated to nothing**.
   - A store marked read-only is refused with `ReadOnlyError` ("… is read-only, data migration in
     progress"), unless the open passes `allowReadOnly` (Convex's `allow_read_only`).
2. **The guarded DDL** (unchanged): only missing tables, so a store written before L6 gets the two new
   tables here.
3. **The lease** (`Engine.init`). The version record is written **under it, in the acquiring
   transaction** (Postgres, MySQL), or right after winning it (MongoDB, SQLite under its lock, the memory
   log under its lock while it replays). The record is written only if there is none; a record found there
   is checked again, so a store changed between the open and the lease is still refused. On a mismatch the
   lease is given back (Postgres and MySQL roll the acquisition back). PERSIST-01 C7 holds: a mere open
   writes nothing but missing tables.
4. `maxTs`, the catalog: unchanged.

**Stores written before L6** have bunvex's tables and no record. They are the same layout, so they open as
version 1 and get the record at their first lease. This was checked on real stores: written by `main`
(05d8e49) on all five drivers, then reopened twice by this branch (data intact, one record, the memory log
with one header appended). The reverse does not work: an older bunvex cannot read a memory log that starts
with a header, and fails on it.

**Setting the flag**: `setReadOnly(true|false)` on every driver (`ReadOnlyFlag`), with no lease, as
Convex's `set_read_only`. To clear it, open with `allowReadOnly`. It is read only at open: a running
writer is not stopped. There is no CLI yet; import/export will use it.

**Measured** (open + `Engine.init` + close on a 100k-document store, see the PR): the checks add one round
trip to the open of a remote store (two on a store without a record), and one statement to the lease.

## 4. Divergences

| # | Divergence | Convex | bunvex | Risk / why | Recommendation | Decision |
|---|---|---|---|---|---|---|
| L1 | DDL on every open | Guarded (`to_regclass`, table count, sentinel) | Guarded on Postgres (#62). **MySQL: unguarded `IF NOT EXISTS` on every open**; MongoDB: `createIndex` ×3 | A paused peer can wedge startup; MDL contention (MySQL bug 63144) | **Bug.** Guard MySQL (table count, as Convex v5) and MongoDB (index list) | **Decided (owner, 2026-10-01): match Convex.** Done: Postgres (#62), MySQL (#67), MongoDB (#84) (DV-102, resolved) |
| L2 | First-start serialization | None | Advisory lock on Postgres | An improvement: concurrent first opens crashed without it (STUDY-24) | Keep; add the equivalent to MySQL (`GET_LOCK` around bootstrap DDL only) | **Decided (owner, 2026-10-01): keep bunvex's** (an improvement; MySQL has `GET_LOCK`, #67) (DV-103) |
| L3 | Timeouts on database calls | 30 s (Postgres) / 19 s (MySQL) per call; timed-out connections are dropped | Was none; now as Convex (§3.4): 30 s / 19 s per round trip (MongoDB 30 s), timed-out connections dropped (Postgres: the whole pool, DV-122), renewals bounded by TTL/4 | A hung connection hung startup or a commit forever | **Bug.** Per-call timeouts with Convex's values; drop timed-out connections | **As Convex, fixed in #107.** Owner, 2026-10-01: Postgres retires its pool on a timeout (DV-122); MongoDB uses 30 s (`MONGODB_TIMEOUT_SECONDS`); Convex's `POSTGRES_TIMEOUT_SECONDS` / `MYSQL_TIMEOUT_SECONDS` are read as is; lease renewals are bounded by TTL/4 (DV-14) (DV-104) |
| L4 | Transient errors in a flush | Retried, 100 ms → 10 s backoff; an ambiguous commit is fatal | Fail-stop on any error | A network blip or database restart kills the process | **Bug (parity).** Classify transient errors, retry the flush, keep fail-stop for "unsure if committed" (the lease makes a retried flush safe) | **Decided (owner, 2026-10-01): match Convex** (bug; to be built) (DV-105) |
| L5 | Retries of reads and init | Once, on a fresh connection | None | Spurious query errors after a database restart | Bug (minor). One retry | **Decided (owner, 2026-10-01): match Convex** (bug; to be built) (DV-106) |
| L6 | Layout version | Configured (V5/V6), checked against the store (v6 refuses v5) | Recorded in every store, checked on open; a future, unknown, older (no upgrade yet) or foreign store is refused with `LayoutError` (§3.5) | No upgrade path for layout changes (e.g. `prev_ts`, STUDY-09); a foreign or future store fails obscurely | **Bug.** A layout-version record, checked on open; refuse unknown or foreign layouts | **As Convex, fixed in #114** (owner, 2026-10-01: match Convex; DV-107, resolved). Mechanism: a stored record instead of configuration (bunvex has one layout); same refusals |
| L7 | `read_only` flag | Checked at start: "data migration in progress" | Checked at open on every driver: `ReadOnlyError` unless `allowReadOnly`; `setReadOnly` with no lease (§3.5) | No safe hook for migrations or import/export | Add with L6 | **As Convex, fixed in #114** (owner, 2026-10-01: match Convex; DV-108, resolved). Also on SQLite and memory+log, where Convex has none: **divergence decided** (owner, 2026-10-01: "yes, it must be on every driver"; DV-125) |
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
- **L4:** kill the database connection during a flush; the commit is retried and acknowledged once. Force
  an ambiguous commit; the process stops.
- **L6:** open a store written by a future layout version; refuse with a clear error. Conformance K22: a
  new store records its version and reopens; a store without a record opens and gets one; a future or
  unknown version, and a store bunvex did not write, are refused and left as they were.
- **L7:** conformance K23: a read-only store refuses to open for writing, opens with `allowReadOnly`, and
  opens for writing once cleared.
- **L9:** two processes on one SQLite file or one memory log; the second refuses (the same shape as K10).

These become conformance checks where they apply to every driver.

## 6. Open questions

- L4: how many retries before fail-stop? Convex retries indefinitely with backoff, and relies on the
  duplicate-key signal.
- ~~L8: adopt Convex's `POSTGRES_URL` / `MYSQL_URL` / `INSTANCE_NAME` names as the primary configuration, or
  only as aliases?~~ Answered (owner, 2026-10-01): Convex's database env names are aliases of bunvex's
  (DV-88); the database name comes from the URL, not the instance name (DV-110).

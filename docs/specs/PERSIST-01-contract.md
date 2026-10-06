# PERSIST-01 — the persistence contract

> v1, 29 Sep 2026 (written as STORAGE-01; renamed by ARCH-01 D2 — "storage" is the FILE API, as in
> Convex). **v2, 30 Sep 2026:** C7 (single writer: lease and fencing) and K10–K18, from STUDY-24 H8/H5.
> **v2.1, 30 Sep 2026:** C8 (liveness: client-side call timeouts) and K20, from STUDY-25 L3.
> **v2.2, 1 Oct 2026:** C9 (transient errors and retries; ambiguous commits per driver) and K21, from STUDY-25
> L4/L5; K20's last check now expects a timed-out flush to be retried. **v2.3, 1 Oct 2026:** owner decisions on
> C9: a lost connection is transient on Postgres too (DV-123); a retried group that already landed is
> acknowledged, detected by one rule on every store (DV-124); a failed attempt issues nothing after it failed.
> **v2.4, 1 Oct 2026:** C10 (layout version and read-only flag) and K22–K23, from STUDY-25 L6/L7.
> **v2.5, 1 Oct 2026:** C11 (the log by timestamp) and K25, from STUDY-24 H11 (K24 is the index backfill's,
> STUDY-29). **v2.6, 1 Oct 2026:** C4 bounded flushes (the committer writes a group in write batches, DV-62)
> and K26, from STUDY-06 §10. **v2.7, 1 Oct 2026:** C12–C14 (the document log, pruning, globals: what retention
> needs) and K27–K29, from STUDY-33. **v2.8, 3 Oct 2026:** C15 (index references), from STUDY-09 §1.6; K30–K31. **v2.9, 3 Oct 2026:** C16 (document versions) and K32, for streaming export's per-document timestamps (owner, 2026-10-03). **v3.0, 6 Oct 2026 (STUDY-133 PR 3):** internal ids and `prev_ts` in C1; `scan` returns documents through the exact-ts join (C3, C6; `scanDocs` is gone); `get` returns a version; C15 rewritten for the join; C17 (index entries at past timestamps); K30–K31 rewritten, K34–K36. Every persistence driver (`memory`, `sqlite` in `@bunvex/core`; `postgres`, `mysql`,
> `mongodb` in `@bunvex/persistence`; and third-party ones) implements `Persistence`
> (`packages/core/src/persistence/index.ts`) and must pass `@bunvex/persistence-conformance`
> (`bun bench/conformance.ts` runs it on every first-party driver). The engine core (OCC, committer,
> query cache, subscriptions) never looks past this interface — that is what lets a new store be added
> without touching the core.

## C1 — what is stored

Two logical collections, Convex's shape:

- **documents**: `(table_id, id, ts) → json | deleted, prev_ts`. `table_id` is the table's tablet and `index_id`
  (below) the index's id, Convex's: the internal ids of their `_tables` and `_index` rows (STUDY-133 §5.2), passed
  as 22-character base64url strings. `id` is the document's **internal id** (the same 22-character form; the
  developer id `_id` is the engine's, `internalIdOf` maps it), never the developer id. `prev_ts` is the ts of the
  version this one replaces, null for a new document: the committer sets it (Convex's `committer.rs`), the store
  keeps it as written and returns it in the document log (C12). Every version of every document, never updated
  in place.
- **indexes**: `(index_id, key, ts) → (table_id, document_id) | deleted`. Every version of every index entry.
  An entry names its document's table as well as its id (an `IndexWrite` carries `table`; both are null for a
  removed entry).

`key` is an opaque byte string produced by `src/keyenc.ts`. `ts` is the commit timestamp assigned by the
committer: a strictly increasing integer, the wall clock in **nanoseconds** as Convex's `next_commit_ts`
(`max(last + 1, clock)`; STUDY-06 D9, STUDY-133 §5.3), passed as a `bigint` (it is above 2^53) and stored
as a 64-bit integer, exactly. Timestamps are therefore **sparse**: a driver must not assume that `ts + 1`
is the next commit.

## C2 — ordering

`scan` MUST return entries in **unsigned byte-wise order** of `key` (memcmp; a shorter key that is a
prefix of a longer one sorts first). The whole read-set / invalidation model depends on it: a store whose
native ordering differs (MongoDB compares `BinData` by length first) must re-encode the key into
something whose native order is byte order (e.g. lowercase hex strings) — inside the driver.

## C3 — snapshot reads

For a snapshot `T`:

- `get(table, id, T)` returns the newest version with `ts ≤ T` as `{ json, ts }` (its JSON and the ts it was
  written at), or null if that version is a delete or none exists.
- `scan(table, index, lo, hi, T, limit, desc)` returns, in key order (reversed if `desc`), the newest
  `ts ≤ T` version of each key in `[lo, hi)` that is not a delete, up to `limit`, each as `{ id, ts, json }`:
  the entry's document id and ts, and its document's JSON **at the entry's own ts** (the exact-ts join, C6).
  "Up to `limit`" means **exactly** `min(limit, live keys in the range)`: removed entries and older
  versions never count toward the limit. A driver that reads rows in `(key, ts desc)` order must page
  until it has `limit` live entries or the range is exhausted; `scanLatest`/`scanLatestSync` in
  `@bunvex/core/persistence` do this. `limit ≤ 0` returns nothing.
- Keys have **no length limit**. A store whose indexed columns are limited stores a key as Convex does:
  `key_prefix` (the first 2500 bytes), `key_suffix` and `key_suffix_hash`. It restores the true order among
  keys that share a full-length prefix (`splitKey` / `splitPages` in `@bunvex/core/persistence`).
- Rows with `ts > T` MUST NOT influence the answer, even if they are already stored (the committer
  applies a group before it is durable; readers at an older snapshot must not see it).
- A snapshot older than the newest one still answers from the versions it saw. History is kept until
  retention prunes it (C13): the engine never reads below the window it pruned at.

## C4 — writes and durability

- `apply(ts, docs, idx)` is called once per commit, in increasing `ts` order, possibly several times
  before one `flush()`.
- `flush()` returns once **every applied commit is durable**. The engine acknowledges a commit to its
  client only after the `flush()` covering it resolves.
- **Bounded flushes (DV-62, as Convex's write batcher).** The committer applies and flushes a group of
  commits in *write batches*: whole commits, each batch closed once it holds 64 document versions or 64 KiB
  (soft caps: a commit is never split, so one above the caps is flushed whole), one `flush()` per batch, one
  after the other in ts order. A driver therefore sees at most one batch per `flush()`, except for one large
  commit, whose rows a remote driver splits into several statements of the same transaction (Postgres ≤1 024
  rows per statement, MySQL ≤10 MiB per `INSERT`: `chunkRows` in `@bunvex/core/persistence`), so no statement
  exceeds the store's packet or parameter limits.
- **Crash atomicity.** After a crash, the durable state is the state after some **prefix** of the
  applied commits: every commit up to some `ts = M` is fully present (its document versions AND its index
  entries), and nothing with `ts > M` is visible. `M ≥` the last acknowledged commit. A torn commit (some
  of its rows present, others not) is a violation. Stores that cannot write two collections atomically
  achieve this with a **commit marker**: the rows first, then the marker `M` durably; `maxTs()` returns
  the marker and reads never see rows above it (recovery may delete them — under the lease only, C7).

## C5 — recovery

`maxTs()` returns `M` from C4. On open, the engine resumes its committer at `M`: the next commit gets a
ts above `M` (the clock, or `M + 1` if the clock is behind), and `M` is the first snapshot served. A driver keeping state in memory (the memory+log store)
rebuilds it from its log, ignoring a torn trailing record.

## C6 — the exact-ts join

`scan` returns each entry with its document, as Convex's `index_scan` (DV-67 reversed): the document version
of `(table, id)` written **at the entry's ts**, not the newest one at or below `T`. The engine writes an entry
and the document version it indexes in the same commit, and an index backfill writes an entry at its document
version's own ts (C17), so the version at the entry's ts is the one the entry indexes; a newer version has its
own entry, which shadows this one at snapshots that see it. A remote store answers in one round trip per page
(a join on `(table, id, ts)`), never one `get` per entry. An entry with no document version at its ts, or a
delete there, rejects (C15). The `ScanDocs` fast path of v2 is gone: `scan` is that path.

## C7 — single writer (lease and fencing)

C1–C5 assume **one** process writes a store. Nothing enforced it before v2, and two processes on one
store corrupted it silently (STUDY-24 S1: duplicate timestamps, lost acknowledged updates, snapshots that
change after the fact, two catalogs and two instance secrets). C7 enforces it.

A driver implements C7 by implementing the `Lease` interface (`acquireLease`, `renewLease`,
`releaseLease`). v2 is optional per driver: a driver without it behaves as in v1, and the engine then has
no protection (the driver's docs say so). First-party status: every first-party driver implements C7 —
**postgres**, **mysql**, **mongodb**, **sqlite** and **memory**. MongoDB needs a replica set (a single-node one
is enough): a flush is a multi-document transaction whose first write is the fence.

- **The lease** is one record in the store: `epoch` (strictly increasing), `holder` (an opaque string
  naming the process), `expires_at`, and `max_ts` (the durable prefix, see below).
- `acquireLease({holder, ttlMs})` takes the lease only if it is **free, released, or expired**, and then
  increments `epoch` and sets `expires_at = now + ttlMs`, atomically. `now` is **the store's clock**, never
  the caller's. It returns `{ epoch }`, or `{ heldBy, expiresInMs }` when the lease is live. A live lease
  is never taken from its holder (unlike Convex's, where the newest process wins at once; STUDY-24 H5).
- `renewLease()` sets `expires_at = now + ttlMs` if the epoch is still the caller's, and otherwise throws
  `LeaseLostError`.
- `releaseLease()` frees the lease if the epoch is still the caller's (a clean shutdown hands over at
  once, instead of after a TTL).
- **Fencing.** `flush()` MUST fail with `LeaseLostError`, leaving nothing of its group visible, if the
  caller's epoch is no longer the current one. The check is part of the same atomic write as the group
  (inside the transaction, or the same conditional write): a check followed by a separate write is not a
  fence. Expiry alone is not safety; the epoch check is. A `flush()` on a C7 driver that holds no lease
  throws.
- **The durable prefix.** Every fenced flush sets `max_ts` to the group's highest ts in the same atomic
  write. `maxTs()` returns it: O(1), and it counts **every** commit, including one that wrote only index
  entries (STUDY-24 S2). On the first acquire of a store written before v2, `max_ts` is initialised from
  the highest ts of the documents **and** the index entries.
- **Order on open.** The engine acquires the lease **before** it reads `maxTs()`, and a driver runs any
  recovery (log truncation, deleting rows above a commit marker) only under the lease.
- **Liveness.** Opening a store must not wait on another process's open transaction (a paused process
  must not wedge `open()`: STUDY-24 S3), and two concurrent opens of an empty store must not fail.

**Process-scoped leases (embedded stores).** A store that is a file on one machine (sqlite, memory+log)
implements C7 as an **exclusive OS lock** next to the file (`leaseScope = "process"`): taken at open when
free, held for exactly as long as the process lives, dropped by the kernel when it dies (kill -9
included). `acquireLease` reports a held lock as `{ heldBy, expiresInMs: null }`; there is no TTL and
nothing to renew, and a writer that does not hold the lock cannot apply. Recovery (the memory log's torn
tail) runs only under the lock. Convex's SQLite store has no lock and loses writes with two processes
(STUDY-25 L9, measured); bunvex diverges on purpose (owner, 2026-09-30).

The engine side (`@bunvex/core`): `init()` acquires the lease with `holder = host:pid:random` and the
TTL (default 5 s). A live lease fails `init()` with `LeaseHeldError` (who holds it, when it expires),
unless the engine was given a wait (`lease.waitMs`): it then retries until the lease is free or the wait
runs out. The lease is renewed every TTL/3; `LeaseLostError`, or a renewal still failing (or still waiting
for the store, C8) when the TTL runs out, stops the committer (fail-stop, as a failed flush). `Engine.close()` releases it.

## C8 — liveness: client-side call timeouts (remote stores)

A remote store can stop answering without closing anything: a frozen server, a paused VM, a network that
drops packets. C1–C7 say nothing about time, so a driver that waits for an answer forever is correct and
useless: startup, a query or a commit hangs with it. A driver for a remote store therefore (STUDY-25 L3,
as Convex):

- **bounds every call on the client side**, per round trip: getting or opening a connection, each
  statement, BEGIN and COMMIT. A call that gets no answer within the timeout rejects with
  `DatabaseTimeoutError` (`@bunvex/core/persistence`; `withTimeout` implements the rule). The first-party
  defaults are Convex's: Postgres 30 s, MySQL 19 s; MongoDB 30 s. Each driver takes `timeoutMs` at open.
- **never reuses the connection of a timed-out call.** Its answer may still arrive, or never; the
  connection is closed (Postgres: the driver retires its whole pool, since postgres.js exposes no single
  connection).
- **bounds a lease renewal by a quarter of the TTL** (or the call timeout, if shorter; `renewTimeoutMs`), so
  a renewal stuck on a dead connection fails before the next one is due, and that one runs on a fresh
  connection.

A `flush()` that times out is a failed flush, and whether its group committed is unknown: the committer
retries it (C9) and, if the retry finds the group already there, acknowledges it (DV-124). The engine also stops when a lease
renewal is still pending once the TTL has run out, whatever the driver does. Embedded stores (memory, SQLite)
make no network calls and have no timeout.

## C9 — transient errors and retries (remote stores)

As Convex (STUDY-25 L4/L5), a remote store's passing failures — a timeout, a connection the server or the
network closed, a server shutting down or not serving — are retried instead of stopping the process:

- **Classification.** A driver implements `isTransient(e)`: whether an error of `flush()` is transient. The
  first-party rules are Convex's per driver, with one decided divergence: Postgres, a timeout or a lost
  connection (Convex: a timeout only; DV-123, owner 2026-10-01); MySQL, a timeout or an operational error
  (Convex's `classify_mysql_error`: lost connection, IO, 1290, 2013, 1053, 1040); MongoDB (no Convex
  counterpart; owner-approved), a timeout, a network or server-selection error, or a server shutting down or
  not primary. A
  `LeaseLostError`, a duplicate key, a deadlock or a serialization failure is never transient. A driver
  without `isTransient` (memory, SQLite) has no transient errors.
- **Flush retries (the committer).** A `flush()` that fails transiently is retried with full-jitter
  exponential backoff from 100 ms to 10 s, with no limit on attempts (Convex's write batcher); the lease's TTL
  bounds it in practice (C7). Anything else stops the committer: "write failed, unsure if the group committed
  to disk".
- **The same group.** A driver whose `flush()` failed MUST keep the group: the next `flush()` writes the same
  rows at the same timestamps, behind the fence (C7). Re-applying them under new timestamps, or dropping them,
  is a violation (K20 catches the second: a commit acknowledged with no rows).
- **A failed attempt stays failed.** Once a `flush()` has failed, nothing of that attempt may commit after the
  next `flush()` began, except a COMMIT that had already been sent: a call that timed out issues no further
  statement (`withTimeout`'s `progress()` throws once the call has timed out), and a store whose transactions
  outlive their connection (MongoDB) ends the failed attempt's transaction before the retry. Otherwise the
  abandoned attempt races the retry (MongoDB's `withTransaction` retried its callback in the background and
  sometimes committed the group under the retry: found as a flaky K20).
- **A group that already landed (DV-124, owner 2026-10-01).** A retry of a group whose earlier attempt did
  commit MUST NOT write the group again. Before re-running a group it failed to flush, the driver reads the
  lease record: if its epoch is ours and its `max_ts` ≥ the group's top, the group committed (C7's fence writes
  `max_ts` in the same transaction as the rows), and `flush()` succeeds without writing: the commits are
  acknowledged, exactly once. The same rule on every store. If the epoch is not ours: `LeaseLostError`. If
  the read fails, the error is classified as any other (transient: the committer retries, still holding the
  group). Convex stops instead ("Unsure if transaction committed to disk").
- **Still unsure.** If the group turns out to be there anyway while it is re-run (an earlier attempt's COMMIT
  that was already sent landed after the lease read), the flush fails with `UnsureCommitError`
  (`@bunvex/core/persistence`), which is never transient: the committer stops, and after a restart the store
  holds the group exactly once. Per store: Postgres and MySQL see a duplicate key on the primary keys of
  `documents` and `indexes`; MongoDB, which has no unique key on the rows, sees its fence fail (it matches
  only while the lease's `maxTs` is below the group's top) under our own epoch with `maxTs` ≥ the top. Before
  the lease read, the MongoDB driver ends the failed attempt's session, whose transaction outlives its
  connection on the server; a third-party driver must make the same check (C7's `max_ts` always allows it).
- **Reads (the driver).** A read, or an idempotent init step, that fails because its connection was lost runs
  once more on a fresh connection (`retryOnce`; Convex's `with_retry`, `MYSQL_MAX_QUERY_RETRIES` = 1). Postgres
  also retries after a timeout (so a read waits up to two timeouts); MySQL does not. Never a statement inside
  a transaction or a flush, and never a lease call.

## C10 — layout version and read-only flag

A store says which layout wrote it, and whether it may be opened for writing (STUDY-25 L6/L7, as Convex:
its configured layout, refused over a different one, and its `read_only` table). The helpers and errors
are in `@bunvex/core/persistence` (`layout.ts`); the current layout is `LAYOUT_VERSION` (1).

- **The record.** Every store holds its layout version: a `layout_version` row of `persistence_globals`
  (SQL stores), `meta` `{_id: "layout"}` (MongoDB), or the log's first record `{"layout":N}` (memory+log).
  Each driver's file header says where.
- **Open checks, writing nothing.** Before any write (DDL included) and without the lease, since refusing
  is safe:
  - A recorded version other than `LAYOUT_VERSION` fails the open with `LayoutError`, naming it: newer,
    unknown, or older with no upgrade. An upgrade, when one exists, runs under the lease only, as recovery
    does (C7). None exists yet.
  - A store with no record is bunvex's only if its tables (collections) have bunvex's columns (fields), or
    do not exist. It is then a store written before C10, the same layout. Anything else is refused with
    `LayoutError` and left untouched.
  - A store marked read-only fails the open with `ReadOnlyError` ("… read-only, data migration in
    progress"), unless the caller passes `allowReadOnly` (readers, migration tools).
- **Stamping under the lease.** A store with no record gets one when the lease is acquired, in the same
  atomic step where the store allows it. A record found there is checked again; on a mismatch the
  acquisition fails and the lease is not kept.
- **The flag.** A driver implements `ReadOnlyFlag.setReadOnly(on)`: no lease is needed (as Convex's
  `set_read_only`). It is read at open only; a running writer keeps writing.
- A third-party driver claims C10 by passing K22 and K23. Its conformance module then exports the
  `layoutVersion`, `setLayoutVersion`, `makeForeign` and `foreignIntact` hooks, and an `open` that takes
  `allowReadOnly`.

## C11 — the log by timestamp

The store's commits, read in ts order: what a follower, a catch-up after a dropped stream, retention and
export read (STUDY-24 §4.3, decided as H11 by the owner on 2026-10-01; STUDY-09 D6). The log is the
**`indexes`** collection by ts, not `documents`: every commit the engine makes writes index entries (each
document version rewrites its `by_id` entry). An index backfill's entries are not commits (C17).

`readLog(afterTs, upToTs, limit)` returns `LogCommit[]`, `{ ts, prevTs, writes }`:

- **The window.** Exactly the commits with `afterTs < ts ≤ min(upToTs, M)`, where `M` is the durable
  prefix (C4/C7: `maxTs()`), in increasing ts order. A commit applied but not yet made durable by its
  `flush()`, or a group in flight, is never returned, whatever `upToTs` says. Neither is a row above `M`
  (the remains of an interrupted flush, before recovery deletes them).
- **Whole commits.** At most `limit` commits, never part of one: a commit's entries all come back, or the
  commit is left for the next call. `limit ≤ 0` returns nothing.
- **`writes`** is the commit's index write set, `(index, key, id | null)` as `apply` received it (`null`:
  the entry was removed), which is the committer's `LogEntry.writes`. The order inside a commit is
  unspecified. Keys come back whole, however the store splits them (C3).
- **`prevTs`** is the ts of the commit just before this one in the log, or 0 if there is none: for the
  first commit returned, the newest commit with `ts ≤ afterTs`. Timestamps are sparse (C1), so a reader
  cannot tell a gap from `ts` alone: it checks `prevTs` against the last ts it holds, and catches up with
  `readLog(last, …)` when they differ. Paging is `readLog(lastTsOfThePreviousPage, upTo, n)`.
- **Cost.** Every driver keeps an index on `indexes.ts` (memory: the commits in an array, appended in ts
  order). A call reads the index and the rows it returns, never a scan of the store (STUDY-24 §4.3.1
  has the numbers). It needs no lease and writes nothing. On a remote store it is a read (C8, C9): bounded
  by the call timeout and run once more after a timeout or a lost connection.
- **The ts index on an existing store.** It is created with the tables. A store written before C11 gets it
  as an upgrade would: Postgres, MySQL and SQLite build it when the lease is acquired (a plain index build
  blocks writers, so only the holder does it, before it writes, in one timed call that is not retried);
  MongoDB at open, like its other indexes
  (STUDY-25 L1), since its index builds do not block writers.

Optional in the interface (a third-party driver without it behaves as before); required of the first-party
drivers, which all implement it: memory, sqlite, postgres, mysql and mongodb. Conformance K25.

## C12 — the document log by timestamp

`readDocumentLog(afterTs, upToTs, limit)` returns `{ ts, table, id, deleted, prevTs }[]` (`prevTs` as
written, C1): the stored document versions of the commits with `afterTs < ts ≤ min(upToTs, M)`, in ts order, with C11's rules (durable only,
whole commits, at most `limit` commits, a read that needs no lease). Retention reads it to find the
document versions a newer one supersedes (STUDY-33 R2). Every driver keeps an index on `documents.ts`,
created as C11's: with the tables, or for an existing store when the lease is acquired (MongoDB at open).

## C13 — pruning

`pruneIndexes(entries, through)` and `pruneDocuments(entries, through)` delete, for each entry, every
stored version of one index key `(index, key)` or one document `(table, id)` at or below the entry's `ts`
(Convex's `ts <= X` deletes), and return how many rows went. `through` is how far the caller read the
log; a driver that keeps its log apart from its rows (memory) may forget the log up to there.

- **What the engine deletes.** Only versions that no snapshot at or above its window can see (STUDY-33):
  for a row of the log at or below the window, a live row supersedes the versions below it (`ts − 1`), and a
  tombstone takes itself too (`ts`). A store must answer every snapshot at or above that window exactly as
  before. Below it, reads (and the logs, C11/C12) return what is left.
- **Idempotent.** Pruning the same entries again deletes nothing; a remote store may run a prune once more
  after a lost connection (C9).
- **Only the lease holder** prunes. A prune by a process without the lease throws `LeaseLostError` and
  deletes nothing. Remote stores check the epoch without locking the lease row, so a flush is never held up
  by a prune; a takeover between the check and the delete can let one batch through, which removes only
  versions superseded below a window the old holder had already published.

## C14 — persistence globals

`getGlobal(key)` returns a JSON value or null; `setGlobal(key, value)` stores one, durable when it returns,
and only for the lease holder (`LeaseLostError` otherwise). They are Convex's `persistence_globals`: SQL
stores keep them in that table (with `layout_version`), MongoDB in a `persistence_globals` collection, the
memory driver as records of its log. Retention keeps its windows and cursors there, and every store keeps
Convex's four bootstrap globals (`tables_table_id`, `index_table_id`, `tables_by_id`, `index_by_id`: JSON
strings), from which a start finds the catalog (STUDY-133 §5.2).

C14 is required of every driver (the bootstrap needs it). C12–C13 are optional in the interface
(`hasRetention`; without them the engine keeps every version); required of the first-party drivers, which all
implement them. Conformance K27–K29.

## C15 — index references

An index entry and its document are written in the same commit, so at any snapshot each live entry
names a document that exists there. A store where one does not (the document never written, or deleted
while the entry stayed) is corrupt, and reads say so instead of hiding it, as Convex's do ("Dangling index
reference", "Index reference to deleted document"; STUDY-09 §1.6):

- `scan` rejects with `DanglingReferenceError(index, id, ts, deleted)` when an entry it would return has no
  document version at the entry's ts (`deleted` false) or a delete there (`deleted` true); `ts` is the
  entry's. It never returns fewer documents than the range holds. A range with no broken entry reads as
  usual.
- `get` returns null for such a document, as for any missing one.

Documents are keyed by (table, id): one id in two tables is two documents. Conformance K30–K31 and K35 (the
exact-ts join, C6).

## C16 — document versions

`getVersions(table, ids, ts)` returns one answer per id, in the ids' order, duplicates included: the
version of `(table, id)` visible at `ts` as `{ json, ts }` (the JSON `get` would return, and the ts it was
written at), or null when the document is missing or deleted at `ts`. A remote store answers in one round
trip per batch of ids (the first-party drivers: 1 000 ids per statement), not one per id. Streaming
export reads it for each document's revision ts (Convex's `LatestDocument.ts`; STUDY-60, data sync). `get` is
its one-id form. Optional in the interface; required of the first-party drivers. Conformance K32.

## C17 — index entries at past timestamps

`writeIndexEntries(entries)` writes index entries `{ index, key, table, id, ts }`, each at its **own** ts,
typically below `maxTs`: an index backfill's write (Convex's `write_index_backfill`, `ConflictStrategy::Overwrite`),
each entry at the ts of the document version it indexes, so that the exact-ts join (C6) finds that version.

- **Replace.** An entry at the same `(index, key, ts)` as a stored one replaces it (a removed entry, `id` null,
  included).
- **Seen like any entry.** A scan at `T ≥ ts` sees the entry (unless a newer one of its key shadows it); one
  at `T < ts` does not.
- **Not a commit.** The call adds no commit to the log (C11: the commits and their `prevTs` chain are
  unchanged) and does not move `maxTs`. Whether the entries appear in the write set of an existing commit at
  the same ts is unspecified: a store whose log is its `indexes` by ts (SQL, MongoDB) lists them there, memory
  does not; readers of the log must not depend on either.
- **Durable when it returns**, and survives a reopen.
- **Only the lease holder** writes: a caller without the lease gets `LeaseLostError` and nothing is written.

Required of every driver. Conformance K36 (and K24, through the engine's backfill).


| # | property | how |
|---|---|---|
| K1 | byte order | random mixed-type tuples, encoded, applied, scanned: order equals `compareKeys` |
| K2 | snapshots | every write is tagged; for random past snapshots the answers equal a reference model |
| K3 | no lost update | 64 concurrent increments of 1 and of 4 counters through the engine |
| K4 | cache invalidation | an insert outside a cached range keeps the entry, one inside it is seen |
| K5 | atomic visibility | readers racing 2-document mutations never see one of the two |
| K6 | crash atomicity (process crash) | a child process commits continuously and is SIGKILLed at random moments, N times; after each kill the store reopens with `maxTs ≥` the last acknowledged commit, every commit `≤ maxTs` is complete (doc + all its index entries), none above it is visible, and writing resumes above `maxTs` |
| K7 | torn tail (log-based drivers) | half a record appended to the log: it is cut off on open, and a commit written after recovery survives the next reopen |
| K8 | exact limits | a range whose ends are full of deleted keys and whose live keys have hundreds of versions: for limits 0–100, asc and desc, whole and partial ranges, at several snapshots, `scan` returns exactly the reference model's first `limit` live entries |
| K9 | long keys | incompressible keys up to 6 KB, many sharing their first 2500+ bytes, plus keys around the 2500-byte boundary, with versions and deletes: scans over whole and partial ranges (bounds that are themselves long keys), both directions, several limits and snapshots, equal the reference model |
| K10 | lease is exclusive | a second `acquireLease` while the first is live returns `heldBy`; through the engine, a second engine on the same store fails `init()` with `LeaseHeldError` |
| K11 | takeover after expiry | a holder that stops renewing is replaced within TTL + ε; the new epoch is greater |
| K12 | stale flush refused | after a takeover, the old holder's `apply` + `flush` throws `LeaseLostError` and none of its rows is visible; the new holder's `maxTs` is unchanged |
| K13 | stale writer in flight | a child commits continuously and is SIGSTOPped; the parent takes over, commits, and SIGCONTs it: the child stops with `LeaseLostError`, every commit above the takeover's `maxTs` is the parent's, and the takeover completed within TTL + the store's idle-transaction bound |
| K15 | crash atomicity under the lease | K6 runs with the lease on: each reopen waits out the killed child's lease |
| K16 | index-only commits | a commit with index entries and no documents is counted by `maxTs()` |
| K17 | concurrent first boot | two engines opened at once on an empty store: exactly one succeeds; one catalog, one instance secret |
| K18 | release | after `releaseLease()` (or `Engine.close()`), another holder acquires at once |
| K19 | another process | a child process holds the store: an engine in this process fails `init()` with `LeaseHeldError`; once the child is SIGKILLed, an engine takes the store over (within the TTL, or at once for a process-scoped lease) |
| K20 | a store that stops answering (C8, remote stores) | a TCP proxy between the driver and the store stops forwarding both ways without closing anything: a read fails within the timeout (1.5 s in the suite; two with a retry, C9) and a flush within one, a renewal within TTL/4; the client closes every connection those calls waited on; once the proxy forwards again the same store answers without a reopen; through the engine, a commit whose flush times out is held and retried while the store does not answer, then acknowledged once, its rows stored once (C9); and, with the retries held for 1 s after the thaw, the timed-out attempt sends nothing more (no request with the group's rows, no COMMIT: "a failed attempt stays failed", C9). The driver module exports `target()` and `openThrough(via, { timeoutMs })` |
| K21 | transient errors are retried (C9, remote stores) | the proxy of K20 resets the connection of a request carrying a marker, or lets a COMMIT through and drops every answer after it: a read whose connection is lost answers through one retry, and fails when the retry loses its connection too; a connection lost in the middle of a flush is retried: the commit is acknowledged once and stored once (all three stores; DV-123); a COMMIT that lands while its answer is lost is retried, found landed through the lease record and acknowledged exactly once, the committer still running, and after a reopen the store holds the group exactly once (`auditRowsAt`), with `maxTs` at its ts (DV-124) |
| K22 | layout version | a new store records `LAYOUT_VERSION` and reopens; with its record removed (a store written before C10) it opens with its data and is stamped again; with a future or unknown version (`2`, `999`, `"v1-beta"`) it is refused with `LayoutError` naming it, and the record is left as it was; a store bunvex did not write (Convex's own tables, or a stranger's file) is refused with `LayoutError` and not written to |
| K23 | read-only flag | after `setReadOnly(true)`, opening for writing fails with `ReadOnlyError`; `allowReadOnly` opens it and reads its data; after `setReadOnly(false)`, a writer opens and commits |
| K25 | the log by timestamp (C11) | 300 random commits on a fresh store (sparse timestamps, removed entries, index-only commits, keys longer than 2500 bytes) flushed in groups. `readLog` over the whole log, over 300 random windows (bounds on commits, inside gaps and outside the log; empty windows; limits from 0 up) and paged by 7 equals the reference model: whole commits in ts order, exact write sets, an unbroken `prevTs` chain. A group applied but not flushed is not returned; the log is the same after a reopen. Through the engine, the log between two snapshots is exactly the committer's commits and their write sets (the committer's developer ids mapped to internal ids); a background index backfill (STUDY-29) adds nothing to the log (C17), and its entries cover every document, each at its document version's own ts |
| K26 | bounded flushes (C4, DV-62) | through the engine: 64 writers of 2 KiB documents and one 1 100-document commit, under an injected limit that fails any flush breaking the batch rule (everything before its last commit under 64 documents and 64 KiB): groups are split, no flush is over, the large commit is visible whole at its ts, every document stored; flushes of split groups failing transiently (before the store, or after it with the answer lost) are retried: every commit acknowledged once and stored once, in ts order; SIGKILL in the middle of split groups (a child announces each flush's timestamps before it starts): `maxTs` ≥ the last acknowledged commit, no torn commit, and every announced commit at or below `maxTs` is in `readLog` (a prefix) |
| K27 | the document log (C12) | 400 random commits (inserts, rewrites at the same key, moved keys, deletes, tombstones of documents that never lived, index-only commits) flushed in groups: `readDocumentLog` over the whole log and 200 random windows with limits equals the reference model, whole commits in ts order, each row with its `prevTs` |
| K28 | pruning (C13) | at two successive windows, the prunes retention computes from both logs, applied in random chunks: scans (asc, desc, limited) and gets at snapshots at and above the window answer exactly as before; exactly the superseded rows are gone (`auditRowCount` against the model) and the reported count matches; pruning again deletes nothing; the logs above the window are unchanged; a commit after pruning reads back |
| K29 | globals and the fence (C14, C13) | a global reads back as set (null when unset) and survives a reopen; after `releaseLease`, `pruneIndexes`, `pruneDocuments` and `setGlobal` throw `LeaseLostError` and change nothing; on TTL leases, a holder whose lease was taken over is refused the same way |
| K30 | index references (C15) | an index entry whose document was never written and one whose document was deleted while the entry stayed, among live ones: `scan` over the whole index (both directions), over each broken entry alone and below the delete rejects with `DanglingReferenceError` carrying the right `deleted` flag; `get` is null for both (and the deleted one reads below its delete); ranges with no broken entry return their documents, each with its ts. From Convex's `query_dangling_reference` and `query_reference_deleted_doc` |
| K31 | one id in two tables (C15) | the same id written in two tables in one commit (different documents, one index each), then replaced in one and deleted in the other: `get` and `scan` answer each table's own document at every snapshot. From Convex's `same_internal_id_multiple_tables` |
| K35 | the exact-ts join (C6) | an entry at ts 60 for a document whose only version is at 50 rejects with `DanglingReferenceError` (`deleted` false, the entry's ts 60), although the version at 50 is visible at 60; an entry at 50 joins the version at 50, also after the document gets a version at 70 (read at a snapshot above 70). From Convex's `index_scan_inner` join on `(table, id, ts)` |
| K32 | document versions (C16) | a random history of 200 commits over two tables with the same ids (inserts, rewrites, deletes, re-inserts), flushed in random groups: `getVersions` at 120 random snapshots, with unknown and repeated ids, equals the reference model (version and ts, null when missing or deleted) and agrees with `get`; no ids give `[]` |
| K33 | nanosecond timestamps (C1) | two commits one nanosecond apart at a real ns ts above 2^53 (2026-10-06, with a sub-µs part), then a reopen: `maxTs`, `get` (at T1, T1 + 1 ns, T1 − 1 ns), `getVersions`, `scan`, `readLog` (`prevTs` too) and `readDocumentLog` return the exact values. STUDY-133 PR 1 |
| K34 | `prev_ts` (C1, C12) | versions written directly at 10, 20 and 30 (a delete) with `prevTs` null, 10 and 20: `readDocumentLog` returns them as written after a reopen; through the engine, an insert, two patches and a delete: each version's `prevTs` is the ts of the one before it (null for the insert). STUDY-133 PR 3 |
| K36 | index entries at past timestamps (C17) | three commits (ts 100, 200, 300; a document's second version at 300), then `writeIndexEntries` for a new index at each document's own ts (300 and 200): a scan at 250 sees only the entry at 200, one at 400 both, each joined to its version; an entry at the same (index, key, ts) replaces the stored one (here a removal); the log's commits stay `[100, 200, 300]` with their `prevTs` chain and `maxTs` stays 300; the entries survive a reopen; with another handle holding the lease, `writeIndexEntries` throws `LeaseLostError` and nothing changes. STUDY-133 PR 3 |

Notes from validating the suite (each check was sabotaged and had to go red):
- K6 must count **live documents** (`auditLiveDocs`, audit-only) as well as index entries: a torn commit
  that loses all its index entries leaves the index counts equal to each other.
- K11–K14 test expiry and paused holders: they do not apply to a process-scoped lease (an OS lock has
  neither), which K10, K16–K19 cover.
- K21's landed-group check (v2.3) was sabotaged by making the lease read never find the group: Postgres and
  MySQL stop with `UnsureCommitError` (duplicate key), MongoDB too (its fence); with MongoDB's fence `maxTs`
  check removed as well (and fresh `_id`s), the group is stored twice (2 documents, 6 index entries for 1 and
  3). K21's lost-connection check, with Postgres's `isTransient` back to timeouts only: the committer stops.
  K20's "sends nothing more" check, with `progress()` no longer throwing after a timeout: Postgres and MongoDB
  send 2 requests (the group's rows, a COMMIT) after the thaw, every run; MySQL destroys the connection on a
  timeout and stays green. Each went red.
- K21 and K20's retry check were sabotaged four ways: no flush retry (red on all three remote drivers); no read
  retry (red; MongoDB with `retryReads: false`); a Postgres driver that drops its failed group (the commit is
  acknowledged with no rows); a MongoDB fence without the `maxTs` check and with fresh `_id`s (the group is
  acknowledged and stored twice).
- The proxy recognises a COMMIT as a `COMMIT` statement, MongoDB's `commitTransaction` (not `autocommit`,
  which every command of a transaction carries), or a Postgres Bind of a statement the connection prepared as
  `commit` (postgres.js prepares it once per connection and then sends only its name).
- K20 was sabotaged by disabling `withTimeout`: every call hung past the suite's guard (8 × the timeout).
  MongoDB's server monitor is not a call; its streaming check waits up to the heartbeat plus the connect
  timeout, so the MongoDB module opens with a 1 s heartbeat for K20.
- K14 (a writer paused *inside* its flush transaction) is covered by K13's bound: a SIGSTOP at a random
  moment lands inside the flush often enough, and the takeover must still finish in time.
- K26 was sabotaged three ways (STUDY-06 §10.5): no batch bound (all five drivers red: the injected limit stops
  the committer; on a real MySQL with `max_allowed_packet` = 1 MiB the same group fails with the packet error);
  a commit torn across two batches (red: "torn commit"); batches flushed in swapped pairs (red: `maxTs` below
  the last acknowledged commit, flushed commits missing below `maxTs`).
- K30 went red on Postgres, MySQL and MongoDB before C15 (their `scanDocs` dropped the broken entries and
  returned the rest); K31 was sabotaged with a Postgres `get` that ignores the table (red: table B read
  table A's document).
- K33 was sabotaged four ways (STUDY-133 PR 1): SQLite reading `ts` without safe integers (red: `getVersions`),
  MySQL without `supportBigNumbers` (red: `maxTs`, `getVersions`, both logs), Postgres parsing `ts` through a
  JS number (red: `getVersions`), the memory log writing `ts` through a JS number (red: all six).
- K34–K36 (STUDY-133 PR 3): K34 with the memory driver's `readDocumentLog` returning `prevTs: null` (red: both
  checks); K35 with SQLite's join taking the newest version at or below the entry's ts instead of the version at
  it (red: the entry at 60 returned the version at 50); K36 with SQLite writing entries with `insert or ignore`
  instead of `insert or replace` (red: the replace check and the reopen check) and with Postgres's
  `writeIndexEntries` without its lease fence (red: the refused-writer check). The K30 rewrite (scan rejecting)
  is K30's v2.8 check moved from `scanDocs` to `scan`.
- SIGKILL cannot tear a single `write()`: K6 exercises multi-step flushes (remote stores, commit
  markers); K7 covers the power-loss shape for the append-only log.

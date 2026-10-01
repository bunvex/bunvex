# PERSIST-01 — the persistence contract

> v1, 29 Sep 2026 (written as STORAGE-01; renamed by ARCH-01 D2 — "storage" is the FILE API, as in
> Convex). **v2, 30 Sep 2026:** C7 (single writer: lease and fencing) and K10–K18, from STUDY-24 H8/H5. Every persistence driver (`memory`, `sqlite` in `@bunvex/core`; `postgres`, `mysql`,
> `mongodb` in `@bunvex/persistence`; and third-party ones) implements `Persistence`
> (`packages/core/src/persistence/index.ts`) and must pass `@bunvex/persistence-conformance`
> (`bun bench/conformance.ts` runs it on every first-party driver). The engine core (OCC, committer,
> query cache, subscriptions) never looks past this interface — that is what lets a new store be added
> without touching the core.

## C1 — what is stored

Two logical collections, Convex's shape:

- **documents**: `(table_id, id, ts) → json | deleted`. Every version of every document, never updated
  in place.
- **indexes**: `(index_id, key, ts) → document_id | deleted`. Every version of every index entry.

`key` is an opaque byte string produced by `src/keyenc.ts`. `ts` is the commit timestamp assigned by the
committer: a strictly increasing integer, the wall clock in microseconds as Convex's `next_commit_ts`
does it in nanoseconds (`max(last + 1, clock)`; STUDY-06 D9). Timestamps are therefore **sparse**: a
driver must not assume that `ts + 1` is the next commit.

## C2 — ordering

`scan` MUST return keys in **unsigned byte-wise order** of `key` (memcmp; a shorter key that is a
prefix of a longer one sorts first). The whole read-set / invalidation model depends on it: a store whose
native ordering differs (MongoDB compares `BinData` by length first) must re-encode the key into
something whose native order is byte order (e.g. lowercase hex strings) — inside the driver.

## C3 — snapshot reads

For a snapshot `T`:

- `get(table, id, T)` returns the newest version with `ts ≤ T`, or null if that version is a delete or
  none exists.
- `scan(index, lo, hi, T, limit, desc)` returns, in key order (reversed if `desc`), the document ids of
  the newest `ts ≤ T` version of each key in `[lo, hi)` that is not a delete, up to `limit`.
  "Up to `limit`" means **exactly** `min(limit, live keys in the range)`: removed entries and older
  versions never count toward the limit. A driver that reads rows in `(key, ts desc)` order must page
  until it has `limit` live ids or the range is exhausted; `scanLatest`/`scanLatestSync` in
  `@bunvex/core/persistence` do this. `limit ≤ 0` returns nothing.
- Keys have **no length limit**. A store whose indexed columns are limited stores a key as Convex does:
  `key_prefix` (the first 2500 bytes), `key_suffix` and `key_suffix_hash`. It restores the true order among
  keys that share a full-length prefix (`splitKey` / `splitPages` in `@bunvex/core/persistence`).
- Rows with `ts > T` MUST NOT influence the answer, even if they are already stored (the committer
  applies a group before it is durable; readers at an older snapshot must not see it).
- A snapshot older than the newest one still answers from the versions it saw (history is kept until
  retention, which is out of scope for v1).

## C4 — writes and durability

- `apply(ts, docs, idx)` is called once per commit, in increasing `ts` order, possibly several times
  before one `flush()`.
- `flush()` returns once **every applied commit is durable**. The engine acknowledges a commit to its
  client only after the `flush()` covering it resolves.
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

## C6 — optional fast paths

- `scanDocs(table, index, lo, hi, T, limit, desc)` (interface `ScanDocs`): the documents (JSON) for what `scan` would return,
  in one round trip. Same semantics as `scan` + `get` for each id.

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
runs out. The lease is renewed every TTL/3; `LeaseLostError`, or a renewal still failing when the TTL
runs out, stops the committer (fail-stop, as a failed flush). `Engine.close()` releases it.

## Conformance (`@bunvex/persistence-conformance`)

| # | property | how |
|---|---|---|
| K1 | byte order | random mixed-type tuples, encoded, applied, scanned: order equals `compareKeys` |
| K2 | snapshots | every write is tagged; for random past snapshots the answers equal a reference model |
| K3 | no lost update | 64 concurrent increments of 1 and of 4 counters through the engine |
| K4 | cache invalidation | an insert outside a cached range keeps the entry, one inside it is seen |
| K5 | atomic visibility | readers racing 2-document mutations never see one of the two |
| K6 | crash atomicity (process crash) | a child process commits continuously and is SIGKILLed at random moments, N times; after each kill the store reopens with `maxTs ≥` the last acknowledged commit, every commit `≤ maxTs` is complete (doc + all its index entries), none above it is visible, and writing resumes above `maxTs` |
| K7 | torn tail (log-based drivers) | half a record appended to the log: it is cut off on open, and a commit written after recovery survives the next reopen |
| K8 | exact limits | a range whose ends are full of deleted keys and whose live keys have hundreds of versions: for limits 0–100, asc and desc, whole and partial ranges, at several snapshots, `scan` (and `scanDocs`) return exactly the reference model's first `limit` live entries |
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

Notes from validating the suite (each check was sabotaged and had to go red):
- K6 must count **live documents** (`auditLiveDocs`, audit-only) as well as index entries: a torn commit
  that loses all its index entries leaves the index counts equal to each other.
- K11–K14 test expiry and paused holders: they do not apply to a process-scoped lease (an OS lock has
  neither), which K10, K16–K19 cover.
- K14 (a writer paused *inside* its flush transaction) is covered by K13's bound: a SIGSTOP at a random
  moment lands inside the flush often enough, and the takeover must still finish in time.
- SIGKILL cannot tear a single `write()`: K6 exercises multi-step flushes (remote stores, commit
  markers); K7 covers the power-loss shape for the append-only log.

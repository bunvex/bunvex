# PERSIST-01 — the persistence contract

> v1, 29 Sep 2026 (written as STORAGE-01; renamed by ARCH-01 D2 — "storage" is the FILE API, as in
> Convex). Every persistence driver (`memory`, `sqlite` in `@bunvex/core`; `postgres`, `mysql`,
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
committer: a strictly increasing integer.

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
  the marker and reads never see rows above it (recovery may delete them).

## C5 — recovery

`maxTs()` returns `M` from C4. On open, the engine resumes its committer at `M`: the next commit gets
`M + 1`, and `M` is the first snapshot served. A driver keeping state in memory (the memory+log store)
rebuilds it from its log, ignoring a torn trailing record.

## C6 — optional fast paths

- `scanDocs(table, index, lo, hi, T, limit, desc)` (interface `ScanDocs`): the documents (JSON) for what `scan` would return,
  in one round trip. Same semantics as `scan` + `get` for each id.

## Conformance (`@bunvex/persistence-conformance`)

| # | property | how |
|---|---|---|
| K1 | byte order | random mixed-type tuples, encoded, applied, scanned: order equals `compareKeys` |
| K2 | snapshots | every write is tagged; for random past snapshots the answers equal a reference model |
| K3 | no lost update | 64 concurrent increments of 1 and of 4 counters through the engine |
| K4 | cache invalidation | an insert outside a cached range keeps the entry, one inside it is seen |
| K5 | atomic visibility | readers racing 2-document mutations never see one of the two |
| K6 | crash atomicity (process crash) | a child process commits continuously and is SIGKILLed at random moments, N times; after each kill the store reopens with `maxTs ≥` the last acknowledged commit, every commit `≤ maxTs` is complete (doc + all its index entries), none above it is visible, and writing resumes at `maxTs + 1` |
| K7 | torn tail (log-based drivers) | half a record appended to the log: it is cut off on open, and a commit written after recovery survives the next reopen |
| K8 | exact limits | a range whose ends are full of deleted keys and whose live keys have hundreds of versions: for limits 0–100, asc and desc, whole and partial ranges, at several snapshots, `scan` (and `scanDocs`) return exactly the reference model's first `limit` live entries |
| K9 | long keys | incompressible keys up to 6 KB, many sharing their first 2500+ bytes, plus keys around the 2500-byte boundary, with versions and deletes: scans over whole and partial ranges (bounds that are themselves long keys), both directions, several limits and snapshots, equal the reference model |

Notes from validating the suite (each check was sabotaged and had to go red):
- K6 must count **live documents** (`auditLiveDocs`, audit-only) as well as index entries: a torn commit
  that loses all its index entries leaves the index counts equal to each other.
- SIGKILL cannot tear a single `write()`: K6 exercises multi-step flushes (remote stores, commit
  markers); K7 covers the power-loss shape for the append-only log.

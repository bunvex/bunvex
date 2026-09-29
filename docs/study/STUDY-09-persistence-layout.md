# STUDY-09 — Persistence layout and drivers

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
- **Related:**
  - [PERSIST-01](../specs/PERSIST-01-contract.md).
  - [ENGINE-00](../specs/ENGINE-00-requirements.md) §1.
  - [STUDY-06](STUDY-06-transactions-and-occ.md): flush failure.

## 1. How Convex does it

### 1.1 Tables

The schema lives in `crates/postgres/src/sql.rs` (`init_sql`), `crates/sqlite/src/lib.rs` (around
line 609) and `crates/mysql/src/sql`.

**`documents`**: `(id BYTEA, ts BIGINT, table_id BYTEA, json_value BYTEA, deleted BOOLEAN, prev_ts BIGINT)`

- The primary key is `(ts, table_id, id)`. There are secondary indexes `(table_id, id, ts)` and
  `(table_id, ts, id)`.
- **`prev_ts`** links each version to the previous one. It is needed for retention and for
  `previous_revisions` (rebuilding the write log and the history of a document).
- The `(ts, …)` order lets Convex read **the log by timestamp** (`load_documents`,
  `load_docs_by_ts_page_*`). That serves startup, index backfill, retention, streaming export and the
  write log.

**`indexes`**: `(index_id BYTEA, ts BIGINT, key_prefix BYTEA, key_suffix BYTEA NULL, key_sha256 BYTEA, deleted BOOLEAN, table_id BYTEA NULL, document_id BYTEA NULL)`

- The primary key is `(index_id, key_sha256, ts)`. The scan index is `(index_id, key_prefix,
  key_sha256)`.
- **Long keys are split** (`SplitKey`, `MAX_INDEX_KEY_PREFIX_LEN = 2500` in
  `crates/common/src/index.rs`): the first 2 500 bytes go in `key_prefix`, the rest in `key_suffix`.
  The SHA-256 of the full key keeps the primary key small and unique. This is because Postgres'
  B-tree limit is about 2.7 KB per entry ("Postgres maximum primary key length is 2730 bytes" in
  `sql.rs`). MySQL uses the same prefix + sha256 idea. SQLite stores the full `key BLOB` with
  `PRIMARY KEY (index_id, key, ts)`.
- An index entry is written for **every document version**, even when its key did not move, with the
  version's `ts`. The scan then joins the document **by exact `ts`**
  (`LEFT JOIN documents D ON D.ts = A.ts AND D.table_id = A.table_id AND D.id = A.document_id`).
- `persistence_globals`, `leases` and `read_only` hold the max repeatable ts, leader leases and
  maintenance mode.

### 1.2 Reading a range

- The `index_scan` SQL in `crates/postgres/src/sql.rs` uses `DISTINCT ON (key_prefix, key_sha256)
  … ORDER BY key, ts DESC LIMIT n`. It returns the newest version of each key, **tombstones
  included**, and pages.
- The `Persistence::index_scan` stream (`crates/common/src/persistence/mod.rs`) keeps fetching
  pages until the caller has enough **live** rows or the range ends. A tombstone or an old version can
  never shorten a result.

### 1.3 Writing

- The committer's write batcher (`crates/database/src/write_batcher.rs`, knobs
  `COMMITTER_MAX_WRITE_BATCH_*`) writes batches of commits, each atomically.
- `TRANSACTION_MAX_NUM_USER_WRITES`'s comment ties it to the drivers' `MAX_INSERT_SIZE`.

### 1.4 Retention

`crates/database/src/retention.rs`:

- **Index versions** older than `INDEX_RETENTION_DELAY` (4 min) are deleted.
- **Document versions** are kept for `DOCUMENT_RETENTION_DELAY` (14 days), then deleted.
- Snapshots older than the retention window cannot be read.

## 2. What an app can observe

This layer is internal, except through:

- **correctness of query results**, which depends on the scans;
- **limits:** any value Convex accepts in an index (strings up to the 1 MiB document size) can be
  indexed on every backend;
- **performance and storage growth over time**, which depends on retention.

## 3. How bunvex does it today

PERSIST-01 C1 keeps Convex's two logical tables, with a smaller shape:

- `documents(table_id, id, ts, json_value, deleted)`, primary key `(table_id, id, ts)`, with no
  `prev_ts` and no by-ts index;
- `indexes(index_id, key, ts, deleted, document_id)`, primary key `(index_id, key, ts)`, with the
  **full key** in one column.

Keys are the `keyenc.ts` bytes. MongoDB stores them hex-encoded, because BinData compares by length
first.

Per driver:

- **Memory** (`packages/core/src/persistence/memory.ts`): versions live in B-trees, with a JSON line
  per commit and one fdatasync per group. `scan` walks the range and skips invisible and tombstoned
  entries until it has `limit` rows. **Correct.**
- **SQLite** (`packages/core/src/persistence/sqlite.ts`): `scan` fetches `limit * 4` rows ordered by
  `(key, ts desc)`, then keeps the first row of each key. The comment says "For the bench's
  insert-only data every key has one". **A key with more than a few versions, or a range starting
  with tombstones, uses up the over-fetch and returns fewer than `limit` rows.** Probes:
  - after 10 patches of the first document, `take(2)` returned 1 row;
  - after deleting the 9 oldest of 10 documents, `first()` returned `null`.
- **Postgres** (`packages/persistence/src/postgres.ts`): `DISTINCT ON (key)` with `LIMIT limit * 2`,
  and the same in `scanDocs`. Versions are collapsed correctly, but **tombstones count against the
  limit and nothing pages**. If more than `limit` of the first `2·limit` keys are deleted, the result
  is short. Keys are `bytea` in the primary key, so a key over about 2.7 KB (the B-tree entry limit, measured after compression) fails the insert
  ("index row size exceeds maximum").
- **MySQL** (`packages/persistence/src/mysql.ts`): `limit * 4` over-fetch, with the same bug as
  SQLite. `` `key` varbinary(512) ``: **an index key over 512 bytes fails the flush.** That is an
  indexed string of about 470 bytes or more (the key adds a tag, a terminator and the `_id`), e.g. a title or a URL. `id varchar(64)` uses the server's
  default (often case-insensitive) collation.
- **MongoDB** (`packages/persistence/src/mongodb.ts`): `limit * 4` over-fetch, the same bug. It
  relies on a commit marker for crash atomicity.

Common to all drivers:

- A new index entry is written for every document version, as in Convex (`Tx.toWrites`, "the entry
  is rewritten so its version … reflect[s] the change"). The scan fetches the document by "newest
  version ≤ ts" rather than by exact `ts`.
- There is no retention: every version and tombstone is kept forever. The memory driver keeps
  everything in RAM, and its `visible()` walks a key's version list linearly.
- There is no by-ts log read (`load_documents`), which retention, backfill, export and a future
  write-log rebuild will need.
- The conformance suite (`packages/persistence-conformance/src/index.ts`, K1/K2) scans with limits of
  1 000 or more over at most 60 ids, so the over-fetch bugs never trigger in it.

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | SQLite, MySQL and MongoDB fetch a fixed `limit * 4` rows and do not page; versions and tombstones consume it (`sqlite.ts:56`, `mysql.ts:59`, `mongodb.ts:79`) | BUG | `take`/`first`/`collect` return short or `null` results after ordinary patches and deletes. Every patch rewrites the `by_id`/`by_creation_time` entry, so a document patched a few times is enough | **fixed in #8** |
| D2 | Postgres uses `LIMIT limit * 2` after `DISTINCT ON`, without paging; tombstones consume it (`postgres.ts:64`, `:98`) | BUG | Short or `null` results after deletes, e.g. a queue whose head was consumed | **fixed in #8** |
| D3 | MySQL `key varbinary(512)`; Postgres full key in the primary key (about 2.7 KB max); no prefix/sha256 split | BUG | Indexing a long string makes the flush fail, and with STUDY-06 D1 the failed commit even becomes visible. Convex splits keys at 2 500 bytes plus a SHA-256 | owner |
| D4 | The conformance suite does not exercise small limits with many versions and tombstones | BUG (test gap) | D1/D2 pass K1–K7. The suite should include them | owner |
| D5 | No retention of old versions or tombstones | INTERNAL | Storage and memory grow without bound; scans slow down as tombstones accumulate. Not observable in results. Convex keeps index versions 4 min and documents 14 days | owner |
| D6 | No `prev_ts`, and no by-ts index or log read (`load_documents`) | INTERNAL | Needed for retention, backfill (STUDY-05 D11), export and write-log rebuild | owner |
| D7 | Documents are joined by "newest ≤ ts" per id, not by exact `ts` from the index entry | INTERNAL | Same answer, one extra ordered lookup per row | owner |
| D8 | Column types: `id text`/`varchar(64)`, `table_id int`, JSON as text, vs Convex's `BYTEA` ids and binary JSON | INTERNAL | Follows from STUDY-01. `varchar(64)` must fit the final id format | owner |
| D9 | Unbounded group size per flush, vs Convex's batcher (≤64 docs / 64 KiB) | INTERNAL | A large group can exceed a remote store's packet or statement limits (MySQL chunks at 2 000 rows, Postgres sends one jsonb parameter) | owner |

## 5. Tests

- **Scan with small limits:** a conformance case with keys that have many versions, and ranges
  starting with long runs of tombstones. `scan(…, limit)` for `limit ∈ {1, 2, 3}` must equal the
  reference model, in both directions.
- **Long keys:** index a 1 000-byte and a 100 KB string on every driver, then insert, patch and
  query them.
- **Retention (when added):** old versions are removed while every snapshot still inside the window
  answers the same.

## 6. Open questions

1. Should the fix for D1/D2 live in the drivers (page until `limit` live rows), or should the
   `Persistence.scan` contract become a stream or cursor (`scan` returns rows plus a resume key), as in
   Convex? The second also enables pagination and read-limit accounting.
2. Should PERSIST-01 adopt Convex's `key_prefix` + `key_sha256` layout for every SQL driver?

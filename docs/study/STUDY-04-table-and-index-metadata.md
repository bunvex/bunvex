# STUDY-04 — Table and index metadata (`_tables`, `_index`)

- **Status:** accepted (fixes a bug found in STUDY-01); implemented in the PR that adds this file
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-01](STUDY-01-document-ids.md) (ids carry the table number),
  [PERSIST-01](../specs/PERSIST-01-contract.md) (persistence stores table and index ids)

## 1. How Convex does it

- **Metadata is data.**
  - Every table is a document in the system table `_tables`, holding its name, number, state and
    namespace (`TableMetadata`, `crates/common/src/bootstrap_model/tables.rs`).
  - Every index is a document in `_index`, holding its name, table, fields and state
    (`IndexMetadata`, `crates/common/src/bootstrap_model/index/`).
  - Both are read and written in ordinary transactions. Creating a table or an index is atomic with
    the writes around it, and a snapshot sees the catalog as it was at that timestamp.
- **Two identities per table.**
  - The **table number** (`TableNumber`) is the small integer inside every document id.
  - The **tablet id** (`TabletId`), the internal id of the table's `_tables` document, is what
    persistence stores.
  - A deleted table's documents stay under its old tablet. A new table with the same name gets a new
    tablet, so old data never reappears.
- **Numbering** (`crates/database/src/bootstrap_model/table.rs`, `next_table_number`):
  - A new user table takes the first number above 10 000 that no table in its namespace uses.
  - System tables take the first number above 512.
  - Numbers are never reassigned while the table exists; the one-argument `db.get(id)` depends on this.
  - The bootstrap tables have fixed numbers (`DEFAULT_BOOTSTRAP_TABLE_NUMBERS` in
    `bootstrap_model/defaults.rs`): `_tables` = 513, `_index` = 514.
- **Bootstrap:** the tablet ids of `_tables` and `_index`, and their `by_id` indexes, are stored as
  persistence globals (`Database::get_meta_ids`, `crates/database/src/database.rs`). Reading them is how
  the database finds everything else at startup.
- **Tables appear on first insert.** `insert_table_metadata` creates the table implicitly when an app
  writes to a table that does not exist. A schema is optional.
- **Index lifecycle** (`DatabaseIndexState`): `Backfilling` → `Backfilled` → `Enabled`.
  - A new index is backfilled in the background, while new writes already maintain it.
  - It serves reads only once it is enabled.
  - Changing an index's fields means deleting it and adding a new one.
- **Names** (`check_valid_identifier`, `crates/convex/sync_types/src/identifier.rs`):
  - at most 64 characters;
  - the first character is an ASCII letter or `_`;
  - the rest are ASCII letters, digits or `_`;
  - a leading `_` is reserved for system tables.

## 2. What an app can observe

1. A table keeps its number for its whole life, whatever happens to the schema (the number shows in
   every id).
2. Reordering, adding or removing tables and indexes in the schema never moves data between tables.
3. An index added to a table that already has documents returns them all once it is available.
4. Invalid table or index names are rejected, and so are user names starting with `_`.

## 3. How bunvex did it (the bug)

- `Schema.table()` assigned table and index ids in **declaration order**, and those ids were what
  persistence stored.
- Inserting a table before another one, removing one, or reordering them silently re-pointed existing
  data at other tables and indexes on the next start.
- A new index on a non-empty table was never backfilled.

## 4. How bunvex does it now

`packages/core/src/catalog.ts`:

- **System tables.** `_tables` and `_index` are system tables stored like any other (same MVCC, same
  commits).
  - They have fixed tablet and index ids for bootstrap: `_tables` is tablet 1 with indexes 1 and 2;
    `_index` is tablet 2 with indexes 3 and 4.
  - Their Convex numbers are 513 and 514.
- **User tables.** A user table's `_tables` document holds `{ name, number, tablet, state }`.
  - `number` follows Convex: the first free number above 10 000.
  - `tablet` is the next unused persistence table id and is never reused.
- **Indexes.** An index document holds `{ table, name, fields, indexId, state }`. The index id is the next
  unused persistence index id.
- **At `Engine.init()`**, the catalog is read at the durable snapshot and reconciled with the declared
  schema in one mutation (Convex's push start, STUDY-29 §3):
  - a missing table is created, with its two system indexes;
  - a missing index is created in state `backfilling`;
  - an index whose fields changed gets a new version under a new index id; the old one serves until the
    new one is enabled;
  - an index no longer declared is removed from `_index` when the schema change finishes (a pending one
    at once). Its entries stay until retention exists.
- **Backfill** ([STUDY-29](STUDY-29-index-backfill.md)). `init()` returns without waiting: a background
  worker fills a `backfilling` index from the table's live documents, in chunks committed under OCC while
  every write already maintains it. Then it is `backfilled`, and the schema change enables it
  (`indexesReady()` resolves). Until then a query on it fails with Convex's `IndexBackfillingError`, and a
  changed index keeps serving its old version.
  - Progress is checkpointed in `_index_backfills`; after a crash the next start resumes from there.
  - Staged indexes (`{ fields, staged: true }`) are backfilled and never enabled, as Convex's.
- **Resolved catalog.** Each `Engine` owns its resolved catalog (`engine.catalog`). The declared `Schema`
  is never mutated, so one schema object can serve several engines on different stores (the
  conformance suite does this).
- **Names** are checked with Convex's identifier rule when the schema is declared.

## 5. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The tablet id is a small integer allocated from a counter, not a random 16-byte id; `_tables` and `_index` have fixed ids instead of persistence globals | PERSIST-01 stores integer ids. Fixed bootstrap ids replace the globals. Not observable. | owner |
| D2 | ~~Tables exist only if the schema declares them~~ Fixed in #33: a first insert creates the table in the same transaction | — | done |
| D3 | ~~Backfill runs synchronously at startup, before the server accepts requests, instead of in the background~~ | Decided (owner, 2026-10-01): match Convex. Done in [STUDY-29](STUDY-29-index-backfill.md): background worker, checkpoints, resume. What differs is STUDY-29 B1 and B2 (DV-126, DV-127, pending). | done (DV-54) |
| D4 | ~~No `Backfilled`/staged state~~ and no namespaces (components) | Decided (owner, 2026-10-01): match Convex. `backfilled` and staged indexes done in STUDY-29; namespaces (components) remain a gap. | partly done (DV-55) |
| D5 | Stores created before this change are not readable (no migration) | Pre-alpha; bench data is reseeded | owner |

## 6. Tests

- A fresh store gets `_tables`/`_index` documents and user table numbers 10001, 10002, …
- Restart with a **reordered schema** and with a table **inserted before** the existing ones: every
  document is still found in its own table, with the same numbers and ids.
- A new index on a non-empty table returns every document after init. A changed index's fields are
  honoured, and a removed index disappears.
- Invalid names and user names starting with `_` are rejected.
- Sabotage: assigning ids by declaration order again makes the reorder test fail.
- PERSIST-01 conformance on all drivers.

# STUDY-205 — Table iterator: reading a snapshot past the index window
<!-- index: Table iterator (Convex's `TableIterator`): a snapshot read after the 4-minute index window passed it, from recent `by_id` pages plus the document log; the ZIP export (audit B8) and `list_snapshot` (DV-306) read through it | built -->

The 2026-11-03 production audit (B8) found a gap in the ZIP export (STUDY-42). It read every page at its snapshot's
ts. Retention refuses a read below the index window, which trails the newest commit by 4 minutes (STUDY-33,
`Retention.check`). So an export that ran longer than 4 minutes failed with `OutOfRetention` and retried, with
backoff, at a new snapshot. An export of a large deployment never completed, and its backups stopped. Convex's
export does not fail this way: it reads through its table iterator.

## 1. How Convex does it

`crates/table_iteration/src/table_iterator.rs`, `TableIterator` and `MultiTableIterator`.

- **The problem it solves** (`stream_documents_in_table`'s comment, `:383-407`): "Walk a table ordered by an index
  at snapshot_ts which may be outside retention, so you can't walk the index directly."
- **The algorithm:**
  1. Walk the index at recent, increasing snapshots, keeping the documents that have not changed since
     `snapshot_ts`.
  2. Walk the document log between `snapshot_ts` and those snapshots. For each document that changed, take its
     revision as of `snapshot_ts`: the first `prev_ts` seen for each id points at it, and a null `prev_ts` means a
     document created after the snapshot, which is not in it.
  3. Merge the two, in index key order. A changed document whose key is past the walk's cursor waits in
     `skipped_keys` until the page that covers it.
- **Why it is complete:** a document of the snapshot either changed since it (2 finds it) or did not (1 finds it).
- **Many tables:** the document log cannot be filtered by table, so `MultiTableIterator` reads it once for every
  table registered and keeps each table's changed ids until that table is walked (`unregister_table` drops them).
- **Which window bounds it:** the index pages are recent, so the index window never refuses them. The document
  log and revisions are read through `RepeatablePersistence` with the retention validator, which refuses a
  snapshot the *document* window has passed (`validate_document_snapshot`, `crates/database/src/retention.rs:1620`:
  "Document snapshot timestamp out of leader retention window: {ts} < {min}").
- **Users:** the ZIP export (`crates/exports/src/lib.rs:210`, one `MultiTableIterator` for every table and each
  namespace's `_file_storage`), and `list_snapshot` (`crates/database/src/database.rs:2325`, cached across
  calls), among others. The export writes its tables smallest first partly because "TableIterator has an
  overhead proportional to the time since `snapshot_ts`" (`lib.rs:350-353`).
- It reads persistence directly, not through the index cache.

## 2. What apps observe

- A ZIP export completes however long it takes, as long as the document window (14 days) holds its snapshot. Its
  contents are the snapshot's, with no write made after it.
- An export whose snapshot the document window passed fails with `OutOfRetention`.

## 3. How bunvex does it

`packages/core/src/table-iterator.ts`, `TableIterator`, exported from `@bunvex/core`. It takes:

- the engine (its persistence, committer and retention);
- the snapshot;
- every table to be read;
- a page size.

`pages(table)` yields the table's documents at the snapshot, in `by_id` order. For each page:

1. **Checks** the document window (`Retention.checkDocuments`, Convex's message).
2. **Reads** the document log (PERSIST-01 C12, `readDocumentLog`) up to the visible ts. Each id of a registered
   table that is past that table's walk is noted, with its `by_id` key, computed from the table number and the
   internal id.
3. **Scans** a page of `by_id` at the visible ts, then checks the index window for it. The noted ids are left out:
   their version there is not the snapshot's.
4. **Merges** in the noted ids up to the page's last key (all of them on the last page), each at its version at
   the snapshot (`getVersions`, PERSIST-01 C16), skipping the ones that did not exist then. The page is then
   sorted by key. This replaces Convex's `prev_ts`: bunvex's store reads an id's version at any ts the document
   window holds, so the snapshot itself is the lookup.

A store without a document log (a third-party driver without `RetentionStore`) or an engine without retention
keeps every version, so the snapshot is read directly.

`ExportService.run` (`packages/server/src/exports.ts`) creates one iterator for the export's tables. With
`includeStorage` it also takes each namespace's `_file_storage`. The tables and files are read through it, as
Convex's export does. The snapshot ts, the component paths and the progress messages are unchanged.

### Tests

- `packages/core/test/table-iterator.test.ts`:
  - Two tables are read in pages of 3 after the index window has passed the snapshot (a read at the snapshot
    itself is refused). Between pages, writes go on in both tables: a patch of a document already read, a patch
    of one not read yet, a delete, an insert. Retention advances and prunes. Each table equals the snapshot, in
    order.
  - A snapshot the document window passed is refused with Convex's message.
- `packages/server/test/exports.test.ts`: an export holds after its snapshot. Meanwhile one document is patched,
  one deleted and one inserted, and the index window passes it all. The export completes, once, with the
  snapshot's five documents.

Sabotage, each making a test fail:

- The export as it was on `main`: it fails with `OutOfRetention`, retries at a newer snapshot, and exports the
  later state.
- Changed ids kept in the index page: their later versions are exported.
- Changed ids read at the page's ts instead of the snapshot's: the same.
- The document log not read: deletes and patches are missed.
- An id noted again after the walk passed it: it is exported twice.
- Noted ids merged into the first page whatever their key: the order breaks.
- The document-window check dropped: the old snapshot is read without an error.

### Measurement

The ZIP export of 200 000 documents (about 120 bytes each) on SQLite, best of 4 runs:

| | index cache off | index cache on |
|---|---|---|
| `main` | 2 210 ms | 2 383 ms the first run, then 462 ms |
| this PR | 2 225 ms | 2 345 ms (every run) |

With the cache cold the cost is the same. On `main`, a second export ran faster only because the first one had put
the whole table in the index cache (512 MiB), pushing out what queries had there. The iterator reads persistence
directly, as Convex's does.

## 4. Divergences

None new. B8 was not a recorded divergence: Convex's export does not fail this way. DV-306 is resolved by §5.

## 5. `list_snapshot`

DV-306 had accepted a `list_snapshot` that read its snapshot only within the index window, until bunvex had a table
iterator (owner, 2026-10-03). The owner chose to match Convex now (2026-11-04).

### How Convex does it

`Database::list_snapshot` (`crates/database/src/database.rs:2325-2595`):

- **Its tables and component paths are the snapshot's.** `snapshot_table_mapping` (`:1361-1388`) reads `_tables`
  through a table iterator and keeps the *active* tables, so a table deleted since the snapshot is listed and one
  created since is not. `snapshot_component_paths` (`:1431-1458`) reads `_components` the same way, and
  `snapshot_by_id_indexes` reads `_index`. Each is cached per snapshot ts.
- **The tables left are walked by tablet,** from the cursor's on. The iterator reads pages of 100 (`table_iterator(snapshot,
  100)`), and a call returns up to `SNAPSHOT_LIST_LIMIT` (1024) documents or `SNAPSHOT_LIST_TIME_LIMIT` (60 s). The
  cursor is the last document's id. When the table ends, the cursor is the next table's start.
- **One iterator is kept between calls** (`list_snapshot_table_iterator_cache`, one entry), with its key: the
  snapshot, the tablets left, the `by_id` index and the cursor. A call whose key matches takes it and continues the
  stream. Otherwise it starts a new iterator, from the cursor. The entry is cleared while a call holds it. The
  stream continues into the next table on the same `MultiTableIterator`, so the document log read for the first
  table serves the next ones.
- **Age:** `LIST_SNAPSHOT_MAX_AGE_SECS` (5 days), and the iterator's document-window check.

### How bunvex does it

`listSnapshot` (`packages/server/src/streaming-export.ts`):

- `snapshotTables` (`packages/core/src/table-iterator.ts`) reads `_tables` and `_components` through a table
  iterator at the snapshot. The active user tables then are kept, in a namespace with a component path then, by
  tablet. A table deleted since is read with its definition, which the catalog keeps until the document window has
  passed its deletion and its documents are purged (PERSIST-01 C18). That is longer than the 5-day age limit.
- The iterator is created for every selected table from the cursor's on, in pages of 100. `revisions(table, after)`
  gives each document with the ts of its version at the snapshot, so a value's `_ts` takes no extra read.
- **The cache is one entry per engine:** the snapshot, the selection, the tables left, the iterator, the cursor the
  next call continues from, and the current table's stream with the documents read but not returned. A call takes
  it out and puts it back when it ends, as Convex's does. A call that does not continue it starts a new iterator,
  from its cursor. That covers a repeated cursor, a second connector, or a restart.
- An `OutOfRetentionError` (the document window has passed the snapshot) is `SnapshotTooOld`, as before.
- Not taken: `SNAPSHOT_LIST_TIME_LIMIT`. A page of 1024 is read in milliseconds, far from 60 s.
- `document_deltas` is unchanged: it reads the document log, as Convex's does.

### Tests (`packages/server/test/streaming-export.test.ts`)

- **Across pages, with writes going on.** Two tables (2 500 and 3 documents) are listed at once at a snapshot. Then
  the same snapshot is listed again, past the index window, with writes between pages:
  - patches of documents already listed and not yet listed;
  - deletes and inserts;
  - a new table;
  - a patch of the small table, which is then deleted.

  The pages equal the first listing's, cursors included. In the middle, a cursor that does not continue the last
  page gets the same page as before.
- **Too old.** A snapshot the document window passed is `SnapshotTooOld`.

Sabotage, each making the first test fail:

- `list_snapshot` as it was: `SnapshotTooOld`.
- The latest catalog's active and hidden tables: the deleted table is missing.
- Every table the catalog has now: the new table gets a page.
- The cached iterator taken whatever the cursor: the repeated cursor gets the wrong page.
- The documents read but not returned dropped from the cache: they are missing.

### Measurement

A whole `list_snapshot` of 200 000 documents (about 120 bytes each) on SQLite, index cache off, best of 4: 3 607 ms
before, 2 047 ms now. The kept iterator reads each page once, where each call used to run a query and then read
the versions of its 1024 documents.

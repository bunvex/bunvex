# STUDY-42 — Snapshot export and import (`bunvex export`, `bunvex import`)

- **Status:** accepted: all as recommended (owner, 2026-10-02); X6–X8 (found while building PR 3) accepted as recommended (owner, 2026-10-02), X6 and X7 built in #209
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:**
  - roadmap item 14 ([parity README](../parity/README.md));
  - [STUDY-04](STUDY-04-table-and-index-metadata.md) (the catalog);
  - [STUDY-32](STUDY-32-file-storage.md) (file storage, blob stores per use case);
  - [STUDY-33](STUDY-33-retention.md) (retention);
  - [STUDY-34](STUDY-34-admin-keys.md) (operations).

## 1. How Convex does it

### 1.1 Export (`crates/exports`, `crates/application/src/exports`, `crates/model/src/exports`)

**The ZIP**
- Entries are deflated, in this order:
  1. `README.md`, with fixed text;
  2. `_tables/documents.jsonl`, with `{"name","id"}` per user table, by table number;
  3. each user table, smallest first: `<table>/documents.jsonl`, then `<table>/generated_schema.jsonl`;
  4. with `includeStorage`, `_storage/documents.jsonl` (`{_id, _creationTime, sha256, size, contentType, internalId}`) and one entry per file, `_storage/<storageId><.ext>` (the extension guessed from the content type; the order arbitrary).
- Components live under `_components/<name>/…`.

**Documents**
- They are written in `_id` order, one JSON object per line, in the "clean lossless" encoding:
  - int64 is a plain JSON integer;
  - float64 always has a decimal point (`123.0`, `-0.0`);
  - NaN and ±Inf are `{"$float": base64}`;
  - bytes are `{"$bytes": base64}`;
  - keys are in byte order.
- `generated_schema.jsonl` is one line, `"uniform"`, which tells import which encoding the documents use.

**Consistency:** the whole export reads one snapshot. Its timestamp names the export.

**`_exports` system table**
- States: `requested` → `in_progress` (with `progress_message`) → `completed` (`start_ts` = the snapshot ts, `zip_object_key`, `size`, `expiration_ts`), or `failed` / `canceled`.
- One export at a time: `ExportInProgress`, "There is already an export requested or in progress.".
- An export expires 14 days after its start (custom: at most 60 days). A cleanup worker deletes rows and zips 30 days past their expiration; downloads do not check expiration.
- The zip goes to the `exports` blob store.
- Over 1 TiB of file storage, the export fails with `ExportFileStorageTooLarge`.

**HTTP**

| Endpoint | Operation | What it does |
|---|---|---|
| `POST /api/export/request/zip?includeStorage=` | `CreateBackups` | Requests an export |
| `GET /api/export/zip/{id or snapshot ts}` | `DownloadBackups`, or a 5-minute token | Downloads it as `snapshot_<deployment>_<ts>.zip`; errors `ExportNotFound`, `ExportNotComplete`, `BadSnapshotId` |
| `POST /api/export/zip/{id}/token` | `DownloadBackups` | A short-lived download token (for browsers) |
| `POST /api/export/set_expiration/{id}` | `DeleteBackups` | Changes the expiration |
| `POST /api/export/cancel/{id}` | | Cancels it |

- The `_system/cli/exports:getLatest` query (`ViewBackups`) returns the latest export row.

**`npx convex export --path <dir or file.zip> [--include-file-storage]`**
1. Request the export.
2. Wait on `getLatest` until it is completed or failed.
3. Download it: into a directory under the server's file name, or to a new file. An existing file is refused.
4. Print "Created snapshot export at timestamp …" and "Downloaded snapshot export to …".

### 1.2 Import (`crates/application/src/snapshot_import`, `crates/model/src/snapshot_imports`)

**Formats:** `csv`, `jsonLines`, `jsonArray` (one table, `--table` required) and `zip` (the whole snapshot). The CLI picks the format from the extension unless `--format` is given.

**Modes**
- `requireEmpty` (the default): a non-empty target table is an error, "Table X already exists. Please choose a new table name or use replace/append modes.".
- `--replace`, `--append`, and `--replace-all`: the last also clears or deletes the tables that the import does not contain.

**Values**
- ZIP tables with a `"uniform"` schema use the lossless encoding back.
- Every other source (CSV, JSON, JSONL) makes **every number a float64**. Keys starting with `$` are refused.
- CSV keeps a cell as a float64 when it parses as one, else as a string. The header is required.
- A JSON array file is at most 16 MiB.

**`_id` and `_creationTime`**
- An imported `_id` is kept, and its table number must match the target table's.
- Table numbers come from `_tables` (or the first `_id`), so references between tables stay valid.
- A float `_creationTime` is kept. Without one, a new one is assigned.
- `_storage` files are restored with their ids, checksums and storage UUIDs.

**Protocol**
1. `start_upload`, `upload_part` (5 MiB parts, under 10 000), `finish_upload` create a `_snapshot_imports` row, `uploaded`.
2. A worker parses the file and counts the rows: `waiting_for_confirmation`, with a summary table (`table | create | delete`).
3. `perform_import` starts it: `in_progress`, with progress and per-table messages.
4. The import ends `completed` (`num_rows_written`) or `failed`.

A one-shot `POST /api/import` does it all; `cancel_import` cancels.

**Atomicity**
- Each imported table is written into a **new hidden table**, in batches, with the indexes copied and the schema checked.
- One final transaction activates all the hidden tables at once, replacing the old ones (and, with `--replace-all`, deleting the others). The old tables are cleaned up later.
- A failed import leaves only hidden tables, which are collected later.
- The exception is appending into an existing table: those rows are written to the live table and stay if the import fails.

**`npx convex import`**
- It prints the summary and asks "Perform import?" (unless `--yes`, or nothing gets deleted).
- It then follows the progress and ends with "Added N documents to table X." or a failure message.

## 2. What an app can observe

1. An export ZIP that Convex's tools read, and that bunvex and Convex import round-trip: ids, table numbers, `_creationTime`, int64 vs float64, bytes, files.
2. The import formats, modes, value rules, messages and the confirmation summary.
3. An import that either applies whole or not at all, except appending into an existing table.
4. The endpoints and their operations, and the CLI's flags and output.

## 3. How bunvex does it

**Today**
- The catalog's tables are only ever `active`, and no table can be deleted.
- There is no `exports` blob store use case and no audit log.

### PR 1 — export
- **The ZIP:** Convex's layout, with a writer of our own (deflate from `node:zlib`, CRC from `Bun.hash.crc32`) that streams entries.
- **The encoding:** our own "clean lossless" writer. bigint becomes an integer literal; a float always gets a decimal point; ±0, NaN and Inf as Convex; `$bytes`; keys in byte order.
- **`_exports`:**
  - Convex's states, with progress messages and the one-at-a-time rule;
  - a worker reading **one snapshot**, page by page (1000);
  - the zip in a new `exports` blob store use case (local `storage/exports`, or `S3_STORAGE_EXPORTS_BUCKET`);
  - expiration and cleanup as Convex.
- **Endpoints:** `request/zip`, `zip/{id|ts}` (with Content-Disposition), `zip/{id}/token`, `set_expiration`, `cancel`, and the `getLatest` query, with Convex's operations and errors.
- **CLI:** `bunvex export --path [--include-file-storage]`.

### PR 2 — hidden and deleted tables in the catalog
- **Table states:** `hidden` (not visible to functions, and no user writes) and `deleting`, beside `active`.
- **Activation:** `activate` swaps hidden tables in, in one transaction.
- **Deletion:** a deleted table's documents are removed by a background worker, in batches of ordinary deletes, so retention then clears their history as usual.
- **Table numbers:** a table can be created with a chosen number.
- Every persistence driver keeps working unchanged: no new driver API.

### PR 3 — import (as built)

- **Parsing** (`import-parse.ts`): CSV with its own RFC 4180 reader (header trimmed of spaces, blank lines
  skipped, Rust's `f64` grammar, NaN/±inf becoming null as serde_json writes them, an empty file importing
  nothing as Convex's), JSON Lines (blank lines are rows, BOM refused), JSON arrays (16 MiB), ZIPs read by byte
  ranges from the blob store (`zip-reader.ts`: stored and deflated entries, ZIP64, CRC checked; Info-ZIP's
  archives too). Convex's messages, prefixed "Hit an error while importing:" ("Row N wasn't a valid value: …"
  without the product name, rule 5 / DV-216; code `InvalidValue`).
- **Running** (`imports.ts`): Convex's states and transitions, checkpoints and summary; numbers from
  `_tables`, then the first `_id`, then the existing table's (Convex's `assign_table_numbers`, its conflict
  checks and messages); every table into a new hidden table (`Engine.createHiddenTable`), in batches of
  8 MiB / 8000 documents (`Tx.importInsert`), checked against the schema with the tables as they will be
  (`Tx.schemaTables`); one `activateTables` with Convex's final checks (still in progress, schema unchanged,
  `ImportForeignKey`); `_storage` files stored again under their ids and storage UUIDs. A failed or canceled
  import's hidden tables are dropped (`Engine.dropHiddenTables`).
- **HTTP:** `/api/import`, `/api/import/{start_upload,upload_part,finish_upload}`, `/api/perform_import`,
  `/api/cancel_import` (ImportBackups); part tokens are signed for their upload. The
  `_system/cli/queryImport` and `:list` queries (ViewBackups).
- **CLI:** `bunvex import <path> [--table] [--format] [--replace|--append|--replace-all] [-y]`, the upload
  in 5 MiB parts (`BUNVEX_IMPORT_CHUNK_SIZE`), the summary and "Perform import?", progress by polling the
  row, "Added N documents to table "T"."
- **Retries and resuming (#209):** a system error (the blob store, a server error, a conflict that outlasted its
  retries) is retried with Convex's backoff (30 s doubling to 5 minutes, jittered) up to 5 times, then fails
  with Convex's internal-error message; each attempt resumes into the hidden tables recorded in the row
  (`hidden_tables`, bunvex's own field, not returned by `queryImport`), skipping what they already hold. A
  failed or canceled import's hidden tables are dropped.
- **Not verified:** a Convex ZIP **with files**: Convex's `_storage` ids carry Convex's number for it, which
  may be held by another bunvex system table (then the import fails with a table-number error). The only
  real Convex ZIP at hand (convex-backend's `demos/cron-jobs/test.zip`) has no files; it imports.

### PR 3 — import (plan)
- **Formats:** all four. CSV with Rust's `f64` parse rules; JSON and JSONL with numbers as float64; the ZIP's `uniform` encoding.
- **Modes:** the four modes.
- **Ids:** `_id` and `_creationTime` kept, table numbers from `_tables` or the ids, and `_storage` restored.
- **Protocol:** Convex's upload protocol, with the upload in a `snapshot_imports` blob store use case. Also the one-shot endpoint, `cancel_import`, and the `_snapshot_imports` row with its states, summary and checkpoints.
- **Writing:** into hidden tables in batches (8 MiB / 8000 rows), schema-checked; then one finalizing transaction (Convex's `finalize_import` checks); appending into an existing table writes the live table, as Convex.
- **CLI:** `bunvex import` with Convex's flags, summary, prompt, progress and messages.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| X1 | Components: export has only the root (as Convex for an app without components); a ZIP with `_components/…` is refused on import with a clear message, where Convex creates the components | bunvex has no components yet (Phase 4) | accepted (owner, 2026-10-02) |
| X2 | The README in the ZIP and the messages are bunvex's words, without Convex's links | rule 5 | accepted (owner, 2026-10-02) |
| X3 | The CLI does not print dashboard links ("check its progress at …/settings/snapshots") | the dashboard is not on a real deployment yet (item 12); added then | accepted (owner, 2026-10-02) |
| X4 | No audit-log entries for exports and imports | bunvex has no audit log yet | accepted (owner, 2026-10-02) |
| X5 | Import reads ZIPs in the current `"uniform"` encoding only. Convex also reads the legacy inferred-schema encoding of older Convex exports | the legacy one needs Convex's shape inference; it only matters for ZIPs exported by old Convex versions | accepted (owner, 2026-10-02) |

| X6 | A failed step fails the import at once. Convex retries an error that is not the import's own (a bad request) up to 5 times, with a backoff from 30 s to 5 minutes | bunvex did not yet tell a transient system error from a content error | accepted, then built (owner, 2026-10-02; #209): resolved |
| X7 | An import interrupted by a restart starts over (its hidden tables are dropped and written again). Convex resumes from its checkpoints, skipping the documents already in each hidden table (an append cannot resume in Convex either) | not built yet; only the time it takes differed | accepted, then built (owner, 2026-10-02; #209): resolved |
| X8 | The parser's detail in "Row N wasn't valid JSON: …" and "Not valid JSON: …" is JavaScript's wording (serde_json's in Convex), and invalid UTF-8 in a CSV says "Failed to parse CSV row 1: invalid UTF-8" | bunvex parses with the runtime's JSON parser and its own CSV reader; the message structure is Convex's | accepted (owner, 2026-10-02) |

**Follow-up:** X1, X3 and X4 are in the ledger's "Waiting on a dependency" (components, item 12, an audit log); X5 can be built any time.

**X5 as built:** a table in the legacy encoding is refused only when it has documents, so an older Convex export
of empty tables (its `generated_schema.jsonl` says `"never"`) imports.

## 5. Tests

**Export**
- The ZIP's layout and bytes, against an expected listing.
- The encoding of every value type, `-0.0`, NaN and Inf.
- Key order.
- One snapshot under concurrent writes.
- The one-at-a-time rule.
- The endpoints, operations and errors.
- Expiration and cleanup.
- `includeStorage`.
- The CLI.

**Catalog**
- Hidden tables invisible to functions.
- Activation in one transaction, with the replaced table deleted and its documents gone after the worker runs.
- Chosen table numbers.

**Import**
- Each format and mode, with Convex's messages.
- CSV inference.
- JSON numbers as float64.
- `$` keys refused.
- `_id` table-number checks.
- `_tables` numbers.
- `_storage` restored.
- A failed import changing nothing.
- Append's partial writes.
- The confirmation summary.
- The upload protocol.
- The CLI.

**Round trip:** export → import into an empty deployment → equal documents, ids, numbers and files. Ideally also a ZIP exported by a real Convex deployment, imported into bunvex.

# STUDY-60 — Streaming export (`list_snapshot`, `document_deltas`, `json_schemas`)

- **Status:** implemented (the legacy routes); DV-306 accepted, DV-307 resolved to match Convex (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-52](STUDY-52-shape-inference.md) (shapes), STUDY-33 (retention and the document log,
  PERSIST-01 C12), [STUDY-42](STUDY-42-import-export.md) (the export encoding)

## 1. How Convex does it

### 1.1 Routes (`crates/local_backend/src/streaming_export.rs`)

- **Routes**:
  - `GET|POST /api/list_snapshot` and `GET|POST /api/document_deltas`: GET reads its arguments from the
    query string, POST from a JSON body.
  - `GET /api/json_schemas`, `GET /api/get_table_column_names`, and
    `GET /api/test_streaming_export_connection` (answers `null`).
- **Every route checks**, in order:
  1. The streaming export entitlement. It is on with no `_backend_info` row, which is the self-hosted
     case.
  2. `ViewData`.
- **The current Fivetran connector** uses `/api/v1/data/sync`, which has an encrypted protobuf cursor
  (`crates/streaming_export`). The legacy routes serve Airbyte and older connector builds.
- **Selection** (`SelectionArg`), one of:
  - an exact `selection`: per component path, per table, per column, with `_other`;
  - `tableName` (or `table_name`), optionally with a `component`;
  - a `component`;
  - everything.

  System tables are left out. Hidden (importing) tables are kept. `_id` must be kept.
- **`format`**:
  - `json` (clean JSON: int64 as a decimal string; NaN and ±Infinity as strings; bytes as base64);
  - `convex_encoded_json` (`$integer`, `$float` for NaN, ±Infinity and −0, `$bytes`);
  - `export_json` (int64 as a bare integer).

  Floats print as serde_json does (`1.0`). Anything else is 400 `BadFormat`.
- **Timestamps** are nanoseconds.

### 1.2 `list_snapshot` (database.rs 2324–2596)

- **`snapshot`** defaults to now.
  - In the future: 400 `SnapshotTooNew`.
  - Older than 5 days: 400 `SnapshotTooOld`.
- **`cursor`** is opaque (`{"tablet","id"}` as a string). A bad one is 400 `InvalidListSnapshotCursor`.
- **Paging**:
  - Tables are taken by tablet id, one table per page, by `by_id`.
  - A page holds 1024 documents (`SNAPSHOT_LIST_LIMIT`) or 60 s of reading.
  - At a table's end the cursor points at the next table, and that page may be empty. After the last
    table, `cursor: null`.
  - `hasMore` is `cursor != null`.
- **Each value** is `{_component, _table, _ts (the revision's ts), …fields in key order}`.
- **Answer**: `{values, snapshot, cursor, hasMore}`.

### 1.3 `document_deltas` (database.rs 2192–2321)

- **`cursor`** is required (400 `DocumentDeltasCursorRequired`) and exclusive.
- **Reading**:
  - The document log is read up to now, in `(ts, tablet, id)` order.
  - At 128 rows read (filtered rows count) or returned, the page ends after that ts. A commit is never
    split.
  - At the end of the log, `cursor` is now and `hasMore: false`.
- **Each value** is `{_component, _table, _ts, _deleted, …}`. A delete carries only `_id`.
- **Retention**: below the 14-day document window, the answer is 400 `InvalidWindowToReadDocuments`,
  naming `cursor + 1`.

### 1.4 `json_schemas` and `get_table_column_names`

- `json_schemas` builds each active user table's JSON Schema from its reduced shape at one ts:
  - Object fields are sorted, with `additionalProperties: false` and `required` listing the non-optional
    fields.
  - Leaf schemas depend on `format`: int64, float64 (with `anyOf` when the table holds special values),
    bytes.
  - An empty table gets `_id` and `_creationTime`.
  - `$schema` comes last.
  - `deltaSchema=true` appends `_table`, `_component`, `_ts` and `_deleted`; `byComponent=true` nests the
    answer under the component path.
- `get_table_column_names` answers `{byComponent: {path: [{name, columns}]}}`, the shape's top-level
  fields.

## 2. What an app can observe

A connector's view: pages, cursors, value encodings, field order, errors.

## 3. How bunvex does it

- **`server/src/streaming-export.ts`** holds the routes, the selections and the three encoders, written
  as JSON text so int64 and nanosecond values stay exact.
- **`format`** accepts bunvex's names: `json` or `clean_json`, `encoded_json`, `export_json`. Convex's
  `convex_clean_json`, `convex_encoded_json` and `convex_json` are `BadFormat` (DV-307).
- **Arguments**: POST bodies read `snapshot` and `cursor` as written, since they exceed 2^53. bunvex's
  microsecond timestamps are multiplied by 1000 on the way out.
- **`list_snapshot`**:
  - Reads one table at the snapshot through `by_id`, 1024 documents a page.
  - Tables are taken by tablet number (bunvex's tablet ids).
  - The cursor is `{"tablet","id"}` as a string, opaque as Convex's.
- **`document_deltas`**:
  - Reads the store's document log (`readDocumentLog`, whole commits) and sorts each commit's rows by
    tablet and id.
  - Each document is read at its revision.
  - It checks the document retention window after the read, as Convex.
- **`json_schemas` and `get_table_column_names`** use the reduced shapes, computed when asked as
  `/api/shapes2` does (DV-265).
  - Reduced shapes merge a table's objects, so the top level is always an object or empty.
  - Convex's fallback to the active schema is therefore not reached. bunvex answers Convex's
    `NoSchemaForExport` if it ever were.
- **No components**: `_component` is always `""`.
- **Cost**: these routes do not touch the function path.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-307 | The formats are bunvex-named: `encoded_json` and `clean_json` (with `json` and `export_json`, which hold no "convex"). Convex's `convex_encoded_json`, `convex_clean_json` and legacy `convex_json` are `BadFormat`; the legacy alias has no bunvex counterpart. | Rule 5 with no exceptions: the clients that talk to bunvex are bunvex's (as DV-312). A connector written for Convex must ask for `encoded_json`. | owner, 2026-10-03, revisited: B (as DV-312); first resolved the same day to Convex's names by a wire-name exception, now removed |
| DV-306 | `list_snapshot` reads a snapshot only within the index retention window (240 s); older gives `SnapshotTooOld`. Each value's `_ts` is the snapshot. | Ainda não fizemos: Convex's table iterator rebuilds old snapshots from the document log, and bunvex's drivers do not expose a revision's ts. A connector paging one snapshot for more than 4 minutes would restart. | accepted (owner, 2026-10-03) |

Not built yet (not a divergence): `/api/v1/data/sync`, `list_active_syncs`, `data_sync_cursor_from_deltas`,
`_data_sync_progress`. These are the current Fivetran connector's API.

## 5. Tests

`server/test/streaming-export.test.ts`:

- **The encodings**: the three formats for int64, floats, NaN, −Infinity, −0, bytes.
- **`list_snapshot`**:
  - tables by tablet;
  - field order and `_ts`;
  - a single table at the snapshot (a later insert not in it).
- **`document_deltas`** from the snapshot: insert, patch and delete in commit order, deletes as
  `_deleted` with `_id` only; the next cursor; an empty page after.
- **Paging**:
  - 1024 per snapshot page, then the next (empty) table's page;
  - a 200-row commit in one deltas page, then 128, then the rest.
- **`json_schemas`**: Convex's example (optional `int64`), an empty table, `deltaSchema` / `export_json` /
  `byComponent`.
- **`get_table_column_names`**.
- **Errors and access**:
  - the connection test; a read-only key allowed, none refused;
  - missing cursor, bad format, bad cursor, a snapshot in the future or too old;
  - the retention window's error;
  - an exact nanosecond snapshot over POST;
  - an exact selection dropping a column.
- **Sabotage checks**, each failing a test:
  - commit splitting, the 128-row limit, deletes;
  - reading at the snapshot, tablet order;
  - clean int64, exact POST numbers;
  - the 1024 limit, column selection, `deltaSchema`.

# STUDY-73 — Storage usage gauges

- **Status:** implemented. Owner decision (2026-10-03): the text index's storage is the same estimate as
  its search bytes (DV-317, extended).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-71](STUDY-71-usage-metering.md) (usage; DV-317), [STUDY-59](STUDY-59-log-streams.md)
  (log streams), [STUDY-42](STUDY-42-import-export.md) (exports), [STUDY-52](STUDY-52-shape-inference.md)
  (table summaries)

## 1. How Convex does it

Sources: `crates/usage_gauges_tracking_worker/src/lib.rs`, `crates/database/src/snapshot_manager.rs`
(`get_document_and_index_storage`), `crates/database/src/database.rs` (vector and text storage),
`crates/model/src/file_storage/mod.rs` (`FileStorageSizeTracker`), `crates/exports/src/lib.rs`,
`crates/common/src/log_streaming.rs` (`CurrentStorageUsage`).

- **The worker** runs every `USAGE_TRACKING_PERIOD_SECS` (1 h).
  - It waits half the period plus a random fraction of a whole one, on start too.
  - It skips a run while the table summaries are not bootstrapped.
  - A failure backs off from 1 s to 15 min.
- **A run** computes the gauges and sends:
  - a `current_storage_usage` log stream event;
  - usage events, which go nowhere in the open-source backend (`NoOpUsageEventLogger`).
- **The totals** (`compute_totals`, user tables only):

  | Total | How Convex computes it |
  |---|---|
  | `total_document_size_bytes` | the table summaries' sizes |
  | `total_index_size_bytes` | per enabled (or backfilled staged) user index, its table's document size: Convex's own approximation ("document size × index count"); `by_id` and `by_creation_time` not charged |
  | `total_vector_storage_bytes` | per vector index, its non-deleted vectors × dimensions × 4 |
  | `total_text_storage_bytes` | per text index, its on-disk segments' bytes |
  | `total_file_storage_bytes` | the sum of `_storage` files' sizes, tracked incrementally |
  | `total_backup_storage_bytes` | unexpired cloud backups (none self-hosted) |
  | `total_system_table_document_size_bytes` | `{_storage, _scheduled_functions}`: those virtual tables' document sizes |

- **The file total** is also kept as `latest_file_storage_size`. A snapshot export that includes storage is
  refused over 1 TiB (`ExportFileStorageTooLarge`), with sizes in binary units ("1.5 TiB").

## 2. What an app can observe

- The `current_storage_usage` events on its log streams, roughly hourly.
- An export with storage refused when its files exceed 1 TiB.

## 3. How bunvex does it

`usage-gauges.ts`: `storageUsage` computes Convex's totals, and `UsageGauges` is the worker, started by the
server.

| Total | bunvex's source |
|---|---|
| Documents | table summaries |
| Indexes | Convex's approximation, over `t.indexes` without reserved ones |
| Vectors | each vector index's entries × dimensions × 4 |
| Text | the text index's indexed bytes (DV-317) |
| Files | `_storage` paged at one snapshot each run |
| Backups | 0 |
| Virtual tables | the system tables' summaries |

- **Pacing:** the same period knob and splay. The worker skips its run until the summaries are built.
- **Export limit:** the export service refuses an export with storage over 1 TiB on the last total, with
  Convex's message. The check at export time now prints sizes in the same units (it printed raw byte
  counts).
- **Measured:** a run over 10 000 files takes 30–45 ms, once an hour.

## 4. Divergences

| # | Topic | Convex | bunvex | Why | Decision |
|---|---|---|---|---|---|
| G1 | `total_text_storage_bytes` | the text indexes' on-disk segments | their indexed bytes, DV-317's estimate | Não dá pra fazer igual: bunvex's text index is in memory, without segments | DV-317 extended, owner, 2026-10-03 (as recommended) |

Not a divergence: the file total is recomputed each run, instead of tracked incrementally. It is not
observable, and it costs about 3 ms per 1000 files per hour.

## 5. Tests

`packages/server/test/usage-gauges.test.ts`:

- every total, against independently computed sizes;
- a run's event JSON and the kept file total;
- no run before the summaries are built;
- the splay (half a period first, then again) and `stop`;
- the export refused at 1.5 TiB with Convex's message, and allowed without a total.

Sabotage checks, each failing a test:

- reserved indexes charged;
- system tables counted as user documents;
- vector bytes, text bytes, file bytes;
- the readiness check;
- the splay;
- the kept total;
- the export limit;
- the event's system-table map.

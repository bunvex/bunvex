# STUDY-130 — Deleting a file's blob: Convex's mechanism and bunvex's `_storage_deletions`

- **Status:** implemented (owner, 2026-10-05: A, match Convex)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-32](STUDY-32-file-storage.md) (F3, DV-150), [STUDY-42](STUDY-42-import-export.md) (exports
  with files), [STUDY-33](STUDY-33-retention.md) (retention), [STUDY-73](STUDY-73-storage-usage-gauges.md)

## 1. How Convex does it

Convex never deletes a stored file's blob.

- **`ctx.storage.delete(id)`** goes to `FileStorage::delete` (`crates/file_storage/src/core.rs:186`). It calls
  `FileStorageModel::delete_file` (`crates/model/src/file_storage/mod.rs:295-313`), which checks for a system
  identity, finds the `_file_storage` document and deletes it with `SystemMetadataModel::delete`. It returns the
  entry. It fails with `StorageIdNotFound` ("storage id … not found") when there is none. Nothing else is
  written, queued or scheduled.
- **The dashboard's `deleteFile(s)`** calls the same model. So does a document delete of `_storage` through
  `db.system`: there is none, since it is read-only.
- **The blob store.** `Storage::delete_object` (`crates/storage/src/lib.rs:205`; `LocalDirStorage` at :1109,
  `S3Storage` at `crates/aws_s3/src/storage.rs:536`) has one caller outside tests:
  `system_table_cleanup` (`crates/application/src/system_table_cleanup/mod.rs:499`). It removes expired
  exports' ZIPs from the exports store. No code path deletes from the files store.
- **No queue, no worker.** There is no deletion table, no "orphaned blob" sweep, and no retention for blobs.
  Searching for `orphan` finds only `snapshot_manager.rs`'s orphaned-table *document* storage metric.
- **Retention.** Retention (`crates/database/src/retention.rs`) removes old document revisions, including the
  deleted `_file_storage` document's. The blob it pointed to stays in the bucket or directory.
- **Imports.** A Replace or ReplaceAll import that replaces `_storage` deletes the old tablet's documents. It
  does not delete their blobs.

What this gives Convex:

- Any reader at an older snapshot can still read the bytes:
  - an export's `_storage` files (written from a snapshot taken before the delete);
  - a download that resolved the row just before the delete committed;
  - a streaming export.
- No delete can remove bytes another row still points to: in a ZIP import, two rows can share a blob only by
  being separate uploads, so this never happens.

The cost: deleted files' bytes are never reclaimed. The files usage gauge (`FileStorageSizeTracker`) counts
live `_file_storage` documents, not bytes in the bucket.

## 2. What an app can observe

Nothing through the API. After the delete commits, the URL answers 404 and `getUrl` and `getMetadata` return
null, in both systems. Operators observe disk or bucket use, which never shrinks in Convex. They also observe
whether an export or a download racing a delete can fail.

## 3. How bunvex does it

### 3.1 Before this study

bunvex (STUDY-32 F3, DV-150) deleted the bytes:

- `FileStorage.deleteIn` deleted the `_storage` row. In the same transaction, it inserted `{storageKey}` into
  bunvex's own `_storage_deletions` (number 9998).
- After the delete committed, `sweepDeleted` removed the queued blobs and their queue rows. It was woken by
  commits to the queue, and ran every 30 s.
- `sweepOrphans`, hourly, removed blobs that no row or queued deletion named and that were written more than an
  hour ago (failed or abandoned uploads).

Safety, compared with Convex:

| Case | Convex | bunvex |
|---|---|---|
| delete rolled back | bytes kept | bytes kept (the queue row rolls back with it) |
| delete committed, nobody reading | bytes kept forever | bytes removed within ~30 s |
| an export started before the delete, its `_storage` files written after the sweep | the export succeeds | **the export fails**: "file missing from storage" (`exports.ts:446`) |
| a download that read the row just before the delete committed | served | may fail mid-way, or 404 |
| crash between commit and sweep | n/a | the queue row persists; the sweep resumes |

So Convex's approach is the safer one, and it is possible in bunvex (it is less code). It is not the same
outcome: it gives up reclaiming space, which DV-150 had decided bunvex should do.

### 3.2 Now (owner, 2026-10-05: option A)

As Convex: `FileStorage.deleteIn` (`ctx.storage.delete`, the dashboard's `deleteFile(s)`) deletes the `_storage`
row and nothing else. `_storage_deletions`, `sweepDeleted`, `sweepOrphans` and `startFileSweeps` are gone. A
deleted file's blob stays in the store, so an export or a download that read the row at an earlier snapshot still
finds the bytes. Blobs of failed or abandoned uploads stay too, as in Convex.

Possible future addition (not built): reclaiming the space of deleted files, as an `AD` proposed to the owner, with
a design that never removes bytes a snapshot may still read (e.g. only past retention's window and after every
export that began before the delete has finished).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| SD1 (DV-407) | Was: bunvex removed a deleted file's bytes after the delete committed (via `_storage_deletions`), and swept orphans hourly (DV-150). Now as Convex: the bytes stay | Convex's way is the safe one: no reader at an earlier snapshot loses bytes | owner, 2026-10-05: A, match Convex; DV-150 withdrawn |

## 5. Tests

`packages/server/test/storage.test.ts`: a rolled-back delete keeps the file; a committed delete removes the row
(the URL is null, a second delete is `storage id … not found`) and the blob is still in the store 300 ms later;
`catalog.test.ts`: no `_storage_deletions` table among the system tables. The orphan-sweep test is removed with
the sweep.

Sabotage (each applied alone, then restored):

| Change | Result |
|---|---|
| the blob removed once the delete commits (DV-150's behaviour back) | 1 test fails |
| the blob removed in the deleting transaction | 1 fails |

## 6. Decision

SD1 was decided by the owner on 2026-10-05: **A, match Convex.** Options B (an orphan sweep only) and C (keep
DV-150) were not taken. Space reclamation may come back as an addition (§3.2).

# STUDY-130 — Deleting a file's blob: Convex's mechanism and bunvex's `_storage_deletions`

- **Status:** decision pending (owner)
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

bunvex (STUDY-32 F3, DV-150) deletes the bytes:

- `FileStorage.deleteIn` deletes the `_storage` row. In the same transaction, it inserts `{storageKey}` into
  bunvex's own `_storage_deletions` (number 9998).
- After the delete commits, `sweepDeleted` removes the queued blobs and their queue rows. It is woken by commits
  to the queue, and runs every 30 s.
- `sweepOrphans`, hourly, removes blobs that no row or queued deletion names and that were written more than an
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
outcome: it gives up reclaiming space, which DV-150 decided bunvex should do.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| SD1 (DV-407) | bunvex removes a deleted file's bytes after the delete commits (via `_storage_deletions`), and sweeps orphans hourly; Convex never removes them | DV-150: disk use would otherwise only grow | **pending (owner)**: re-opened by this study, see §6 |

## 5. Tests

None in this PR: it only adds the study. The options below say what each would test.

## 6. Open questions

**SD1. Keep reclaiming deleted files' bytes, or match Convex and keep them?**

- **A. Match Convex.**
  - Delete the row only. Drop `_storage_deletions`, `sweepDeleted` and `sweepOrphans`. DV-150 is withdrawn.
  - Exports and downloads never race a delete.
  - Disk use only grows; an operator reclaims space only by hand.
  - Tests: a committed delete leaves the blob; an export from a snapshot before a delete still includes the
    file.
- **B. Keep reclaiming, without the extra table.**
  - Delete the row only. A sweep removes blobs that no row names, once they are older than a grace period.
  - The grace period must be longer than any snapshot that may still read them: an export's lifetime, which is
    unbounded today, or retention's window.
  - Still a divergence from Convex (DV-150 kept). The export race narrows but stays.
- **C. Keep today's design** (DV-150 as decided). The export and download races stay.

**Recommendation:** A. It is what Convex does, it is the safe one, and `_storage_deletions` goes away. Space
reclamation, if wanted, can come back later as an addition (AD) with a design that respects snapshots.

App impact: none for app code. Operators: with A, deleted files keep using space. With B or C, an export may
fail when files are deleted while it runs.

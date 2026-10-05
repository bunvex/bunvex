# STUDY-96 — Search index snapshots across restarts

- **Status:** superseded by [STUDY-111](STUDY-111-search-segments.md) (persisted segments): the snapshot is no
  longer written, and one already written is read only for an index with no segments. Was: implemented
  (STUDY-79 §6 option D, decided by the owner 2026-10-04); storage and crash
  behaviour decided by the owner (2026-10-04, §6)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04
- **Related:** [STUDY-79](STUDY-79-search-index-bootstrapping.md) §6 (the rebuild window), [STUDY-45](STUDY-45-text-search.md)
  S1 (DV-227), [STUDY-51](STUDY-51-vector-search.md) V2 (DV-270), [STUDY-72](STUDY-72-table-summary-checkpoints.md)
  (the same checkpoint-plus-log shape for table summaries)

## 1. How Convex does it

Convex's text and vector indexes are disk segments plus a memory part:

- The flushers write segments to the `search` blob use case: `S3_STORAGE_SEARCH_BUCKET`, else
  `<storage>/search` locally.
- Each index's metadata in `_index` records the ts its segments are current at (`SnapshottedAt`).

At start, `crates/database/src/search_index_bootstrap.rs` builds the memory part:

- `oldest_index_ts` is the oldest of those ts.
- `bootstrap()` streams every revision pair of the indexed tables from `(oldest_index_ts, upper_bound]`
  (`stream_revision_pairs_for_indexes`).
- It applies each pair to each index of its table.

Until that ends, searches answer `SearchIndexesUnavailable` / `VectorIndexesUnavailable` (STUDY-79).

So Convex's restart work is the writes since the last flush, whether the process stopped cleanly or
crashed. The segments are persisted continuously, so a crash costs no more than a clean stop.

## 2. What an app can observe

- The time after a start during which searches get the bootstrapping answer, and queries that use them are
  skipped by sync and retried (STUDY-79).
- Nothing else: once ready, the answers are the same however the index was built.

## 3. How bunvex does it

bunvex keeps each index in memory only (DV-227, DV-270), so the rebuild read the whole table at every start:
about 20 µs a document per index. Option D shortens that after a clean shutdown.

**Write (`Engine.close()`, after the committer is idle).** `search-snapshot.ts` `saveSearchSnapshot`:

- **What it writes:** every ready, non-staged text and vector index, with its tablet, name, definition and
  documents.
  - A text index's entries are as `TextIndex` keeps them.
  - A vector index's normalised vectors are its f32 bytes in base64, with its filter keys.
- **Format:** one gzip JSON blob with a format number, a random token and the ts it is current at.
- **Where:** the server's blob store under the `search` use case, Convex's bucket name
  (`S3_STORAGE_SEARCH_BUCKET`, else `<storage>/search`).
- **The `search_snapshot` global:** set to `{token, key}` once the blob is written; the blob it replaces is
  deleted after that. A crash between the two leaves the old snapshot named and still valid.

**Start (`Engine.init()`, before the indexes are reconciled).** `loadSearchSnapshot` refuses the snapshot,
and every index is read from its table as before, unless all of these hold:

- the global names a blob that exists and parses;
- the blob has the current format;
- the global's token is the blob's token. This ties the snapshot to the store it was written against: a blob
  store shared with another store, or a store restored from a backup, never matches;
- its ts is not ahead of the store;
- its ts is not older than the document retention's `document_min_snapshot_ts`, so the log since is complete.

**Restore.** Each index the start would backfill uses the snapshot only if it holds the same tablet, name and
definition (JSON equality); otherwise that index alone is read from its table.

1. The saved documents are loaded.
2. Every document id the document log changed in `(ts, start]` for that table is read at its current version
   (`getVersions`) and indexed again, or removed if deleted. The log is read once per table, in pages of
   1000, however many of its indexes ask.
3. `restore()` skips ids a commit touched meanwhile, as the backfill does.

The restored index is then ready, exactly as a backfilled one; `searchStats.restored` counts them.

**After a crash** the global still names the previous clean shutdown's snapshot, and it is restored with the
whole log since (owner, 2026-10-04, §6). A snapshot outside retention is refused.

### Measurements

`bench/search-snapshot.ts` uses SQLite (durable) and file blobs, on an M-series laptop. Each document has a
12-word body, a filter field and a 64-dimension vector; one text index and one vector index.

| Documents | Snapshot at close | Ready, indexed from the table | Ready, restored |
|---|---|---|---|
| 50 000 | 417 ms, 14.7 MiB | 2.7–3.3 s | 0.25–0.27 s; 0.47 s with 5 000 changes since |
| 200 000 | 1.7 s, 58.6 MiB | 12.1–13.4 s | 1.2 s; 2.0 s with 20 000 changes since |

So a restart is about 10× faster. A clean shutdown takes longer by the snapshot's write, about 8 µs a
document.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| SS1 | After a crash, the restore replays the log since the last clean shutdown, or reads the tables when there is none. Convex's segments are flushed continuously, so its replay is never longer than the writes since the last flush | Ainda não fizemos: there are no persisted segments yet (option E). Periodic snapshots would need writing the whole index each time | owner, 2026-10-04: use the previous snapshot (DV-227, DV-270 updated) |
| SS2 | A snapshot, not segments, is written to the `search` blob use case; the blobs are bunvex's format | Follows DV-227 / DV-270 | owner, 2026-10-04: the blob store, `search` use case |

## 5. Tests

`packages/core/test/search-snapshot.test.ts`:

- **Restore after a crash run.** A clean close is followed by a run that writes and crashes (patch, delete,
  insert). The next start restores both indexes, and its text and vector answers equal those of a store
  indexed from its tables. That start's own close replaces the snapshot, so a single blob remains.
- **Refusals:**
  - another store, whose global is not set;
  - an unreadable blob;
  - outside retention;
  - a token mismatch;
  - an unmarked global.
- **Changed definition:** only the index whose definition changed is read from its table.

Sabotage checks, each caught:

- no text or vector replay;
- no token check;
- no retention check;
- no definition check;
- the old blob kept;
- no save at close;
- no load at start.

## 6. Open questions

Decided by the owner (2026-10-04):

- **Where the snapshot lives:** the blob store, `search` use case, as recommended (rather than a global or a
  file next to the store).
- **After a crash:** use the previous snapshot with the log since, as recommended (rather than discarding it).

Next: persisted segments (STUDY-79 option E).

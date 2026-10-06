# STUDY-111 — Persisted search segments

- **Status:** decided by the owner (2026-10-05: "build E now", STUDY-79 §6 option E); PR 1 (the segment
  formats), PR 2 (the merged query path) PR 3 (the flusher, the start from segments), PR 3b (backpressure), PR 4 (the paged backfill), PR 5 (the compactor), PR 6 (the `_index` rows) and PR 7 (fast-forward, retention, orphans) implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-79](STUDY-79-search-index-bootstrapping.md) §6 (options A–E), [STUDY-96](STUDY-96-search-index-snapshots.md)
  (option D, the clean-shutdown snapshot), [STUDY-45](STUDY-45-text-search.md) S1–S2 (DV-227, DV-228),
  [STUDY-51](STUDY-51-vector-search.md) V1–V2 (DV-269, DV-270), [STUDY-29](STUDY-29-index-backfill.md)
  (database index backfill), [STUDY-33](STUDY-33-retention.md) (document retention)

## 1. How Convex does it

A text or vector index is a list of immutable **disk segments** plus a **memory part** holding the writes since
the segments' timestamp. Workers flush the memory part into new segments, compact segments, and keep the
timestamp from falling behind; a start only replays the writes since that timestamp.

### 1.1 Index state (`_index`)

- **Text** (`crates/common/src/bootstrap_model/index/text_index/index_state.rs:15-28`):
  - `Backfilling(TextIndexBackfillState)`: `{segments, cursor: {table_scan_cursor, last_segment_ts}, staged}`
    (`backfill_state.rs`);
  - `Backfilled {snapshot, staged}`: built, not yet enabled by the push (or staged);
  - `SnapshottedAt(snapshot)`: enabled.
- **The snapshot** (`index_snapshot.rs:16-30`, `:247-277`): `{data: MultiSegment(Vec<FragmentedTextSegment>),
  ts, version}`. A `version` other than the current one makes a query answer `IndexBackfillingError` and the
  flusher rebuild the index (`text_index_manager.rs:152-158`; `search_flusher.rs:321-326`).
- **Vector** has the same three states (`vector_index/index_state.rs`) with `{data: MultiSegment(Vec<FragmentedVectorSegment>), ts}`.
- The state is part of the index's `_index` row, written by ordinary transactions, so the memory index and the
  state change at one commit (`text_index_manager.rs:333-509`: on each `_index` update the memory part is
  truncated to the new snapshot's ts).

### 1.2 Segments

- **Text** (`FragmentedTextSegment`, `index_snapshot.rs:230-255`), four objects in the `search` storage use case
  (`search/src/disk_index.rs:165-212`):
  - `segment_key`: a tantivy index archive (terms, postings with frequencies and positions, fieldnorms, the
    fast fields `internal_id`, `ts`, `creation_time`);
  - `id_tracker_key`: internal id ↔ tantivy doc id;
  - `alive_bitset_key`: which docs are not deleted;
  - `deleted_terms_table_key`: per term, how many deleted documents had it, and their token counts, so BM25's
    statistics count only live documents (`search/src/incremental_index.rs:257-315`);
  - plus `num_indexed_documents`, `num_deleted_documents`, `size_bytes_total` and a random `id`.
- **Vector** (`FragmentedVectorSegment`, `vector_index/segment.rs:18-30`), three objects: a qdrant segment (an
  HNSW graph over f32 vectors), an id tracker and a deleted bitset; `num_vectors`, `num_deleted`, `id`. Its size
  is estimated as vectors × dimensions × 4 (`segment.rs:63-79`).
- Segments are never rewritten; a delete rewrites only the bitset (and, for text, the deleted-terms table) and
  uploads it under a new key.

### 1.3 Queries: memory part plus segments

- **Text** (`search/src/lib.rs:461-736`, `TantivySearchIndexSchema::search`):
  1. each segment and the memory part return their matching terms (exact, and prefix expansions of the last
     term); the best `MAX_UNIQUE_QUERY_TERMS` are kept;
  2. each segment returns BM25 statistics for those terms (live documents only, deletes subtracted); the
     memory part adds its diff since the segments' ts (`update_bm25_stats`). So **the statistics are the whole
     index's**, as one index would have them (`scoring.rs`: `Bm25StatisticsDiff::combine`);
  3. the memory part's tombstones say which ids to skip in the segments (`query_tombstones`);
  4. each part scores its posting lists with the shared statistics; the best `MAX_CANDIDATE_REVISIONS` are
     merged by score.
- **Vector** (`vector/src/vector_index_manager.rs`, `result_merger.rs`): each segment and the memory part
  return their top hits; the memory part's tombstones remove stale segment hits; results are merged by score.

### 1.4 The flusher (`search_index_workers/src/search_flusher.rs`)

- **When** (`needs_backfill`, `:301-397`), per index:
  - `Backfilling` → a backfill step;
  - the memory part over `SEARCH_INDEX_SIZE_SOFT_LIMIT` (10 MiB, text) or `VECTOR_INDEX_SIZE_SOFT_LIMIT`
    (30 MiB, vector) (`knobs.rs:827`, `:941`) → `TooLarge`;
  - a non-empty memory part whose ts is `SEARCH_WORKERS_MAX_CHECKPOINT_AGE` (1 h, `knobs.rs:850`) old →
    `TooOld`.
  - A commit that pushes a memory part over the soft limit wakes the flusher at once
    (`transaction.rs:1508-1519`).
- **A live flush** (`MultipartBuildType::Partial`) reads the document log for `(ts, new_ts]` of the table and
  builds one new segment from the latest revisions, marking the older revisions deleted in the previous
  segments (`:650-663`, `:699-713`). Only deletes: no new segment.
- **The paged backfill** (`:399-452`, `incremental_table_scan_stream` `:747-815`): each step reads the table
  by id from the cursor at a fresh snapshot `new_ts`, up to `incremental_multipart_threshold_bytes` (the soft
  limit), plus the document log `(last_segment_ts, new_ts]` for ids at or before the old cursor (updates and
  deletes of documents already in earlier segments). The new segment, the earlier segments' new deletes, the
  new cursor and `last_segment_ts = new_ts` are committed in `Backfilling`; progress survives a restart. When
  the scan reaches the end, the index becomes `Backfilled` / `SnapshottedAt` at that ts. Meanwhile the memory
  part is truncated after each step (`text_index_manager.rs:336-349`).

### 1.5 The compactor (`search_compactor.rs`)

- `CompactionConfig::default()` (`:466-491`) for text and vector:
  - a **small** segment is at most 100 MiB (`VECTOR_INDEX_SIZE_HARD_LIMIT`);
  - at least `MIN_COMPACTION_SEGMENTS` (3) and at most `MAX_COMPACTION_SEGMENTS` (10) at a time, smallest first,
    their total at most `SEGMENT_MAX_SIZE_BYTES` (~2.9 GB) (`knobs.rs:1291-1303`);
  - a large segment with more than `MAX_SEGMENT_DELETED_PERCENTAGE` (20 %) deleted is compacted alone.
- `find_segments_to_compact` (`:330-416`): small segments first, then large ones, then deletes.
- Segments with no live documents are dropped without being read (`:220-238`).
- **The writer** (`writer.rs:77-210`) serializes the flusher's and compactor's metadata writes and reconciles
  them: deletes the flusher wrote to segments that a compaction replaced meanwhile are written again into the
  compacted segment (`merge_deletes`, `:604-660`).

### 1.6 Fast-forward and retention (`fast_forward.rs`)

- Every `DATABASE_WORKERS_POLL_INTERVAL` (20 s), when 500 commits (`DATABASE_WORKERS_MIN_COMMITS`) or 1 h have
  passed since the last time (`:150-170`), each index whose memory part is empty gets its ts moved to now
  (`:197-215`), in `_index_worker_metadata` rather than `_index`.
- Bootstrap takes `max(snapshot ts, fast-forward ts)` (`database/src/search_index_bootstrap.rs:185-206`).
- Retention does not look at search indexes: documents are kept 14 days (`DOCUMENT_RETENTION_DELAY`), and the
  `TooOld` flush plus fast-forward keep every index's ts within an hour of now.

### 1.7 Bootstrap (`database/src/search_index_bootstrap.rs`)

- `oldest_index_ts` is the oldest ts of the `Backfilled` / `SnapshottedAt` indexes (`:116-140`, `:185-192`).
- Every revision of the indexed tables in `(oldest_index_ts, upper_bound]` is applied to each index whose own
  ts is older than the revision (`:243-305`, `:363-391`). Searches answer `SearchIndexesUnavailable` meanwhile
  (STUDY-79).

### 1.8 Backpressure (`database/src/transaction.rs:1490-1587`)

- At commit, a transaction that writes a table whose enabled (or backfilled) index has a memory part of 100 MiB or
  more (`SEARCH_INDEX_SIZE_HARD_LIMIT`, `VECTOR_INDEX_SIZE_HARD_LIMIT`) fails with
  `ErrorMetadata::overloaded("TextIndexTooLarge" | "VectorIndexTooLarge", "Too many writes to <index>. …")`.
  Backfilling indexes never block writes.

### 1.9 Storage

- The `search` use case (`S3_STORAGE_SEARCH_BUCKET`, else `<storage>/search`). Queries read segments from a local
  cache of downloaded archives (`search/src/archive/cache.rs`), memory-mapped:
  - the cache is a temporary directory per process (`searcher/in_process.rs`, `TempDir::new()`), so it starts
    empty; an archive is fetched from the store (local or S3) and extracted into it on first use;
  - it is an LRU bounded by `MAX_ARCHIVE_CACHE_SIZE_BYTES` (500 MiB, `searchlight_knobs.rs`); an evicted
    archive's files are removed once no query holds a handle to them (an mmap keeps its handle), so the bound
    is exceeded while queries use more than it.
- **Old segments are never deleted** from storage: nothing calls `delete_object` on the search storage
  (only exports' objects are deleted, `application/src/system_table_cleanup/mod.rs:499`).

## 2. What an app can observe

Nothing new once the index is ready: the answers (text scores, order and ties; vector results) are the whole
index's, however it is split. What changes is operational, and two app-visible edges:

- **How long a start is unavailable** (STUDY-79's bootstrapping answer): the writes since the segments' ts, not
  the table.
- **`TextIndexTooLarge` / `VectorIndexTooLarge`** when writes outrun the flusher (§1.8).
- Memory: the segments are compact; the memory part is bounded by the flush limits.

## 3. How bunvex does it

Delivered as a series of pull requests, each building on the previous one.

| PR | Branch | What |
|---|---|---|
| 1 | `feat/search-segments-format` | This study; the text and vector segment formats, with unit tests |
| 2 | `feat/search-segments-merged-query` | The memory part and the merged query path; the differential test |
| 3 | `feat/search-segments-flusher` | Persisted index state, the flusher, the start from segments; a crash test |
| 4 | `feat/search-segments-backfill` | The resumable paged backfill of a new index |
| 5 | `feat/search-segments-compactor` | The compactor and its reconciliation with flushes |
| 3b | `feat/search-segments-backpressure` | `TextIndexTooLarge` / `VectorIndexTooLarge` (DV-228) |
| 6 | `feat/search-segments-index-rows` | Every search and vector index's `_index` row, as Convex's (the state moves there); the STUDY-96 snapshot removed |
| 7 | `feat/search-segments-retention` | Fast-forward (`_index_worker_metadata`), `TooOld` flushes, retention |
| 8 | `feat/search-segments-staged` | Staged indexes built and kept `Backfilled { staged }`, as Convex |
| 9 | `feat/search-segments-disk` | Segments queried from disk (memory-mapped files) instead of RAM |

### 3.1 The segment formats (PR 1, `@bunvex/search`)

One binary layout for both kinds (`segment-file.ts`): a header, then sections aligned to 8 bytes, each a typed
array over the same buffer. Opening a segment decodes nothing: every lookup reads the buffer in place, so a
segment costs its bytes in memory, and the same code runs over a memory-mapped file (PR 9, §3.10).

- **Text segment** (`text-segment.ts`, `TextSegment`), built from `IndexedDoc`s:
  - documents **sorted by id** (the id's UTF-8 bytes), so the local document number is the id's rank and an id
    is found by binary search: no separate id tracker;
  - per document: `_creationTime` (f64), token count, tantivy's fieldnorm code, metered bytes, and per filter
    field the ordinal of its key in that field's sorted key table;
  - the terms, sorted by UTF-8 bytes, each with its posting list (document, term frequency);
  - a forward index (document → its terms and frequencies), which lets a delete subtract the document's
    terms from the statistics (Convex's deleted-terms table) and lets `get(id)` give the document back;
  - totals: documents, tokens, metered bytes.
- **Text deletes** (`TextSegmentDeletes`): a deleted bitset, the deleted documents' count, tokens and bytes, and
  per term the number of deleted documents having it. Encoded as its own blob (Convex's alive bitset plus
  deleted-terms table), rewritten under a new key when it changes; the segment itself never changes.
- **Vector segment** (`vector-segment.ts`, `VectorSegment`): documents sorted by id, their normalized f32 vectors
  in one array, and per filter field the key ordinals and the sorted key table. Its deletes are a bitset and a
  count (`VectorSegmentDeletes`). bunvex's vector search is exact (DV-269), so a segment is a flat array rather
  than an HNSW graph: a search reads every live vector, as today.

Not decoding is checked by a test that opens a segment and reads every field without copying the buffer.

### 3.2 The memory part and the merged query path (PR 2, `@bunvex/search`)

- **`SegmentedIndex`** (`segmented-index.ts`), the bookkeeping both kinds share:
  - the segments, each with its deletes **in memory** and a count of the deletes the stored copy has;
  - the memory part: the documents changed since the segments were written, in their latest state, and per
    changed id the sequence number of its last change;
  - a change marks the document's segment copy deleted at once (Convex's memory tombstones), so every live
    document is in exactly one place;
  - an estimate of the memory part's size, which the flusher compares with its soft limit (PR 3).
- **Flush:** `prepareFlush` builds the memory part as a new segment and encodes the deletes of every segment
  whose deletes changed, at one moment. Once they are stored, `commitFlush` adds the segment and keeps in the
  memory part only the changes made since the prepare, deleting their copies from the new segment.
- **Compaction:** `prepareCompaction` builds the live documents of some segments as one segment.
  - `reconcileCompaction`, run under the flushes' lock, carries over the deletes those segments got since: a
    flush's included, as Convex's writer does (`merge_deletes`). It returns the new segment's deletes to store
    with it.
  - `commitCompaction` replaces the segments, carrying the deletes made since the reconcile too.
- **Load:** stored segments and their deletes; a change made before they arrived (a commit during a start)
  deletes its stale copy.
- **Text search** (`SegmentedTextIndex`), the memory part a `TextIndex`:
  - the statistics of the whole index: live documents, tokens, and each term's document frequency, summed over
    the memory part and every segment's live documents, deletes subtracted (Convex's `Bm25StatisticsDiff`);
  - the query terms (exact matches, then prefix expansions read from each segment's sorted terms) chosen exactly
    as `TextIndex.search` chooses them, the overlay included;
  - each segment's matching live documents scored term at a time, in the weights' byte order: each document's
    score is summed in the order `TextIndex.search` sums it, so the f32 scores are bit for bit the same.
- **Vector search** (`SegmentedVectorIndex`), the memory part a map:
  - every live vector of every part compared (DV-269), with a top-`limit` selection instead of sorting every hit;
  - Convex's order, a total one: by score descending, a NaN above everything, equal scores by internal id
    descending. Today's sort fell back to the map's insertion order between two NaN scores (or a NaN and +∞),
    so that order changed with how the index was built; it is the id order now, as Convex's `total_cmp`.
- **The engine** (`core`) keeps a `SegmentedTextIndex` / `SegmentedVectorIndex` per index. Until the flusher
  (PR 3), everything stays in the memory part, so the engine behaves as before; searches go through the merged
  path.

**Measured.** `bench/search-segments-micro.ts` (index level, 200 000 documents of 12 words plus a 64-dimension
vector; "8 segments": everything flushed, as the engine will hold it from PR 3; one run, M-series laptop):

| | Heap | Text search, median ms (`gamma` / `alpha beta` / `n12`, ~1100 prefix expansions / `theta` + filter) | Vector search, median ms |
|---|---|---|---|
| Today (`TextIndex`, one map) | 448 MiB text, 89 MiB vector | 97 / 132 / 6.3 / 57 | 46 |
| Segmented, all in the memory part (PR 2's engine) | 474 MiB, 115 MiB | 92 / 194 / 10.7 / 59 | 19 |
| Segmented, 8 segments | **55 MiB**, **57 MiB** | **47 / 72** / 9.9 / **13** | **14** |

`bench/search-segments.ts` (engine level, same documents, SQLite): this PR against `main`, 200 000 documents:

| | Write throughput | Heap with the indexes ready | Text search, median | Vector search, median |
|---|---|---|---|---|
| `main` | 5310 documents/s | 844 MiB | 69.6 ms | 49.0 ms |
| this PR | 4657 documents/s | 896 MiB | 72.5 ms | 14.9 ms |

The throughput difference is noise: two runs of 50 000 each gave 6042 and 6277 documents/s on this branch, 6044
and 5160 on `main`.

### 3.3 Index state, the flusher and the start from segments (PR 3, `core/src/search-segments.ts`)

- **The state.** Per index: its kind, tablet, name and definition, its ts, and its segments (the keys of their
  segment and deletes blobs, with counts): Convex's `SnapshottedAt { ts, segments }`.
  - Convex keeps it in the index's `_index` row. bunvex has no `_index` rows for search indexes (their
    metadata is the schema's, platform §search), so the state of every index is one persistence global,
    `search_segments` (DV-368).
  - One writer changes it, in order (`SearchSegmentsState.update`), as Convex's `SearchIndexMetadataWriter`
    serializes its flusher's and compactor's writes.
  - Blobs are written before the state names them. None is ever deleted, as Convex's (DV-370, resolved): a
    replaced segment or deletes blob, a removed index's, or one a failed write left, stays in the store.
- **The flusher.** Convex's live flush:
  - after each commit, an index of a written table whose memory part passed its soft limit is flushed in the
    background: 10 MiB for text, 30 MiB for vectors (`SEARCH_INDEX_SIZE_SOFT_LIMIT`,
    `VECTOR_INDEX_SIZE_SOFT_LIMIT`), by an estimate of the memory part's size;
  - one flush per index at a time: prepared at the visible ts (every commit up to it applied), its segment and
    deletes stored, then the state names them, then the memory part keeps only the commits since;
  - Convex builds its new segment from the document log `(ts, now]`; bunvex builds it from the memory part,
    which holds the same documents at the same ts.
  - A flush of 10 MiB of text builds in about 100 ms on the event loop (Convex builds on a thread).
- **A new index** (a push, or a start with no state for it) is read from its table as before, into its memory
  part, and flushed as one segment before it is ready, as Convex's backfill ends in segments. PR 4 pages it.
- **The start.** Each index the start rebuilds (STUDY-79's bootstrapping indexes) loads its state when it can be
  trusted, as STUDY-96's checks did:
  - the same definition (JSON equality) as the schema's;
  - a ts not ahead of the store, and not older than retention's `document_min_snapshot_ts`, so the log since is
    complete;
  - every blob present and readable.
  - Then every document the log changed after the index's ts (read once per table, from the oldest ts its
    indexes need, at their current versions) is put in the memory part, unless a commit set it meanwhile.
    Convex's bootstrap replays the same revisions (`search_index_bootstrap.rs`). Searches answer
    `SearchIndexesUnavailable` until then (STUDY-79).
  - Anything else: the index is read from its table, as before.
- **A clean shutdown** flushes every ready index (and moves the ts of an index with nothing to flush), so the
  next start replays nothing: the guarantee STUDY-96's snapshot gave, which the owner chose (option D), kept at
  the cost of one flush per index at shutdown. Convex does not flush at shutdown (DV-369).
- **STUDY-96's snapshot** is no longer written. One an earlier version wrote is still read, for an index with no
  segments state; the last PR of the series removes it (§6).
- **Removed state.** After every reconcile (start, push, table change), the state of an index that is gone,
  staged or redefined is removed; its blobs are kept (DV-370).

**Measured** (`bench/search-segments.ts`: 200 000 documents of 12 words, a filter field and a 64-dimension
vector, one text and one vector index, SQLite durable, file blobs; each restart in a process of its own, with the
table summaries' checkpoint up to date so it measures the search indexes; one run each, same machine, minutes
apart):

| | `main` (in memory, STUDY-96 snapshot) | This PR (segments) |
|---|---|---|
| Write throughput (mutations of 500) | 5527 documents/s | 5392 documents/s |
| Heap with the indexes ready | 844 MiB | 491 MiB |
| Text search, median (`take(10)`) | 70.6 ms | 43.2 ms |
| Vector search, median | 48.6 ms | 12.9 ms |
| Clean shutdown | 1659 ms (the snapshot) | 129 ms (the last flush) |
| Restart after a clean shutdown, until the indexes are ready | 1011–1133 ms | 24–81 ms |
| Restart after a crash, 20 000 writes since the last flush | 1959 ms (the last clean shutdown's snapshot plus the log since; without one, the tables: 12–13 s, STUDY-96) | 893 ms (21 000 documents replayed over both indexes) |

Segments are read in place, so loading them is reading their blobs: 17 blobs, 122 MB, in tens of
milliseconds from a warm file cache. The write throughput is within the noise of one run.

### 3.4 Backpressure (PR 3b)

DV-228 said there was no unflushed memory part to bound; now there is, so bunvex matches Convex (§1.8):

- Before a mutation's commit, a transaction that writes a table one of whose ready (built, not staged) search
  or vector indexes has a memory part at its hard limit fails: 100 MiB (`SEARCH_INDEX_SIZE_HARD_LIMIT`,
  `VECTOR_INDEX_SIZE_HARD_LIMIT`), by the estimate the soft limit uses. Indexes being built never refuse.
- The error is Convex's `overloaded("TextIndexTooLarge" | "VectorIndexTooLarge", "Too many writes to <table.index>.
  …")`, its message without the documentation link (DV-04). bunvex handles it as its `IndexesUnavailableError`
  (Convex handles overloaded and feature-temporarily-unavailable errors alike): a system error the function
  cannot catch; HTTP 503 with the code; a sync session closed with 1013 and the code (Convex's `Again`); a
  scheduled job retried later; a plain `Error` in an action's `runMutation` (Convex's `allow_all_errors`).
- The refusal wakes the flusher, as Convex's commit does before it validates.
- Without a segment store there is nothing to flush into, and nothing is refused.
- Measured on the commit path (20 000 single-insert mutations on a table with a search index): 51–54 000
  commits/s before, 52–53 000 after.

### 3.5 The paged backfill (PR 4)

With a segment store, a new index (a push, a start with no state for it, a changed definition) is built as
Convex's incremental backfill (§1.4):

- **A step** takes the visible ts, reads the table by id from the cursor at that ts until the documents read
  reach the soft limit (Convex's `incremental_multipart_threshold_bytes`: 10 MiB of `estimate_size` for text,
  the vectors' bytes for vectors), and takes from the document log the documents up to the old cursor changed
  since the last step, at that ts (Convex's `walk_document_log_for_updates`).
- They become one segment; their older copies are deleted in the earlier segments. Stored, the state records
  the segments, the step's ts and the new cursor (Convex's `Backfilling { cursor: { table_scan_cursor,
  last_segment_ts }, segments }`); then the memory part keeps only the commits after the step's ts (Convex
  truncates its memory index the same way), so it stays small while the table is read.
- When the table is read, the state has no cursor: the index is ready at the last step's ts.
- **A restart** resumes a build from its stored cursor, its earlier segments loaded, if the state can be
  trusted (as §3.3). Such an index was never ready, so a search meanwhile answers `IndexBackfillingError`, as
  Convex's `Backfilling` index does, not STUDY-79's bootstrapping answer.
- Without a store (or a persistence without the document log), indexes are read from their tables in memory, as
  before.

**Measured** (`bench/search-segments.ts build` / `open`, 220 000 documents, one text and one vector index, each in
a process of its own):

| | `main` | This PR |
|---|---|---|
| Building both indexes from the table | 11.8 s; heap 614 MiB, RSS 1200 MiB once built | 11.6 s, 4 steps; heap 126 MiB, RSS 1797 MiB once built (the steps' garbage, not returned to the system) |
| A restart, until ready | 1170 ms (the snapshot); heap 548 MiB, RSS 1137 MiB | 25 ms (the segments); heap 125 MiB, RSS 164 MiB |

### 3.6 The compactor (PR 5)

- **When:** after every flush and backfill step, and after a start loads an index, the index's segments are
  weighed as Convex's `find_segments_to_compact` (§1.5): small segments (at most 100 MiB) first, three to ten of
  them, smallest first, within `SEGMENT_MAX_SIZE_BYTES`, chosen at random among the candidates as Convex's
  shuffle; then large ones the same way; then a large segment more than 20 % deleted, alone. Segments with no
  live document are dropped whatever else is merged. Sizes are Convex's: a text segment's bytes, a vector
  segment's vectors × dimensions × 4. The knobs are Convex's env names (`MIN_COMPACTION_SEGMENTS`,
  `MAX_COMPACTION_SEGMENTS`, `MAX_SEGMENT_DELETED_PERCENTAGE`, `SEGMENT_MAX_SIZE_BYTES`,
  `VECTOR_INDEX_SIZE_HARD_LIMIT`).
- **The merge** (`TextSegment.merge`, `VectorSegment.merge`) reads the segments in place: their id and term
  tables are sorted, so they are merged (each id and term once), each live document's forward index is remapped
  to the merged term ordinals (which keep their order), and the posting lists are rebuilt. A term no live
  document has is left out. It pauses every 8 192 documents so other work runs, and a close stops it.
- **The writer.** The merge is built outside the index's lock. Under it (the lock flushes and backfill steps
  hold from their build to their commit), the deletes the merged segments got meanwhile — flushes' included —
  are carried into the new segment and stored with it (Convex's `merge_deletes`), the state names it in their
  place; their blobs stay, as every search blob (DV-370). The deletes made after that are carried in memory and stored by
  the next flush.
- A clean shutdown stops a compaction in progress before the last flush.

**Measured** (`bench/search-segments.ts`, 200 000 documents, same machine, heavier load than PR 3's run): 9 blobs
instead of 17 after the load; text search median 53.5 ms, vector 13.1 ms; a restart after a clean shutdown 286–347
ms until ready, RSS 394–423 MiB (the compaction of the three small text segments the load left starts as soon as
the index is ready); after a crash with 20 000 writes since, 1.3 s.

### 3.7 The `_index` rows of search and vector indexes (PR 6)

The owner asked (2026-10-05) for every search and vector index to have its `_index` row as Convex's, so that
`_index` holds the rows Convex's does for the same schema. The state of PRs 3–5 moves there, from the
`search_segments` global:

- **The row** is `{tablet, name, config}`. `tablet` and `name` are the identity bunvex's database index rows use
  (Convex's are `table_id` and `descriptor`, DV-53); `config` is Convex's serialized `IndexConfig`
  (`index_config.rs` `SerializedIndexConfig`), field for field:
  - text: `{type: "search", searchField, filterFields, onDiskState}`; vector: `{type: "vector", dimensions,
    vectorField, filterFields, onDiskState}`; filter fields a sorted set, as Convex's `BTreeSet`;
  - `onDiskState`, as `SerializedTextIndexState` / `SerializedVectorIndexState`: `backfilling` (`{staged}`, nothing
    built yet), `backfilling2` (`{segments, cursor: {table_scan_cursor, last_segment_ts}, staged}`; vector:
    `backfilling` with those fields flat) while built, `snapshotted` (`{data: {data_type: "MultiSegment",
    segments}, ts, version: 2}`; vector without `version`) once ready;
  - each text segment `{segment_key, id_tracker_key, deleted_terms_table_key, alive_bitset_key,
    num_indexed_documents, num_deleted_documents, size_bytes_total, id}`, each vector segment `{segment_key,
    id_tracker_key, deleted_bitset_key, num_vectors, num_deleted, id}`. bunvex's id tracker lives in the
    segment blob and its alive bitset with its deleted terms (DV-367), so those keys repeat the segment's and
    the deletes'; every segment is now stored with a deletes blob from the start, as Convex's.
- **Which rows.** One per search and vector index of the active schema, staged ones included, inserted
  `backfilling` when the index appears, removed (its blobs kept, DV-370) when it is dropped or redefined. A staged
  index is not built (as before), so its row stays `backfilling`, staged; Convex builds staged indexes and
  keeps them `Backfilled { staged }` (DV-368).
- **Writes** go through system transactions, one writer in order (the flusher's, the backfill's, the
  compactor's and the schema's changes), and name only blobs already written.
- **Without a segment store**, the rows are kept all the same: an index read from its table is `snapshotted`
  with no segments at ts 0, so a later start with a store replays the whole log or reads the table.
- **The catalog** of tables and database indexes leaves these rows out (`databaseIndexRows`).
- **STUDY-96's snapshot is removed**: segments cover what it did (a clean shutdown flushes, DV-369), and bunvex
  has no data to migrate (owner, 2026-10-05). The engine's `searchSnapshots` option is `searchStorage`.

### 3.8 Fast-forward and retention (PR 7)

- **`_index_worker_metadata`**, Convex's system table (number 542, `by_index_doc_id` on `index_id`): per search or
  vector index, `{index_id, index_metadata: {metadata_type: "text_search" | "vector_search", metadata:
  {fast_forward_ts}}}`, `index_id` its `_index` row's id.
- **The workers' poll**, every `DATABASE_WORKERS_POLL_INTERVAL` (20 s), as Convex's flusher and
  `FastForwardIndexWorker`:
  - **`TooOld`:** a ready index whose memory part is not empty and whose ts is `SEARCH_WORKERS_MAX_CHECKPOINT_AGE`
    (1 h) old is flushed;
  - **fast-forward:** each ready index with nothing in its memory part (and no deletes left to store) gets
    `fast_forward_ts` = now; debounced as Convex's (the first time at once, then once 500 commits —
    `DATABASE_WORKERS_MIN_COMMITS` — or the checkpoint age have passed).
- **A start** uses `max(segments' ts, fast_forward_ts)` (Convex's bootstrap): it replays only the log after it,
  and it is what retention's `document_min_snapshot_ts` is compared with, so an idle index is never overtaken.
- **A clean shutdown** flushes, then fast-forwards every index, instead of rewriting their rows (DV-369).
- **Blobs a crash left unnamed** (between writing a segment or deletes blob and naming it) stay in the store, as
  Convex's: no search blob is ever deleted (DV-370).

### 3.9 Staged search and vector indexes (PR 8)

The owner decided (2026-10-05) to match Convex: a staged index is built like any other, in the background
(`Backfilling { staged }`), then kept `Backfilled2 { snapshot, staged: true }` with its segments, maintained by
every commit, flushed, compacted and fast-forwarded. A search on it answers `IndexStagedError`, as before. A push
that un-stages it keeps the built index and enables it at once (its row becomes `snapshotted`); staging it again
keeps it built. Before, staged indexes were not built at all, and un-staging one started its build.

### 3.10 Segments read from disk (PR 9)

The owner decided (2026-10-05) to build the disk path now, as Convex's: segments are read from local files,
memory-mapped, instead of loaded whole into memory (DV-371 resolved). `SegmentFiles`
(`core/src/search-segments.ts`):

- **Mapping.** Bun maps files: `Bun.mmap(path, { shared: false })` returns a `Uint8Array` over the file, starting
  at offset 0 (so 8-byte aligned, as the format's sections need, §3.1). The format reads in place, so a mapped
  segment serves exactly as a loaded one did: the search code is unchanged. The mapping is private
  (copy-on-write): nothing can write through to a stored blob. No positioned-read fallback was needed.
- **Which file.** A store that keeps blobs as files says where (`SearchSegmentStore.localPath`; the server's
  local blob store, `<local storage>/search/files/<key>.blob`): the segment is mapped from the store's own file,
  with no copy. Any other store (S3) goes through a local cache, `searchCacheDir` (the server's
  `<local storage>/search_cache`): the segment is written there once (a temporary file, then renamed, so a mapped
  file is never one being written) and mapped from there.
- **When.** Every segment is mapped where it used to be held: at start (the segments of each index's row), and
  when the flusher, the backfill or the compactor writes one (mapped from the file just written; its bytes in
  memory are dropped).
- **The cache**, as Convex's temporary directory, starts empty at each start, and holds the segments the indexes
  use: when a row stops naming a segment (a compaction replaced it, its index was removed), its cached copy is
  removed; a mapping still read stays valid until dropped. The store's own files are never removed (DV-370).
  Unlike Convex's, it has no size bound (DV-372, decided by the owner): every segment of every index stays mapped while the process
  runs, since a search reads them all.
- **Deletes** (the small bitsets a commit rewrites) stay in memory, as do the memory parts.
- With neither a local store nor a cache directory (an engine embedded with an in-memory store), segments are held
  in memory as before.

**Measured** (`bench/search-segments.ts`, 200 000 documents of 12 words, one text and one 64-dimension vector
index, SQLite and file blobs, an Apple laptop under load from other work; `SEARCH_DISK=1` maps the store's files,
`SEARCH_DISK=cache` goes through the cache). Each restart is a process of its own, after a clean close, measured
once its compactions are done. The physical footprint is macOS's: the dirty memory the process holds, without
the clean pages of mapped files, which the OS drops under pressure and reads back from disk. The RSS counts
those pages (the mapped segments, and SQLite's), so it is about 0.9–1 GB after the queries in every mode.

| | in memory | mapped (local store) | mapped (cache, as S3) |
|---|---|---|---|
| restart until ready | 27–53 ms | 25–42 ms | 50–84 ms (copies into the cache) |
| footprint once ready | 134–135 MB | 22–23 MB | 24 MB |
| footprint after 250 queries | 151–155 MB | 44–49 MB | 38–43 MB |
| text query, first / median | 63–68 / 51–54 ms | 73–76 / 51–52 ms | 64–70 / 49–51 ms |
| vector query, first / median | 18–21 / 13.3–13.6 ms | 20–27 / 13.0–13.6 ms | 19–21 / 12.6–13.1 ms |
| restart after a crash (20 000 writes since) | 1.27 s | 1.20 s | 1.22 s |

The ~112 MB difference is the indexes' segments (122 MB of files), now pages of files instead of process memory;
latency is the same within the noise of the machine. The JS heap reads 114 MiB in every mode because Bun counts a
mapped buffer's length in it. Write throughput is unchanged (4100–4700 documents/s in all three runs, as noisy as
the machine). The cache held exactly the three segments in use (122 MB); the store kept every blob ever
written (570 MB, DV-370).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| E1 | Segments are bunvex's own binary format: a text segment is one blob (terms, postings, documents, forward index) plus a deletes blob, not a tantivy archive with an id tracker, an alive bitset and a deleted-terms table; a vector segment is a flat array of normalized vectors plus a deleted bitset, not a qdrant HNSW segment | Não dá pra fazer: tantivy and qdrant are Rust libraries. The flat vector segment follows DV-269 (exact search). Not observable: answers are the whole index's | owner, 2026-10-05 (build E; the format follows), DV-367 |
| E2 | Search and vector indexes' `_index` rows are Convex's `config` with bunvex's identity fields (`tablet`, `name`, as its database index rows); the backfill cursor is the document id's bytes, not an index key; a non-staged index has no `Backfilled` state (it is enabled once built). Staged indexes are built and kept `Backfilled { staged }`, as Convex's (PR 8) | Identity fields: DV-53. Cursor and states: bunvex's backfill and push. Count, config and staged indexes as Convex's | owner, 2026-10-05 (rows as Convex's; staged as Convex's). DV-368 |
| E3 | A clean shutdown flushes every index, so the next start replays nothing | Keeps the guarantee of STUDY-96's snapshot (option D, the owner's, 2026-10-04) now that E replaces it; Convex's next start replays the writes since the last flush (at most 10 MiB, or an hour once PR 6 lands). Operational: shutdown takes one flush per index | owner, 2026-10-05: keep it. DV-369 |
| E4 | ~~Replaced segment and deletes blobs, and those of a removed index, were deleted from the `search` store~~ | Resolved: no search blob is deleted, as Convex's | owner, 2026-10-05 (match Convex). DV-370 |
| E5 | ~~Segments were loaded into memory at start and searched there, not read from disk through a cache of memory-mapped files~~ | Resolved (PR 9): segments are memory-mapped files, as Convex's | owner, 2026-10-05 (build the disk path now). DV-371 |
| E6 | The local cache of segments has no size bound: it holds every segment the indexes use, all mapped while the process runs; a local store's segments are mapped from its own files, not copied into the cache | Not built yet: Convex's 500 MiB LRU evicts archives no query holds, because its searcher opens segments per query; bunvex's indexes keep every segment open (a search reads them all), so a bound would evict nothing. Bounding it needs segments opened per query. Mapping a local store's files in place avoids a second copy; not observable. Operational: local disk with S3 (the size of the indexes' segments) | owner, 2026-10-05: keep it unbounded. DV-372 |

## 5. Tests

**PR 1** (`packages/search/test/segments.test.ts`):

- a text segment built from documents gives back every document (`get`), its id lookup, per-term postings and
  document frequencies, prefix ranges, filter key ordinals and totals equal to the documents';
- random documents (Unicode terms, duplicate tokens, missing and long filter keys, empty texts): every
  statistic equals a direct count;
- the deletes: counts, tokens, bytes and per-term deleted frequencies, encoded and decoded;
- a vector segment: ids, vectors bit for bit, filter key ordinals; its deletes;
- a corrupt or foreign buffer (wrong magic, format or kind, truncated) is refused;
- opening does not copy: every section is a view over the given buffer.

Sabotage checks (each made a test fail): posting frequencies off by one; fieldnorm stored as the raw length;
deleted terms not counted; deleted tokens encoded wrong; deletes of another segment accepted; the kind not
checked; a prefix range that skips terms; vectors written at the wrong place; an unaligned buffer not copied.

**PR 2** — the differential tests (`packages/search/test/segmented-text-index.test.ts`,
`segmented-vector-index.test.ts`), 12 seeds × 500 steps each:

- the oracle is today's single in-memory index: `TextIndex` for text, and for vectors today's search (one map,
  every vector, every hit sorted);
- random writes and deletes of 100–120 documents with shared prefixes, accents, long texts (lossy fieldnorms),
  few distinct creation times and vector components (ties), and missing filter fields;
- random flushes, prepared and committed later with writes between;
- random compactions of some segments, prepared, then (flushes landing meanwhile) reconciled and committed, with
  writes between the reconcile and the commit;
- random crashes: a new index from what was stored (segments, their stored deletes) plus the documents changed
  since the last flush at their current state, as the engine's start replays the log;
- after every step: the size, the indexed bytes, a document, and three searches (text: 1–3 tokens with prefix,
  filters, and a random overlay of pending writes and deletes; vector: limits 0–256 and filters), compared with
  the oracle hit for hit, scores bit for bit, in order. 18 000 text and 18 000 vector searches in all.
- Unit tests: a flush keeps the changes made after its prepare; segments loaded after a change arrived;
  equal and NaN vector scores in Convex's order across a segment and the memory part.

Sabotage checks (each made a test fail): segment deletes left out of document frequencies, or of the token
total; deleted, or overlaid, segment documents scored; the overlay's base not subtracted; no prefix expansions
from segments; a compaction dropping the deletes made since its prepare, or not storing them; a flush leaving
later changes' segment copies alive, or dropping changes made after its prepare; a load keeping stale copies;
segment filter ordinals not compared; vector: deleted segment documents compared, a segment's first filter key
ignored, ties with the worst kept hit dropped, NaN scores last, the memory part's filter ignored.

**PR 3** (`packages/core/test/search-segments.test.ts`; the STUDY-96 tests now cover reading an earlier version's
snapshot):

- a memory part over its soft limit is flushed (a text and a vector segment, the state naming both); after a
  crash a start loads them and replays only the three documents written since, for each index, with the
  answers of indexing the tables (text with and without a filter, vector);
- a clean shutdown flushes: the next start replays nothing;
- flushes with deletes: every blob the state names is stored, and the replaced deletes are kept (as Convex), and a
  start loads them with the same answers;
- a state not trusted is not used, and the answers are the table's: a changed definition (that index only),
  outside retention, missing blobs, unreadable blobs, a store with no state;
- an index built from its table is ready once its segment is stored; a dropped index's state and blobs are
  removed;
- a commit landing while a start replays the log is kept (the replay's older version does not overwrite it);
- **a process killed** (SIGKILL) after a flush and 30 more writes, on SQLite and file blobs: the next start loads
  the segments, replays exactly those 30 documents per index, and answers as indexing the table does.

Sabotage checks (each made a test fail): replaying from the start of the log; no replay; the flushed state's ts
one behind; the definition, or retention, not checked; the replay overwriting a
commit made during the start; no flush before a built index is ready; a dropped index's state kept; a memory
part over its limit not flushed; no flush at a clean shutdown; keys above U+D800 sorted in UTF-16 order, or
surrogates not swapped (segment term order).

**PR 3b** (`packages/core/test/search-segments.test.ts`, `packages/server/test/index-too-large.test.ts`):

- a write to a table whose text index's memory part is at its limit fails with `TextIndexTooLarge` and Convex's
  message; another table's write goes through; once the refusal's flush is done, writes go through; the same
  for `VectorIndexTooLarge`; without a store, never refused;
- HTTP 503 with the code and message, then 200 after the flush; sync closes with 1013 and the code; an
  action's `runMutation` gets a plain `Error` it catches; a scheduled mutation is delayed, then succeeds.

Sabotage checks (each made tests fail): no check before the commit; the text or the vector limit never
reached; the refusal not waking the flusher; the wrong code; refusing without a store.

**PR 4** (`packages/core/test/search-backfill.test.ts`):

- a new index on 120 documents is built in more than 10 steps, with writes between pages (documents already
  read and not yet read changed, some deleted, new ones inserted); every index has several segments and no
  cursor once ready; the answers are those of indexing the table at once;
- a build stopped after three steps by a crash, with writes between the runs to documents it had read: the
  state has a cursor; the next start resumes both indexes from it (a search meanwhile answers
  `IndexBackfillingError`), reads fewer documents than the table holds, and answers as indexing the table;
- an empty table's index is ready at once with no segments.

Sabotage checks (each made a test fail): no log walk for the earlier pages; the memory part truncated past the
step's ts; no resume; a resumed index answering as bootstrapping; the earlier copies of updated documents kept;
the cursor not stored; the log walk taking later pages too.

**PR 5** (`packages/core/test/search-compaction.test.ts`; the PR 2 differential tests now compact with
`merge`):

- which segments are merged: Convex's rules (fewer than three small ones, smallest first, ten at most, large
  ones only when three fit, a large one more than 20 % deleted alone, a small one not, random among the
  candidates);
- one segment per commit: the compactor keeps their number under five; every blob the state names is stored,
  and none is deleted; the answers are the table's, and a restart's;
- a compaction held between its build and its commit while documents in its segments change and are deleted and
  flushes store those deletes: the merged segment carries them; after a crash right then, the start (no replay)
  answers the same;
- a large segment more than 20 % deleted is rewritten (15 documents, none deleted); with every document deleted
  the segments are dropped (their blobs stay).

Sabotage checks (each made tests fail): the deletes since the prepare not carried; the carried deletes not
stored; no compaction after a flush; the largest segments first; the deleted
fraction not checked; fewer than the minimum merged; merge: term frequencies off by one, deleted documents kept,
filter keys not remapped, a wrong document's vector, duplicates kept in a merged table (hangs).

**PR 6** (`packages/core/test/search-index-rows.test.ts`; the earlier tests read the state from the rows):

- a schema with a text, a staged text and a vector index has three such rows; the text row is Convex's
  `Search` config (filter fields sorted), `snapshotted` with version 2 and Convex's segment fields; the vector row
  Convex's `Vector` config with its segment fields; the staged row `{state: "backfilling", staged: true}` from
  the first start; the database rows are untouched;
- a push that drops an index removes its row; a new index's row is `backfilling` while held, then `snapshotted`;
- without a store, the rows exist, `snapshotted` with no segments at ts 0.

Sabotage checks (each made tests fail): search rows read as database indexes; the rows synced before the vector
indexes are reconciled; the snapshot written with another version; filter fields not sorted in the row; the
staged flag not kept.

**PR 7** (`packages/core/test/search-workers.test.ts`):

- an index holding a write in memory is not fast-forwarded; a clean shutdown flushes then fast-forwards, in
  `_index_worker_metadata`'s shape (`text_search`, `vector_search`), past the rows' ts; writes to another table
  move the clock and a tick fast-forwards both indexes again; after a crash, with retention past the rows' ts
  but not the fast-forward's, a start loads the segments and replays nothing;
- a memory part older than the checkpoint age is flushed by a tick;
- no blob is deleted: an old unnamed one, and the deletes a flush replaces, stay; the answers are unchanged.

Sabotage checks (each made a test fail): the fast-forward ts ignored at start; busy indexes fast-forwarded; no
`TooOld` flush; no fast-forward at shutdown;
retention checked against the segments' ts only.

**PR 8** (`packages/core/test/search-staged.test.ts`; the `_index` rows test expects `backfilled2`):

- a push with a staged text and a staged vector index builds them: `Backfilled2 { snapshot, staged: true }` with
  segments, both ready and staged, searches answer `IndexStagedError`; writes keep them current;
- a push un-staging them enables them at once, with no new backfill step, the answers including the writes made
  while staged, and the rows `snapshotted`; staging them again keeps them built, `backfilled2` again;
- a start loads a staged index from its segments.

Sabotage checks (each made tests fail): a staged index not built; un-staging rebuilding the index; a staged index
not kept current by commits; a staged row written as `snapshotted`.

**PR 9** (`packages/core/test/search-disk.test.ts`; `server/test/search-storage.test.ts`;
`file-storage/test/local.test.ts`):

- with a store that keeps blobs as files, flushes, compactions and a restart map every segment from the store's
  files; the answers equal those of the same store read into memory, and of the table indexed from scratch;
- with a store that keeps none (as S3) and a cache directory: the cache starts empty (a file left in it is gone),
  segments are mapped from it, it holds exactly the segments the `_index` rows name (none a compaction replaced)
  while the store keeps every blob, and a restart fills it again and answers the same;
- a mapped segment is a private mapping: writing to it leaves the stored blob unchanged;
- the server's search store names a local blob store's files (and none for another store).

Sabotage checks (each made tests fail): the store's own files not mapped (2); a restart reading blobs into memory
(2); a cache file written truncated (1); a flushed segment mapped from another key (2); replaced segments kept in
the cache (1); the cache not emptied at start (1); a shared mapping (1).

## 6. Open questions

- ~~Segments in RAM or on disk~~ decided by the owner (2026-10-05): on disk, built in PR 9 (DV-371 resolved).
- ~~The cache's bound~~ decided by the owner (2026-10-05): kept unbounded (DV-372). Convex bounds its archive cache at 500 MiB (LRU) beyond the archives queries
  hold; bunvex's cache holds every segment in use, unbounded, since every index keeps all its segments open.
  Only an S3 deployment has the cache (a local store's files are mapped in place); its size is the indexes'
  segments (122 MB at 200 000 documents). A bound would need segments opened per query, for no saving while every
  segment is searched.
- ~~The clean-shutdown flush~~ decided by the owner (2026-10-05): kept (DV-369).

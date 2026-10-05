# STUDY-111 — Persisted search segments

- **Status:** decided by the owner (2026-10-05: "build E now", STUDY-79 §6 option E); PR 1 (the segment
  formats) implemented
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
  cache of downloaded archives (`search/src/archive/cache.rs`), memory-mapped.
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
| 6 | `feat/search-segments-retention` | Fast-forward, `TooOld` flushes, retention, garbage collection; the STUDY-96 snapshot removed |
| 7 | `feat/search-segments-disk` | (optional) segments queried from disk instead of RAM |

### 3.1 The segment formats (PR 1, `@bunvex/search`)

One binary layout for both kinds (`segment-file.ts`): a header, then sections aligned to 8 bytes, each a typed
array over the same buffer. Opening a segment decodes nothing: every lookup reads the buffer in place, so a
segment costs its bytes in memory, and the same code can later run over a memory-mapped file (PR 7).

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

### 3.2 The rest of the series (planned; each PR updates this section)

- **The memory part (PR 2).** Per index, the documents changed since the segments' ts, in today's in-memory
  structure, plus each segment's deletes in RAM: a write marks the document's segment copy deleted at once
  (Convex's tombstones). A search merges the segments and the memory part with the statistics of the whole
  index (§1.3), then the transaction's overlay, exactly as today's single index. A differential test runs
  random writes, flushes, compactions and restarts and compares every answer with today's `TextIndex` and
  vector index.
- **Index state (PR 3).** Per index: its kind, tablet, name and definition, `backfilling` (with its cursor) or
  `ready`, its ts and its segments (keys of the segment and deletes blobs, counts). Convex keeps it in the
  `_index` row; bunvex has no `_index` rows for search indexes yet (platform §search), so it is kept in a
  persistence global, `search_segments`, written after the blobs it names.
- **Flusher (PR 3).** Over the soft limit (10 MiB text, 30 MiB vector, by an estimate of the memory part's size),
  the memory part is written as one new segment plus the older segments' deletes, at the visible ts, then the
  state; the memory part keeps only the writes after that ts.
- **Start (PR 3).** Each ready index loads its segments and replays the document log since its ts, as
  STUDY-96's restore does; searches answer `SearchIndexesUnavailable` meanwhile.
- **Backpressure (PR 3).** DV-228 resolved: Convex's 100 MiB `TextIndexTooLarge` / `VectorIndexTooLarge`.
- **Backfill (PR 4).** Convex's paged backfill (§1.4): a segment per page of the table at a fresh ts, the log
  since for the pages before; the cursor in the state.
- **Compactor (PR 5).** Convex's thresholds (§1.5) and the writer's reconciliation.
- **Fast-forward, retention, GC (PR 6).** §1.6; a state whose ts is older than `document_min_snapshot_ts` is not
  used; replaced segment and deletes blobs are deleted once the state no longer names them.
- **Query from disk (PR 7, optional).** RAM until then: see §6.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| E1 | Segments are bunvex's own binary format: a text segment is one blob (terms, postings, documents, forward index) plus a deletes blob, not a tantivy archive with an id tracker, an alive bitset and a deleted-terms table; a vector segment is a flat array of normalized vectors plus a deleted bitset, not a qdrant HNSW segment | Não dá pra fazer: tantivy and qdrant are Rust libraries. The flat vector segment follows DV-269 (exact search). Not observable: answers are the whole index's | owner, 2026-10-05 (build E; the format follows), DV-367 |

Later PRs add their rows here (state storage, garbage collection, the shutdown flush, RAM queries).

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

Sabotage checks: see the PR.

## 6. Open questions

- **Segments in RAM or on disk.** PRs 1–6 load every segment into RAM: it already bounds the memory of the
  write path (the memory part) and is much more compact than today's maps, while queries keep today's
  speed. Querying from disk (memory-mapped segments, as Convex's cache) bounds memory by the OS page cache
  instead, at some query latency; the format is laid out for it, and it is PR 7. Measured in PR 3.

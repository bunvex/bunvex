# STUDY-79 — Search and vector indexes while they are rebuilt after a start

- **Status:** implemented (the Convex answer and the sync skip); the rebuild window's length is DV-227 /
  DV-270's (owner-decided), with options in §6
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-04; the removed tests at
  bea52bde0
- **Related:** [STUDY-45](STUDY-45-text-search.md) S1 (DV-227), [STUDY-51](STUDY-51-vector-search.md) V2–V3
  (DV-270, DV-271), [STUDY-29](STUDY-29-index-backfill.md) (backfilling), client-sync's
  temporarily-unavailable row

## 1. How Convex does it

**Bootstrapping** (`crates/database/src/search_index_bootstrap.rs`; `database.rs:839-840`, `:1224-1248`):

- **At start.** The database starts with its text and vector index managers in `Bootstrapping`
  (`crates/search/src/text_index_manager.rs:108-112`, `crates/vector/src/vector_index_manager.rs:71-75`).
- **The replay.** A background worker rebuilds the memory part of each index from its persisted segment's ts:
  - it streams the document log from the oldest of them up to the latest snapshot (`:245-301`, `:405-419`);
  - it hands over to the committer, which applies the commits made since (`committer.rs:669-715`);
  - then both managers are `Ready`.
- **How long.** Startup does not wait for it. Its cost is the writes since the last segment, which flushers
  keep small (10 MiB text, 30 MiB vector), not the table's size.
- **During it**, **writes are allowed**: an update while `Bootstrapping` returns early, and the catch-up
  replays it (`text_index_manager.rs:302-304`, `vector_index_manager.rs:212-224`).

**What a search gets meanwhile:**

- A text search gets `ErrorMetadata::feature_temporarily_unavailable("SearchIndexesUnavailable", "Search
  indexes bootstrapping and not yet available for use")` (`text_index_manager.rs:123-133`).
- A vector search gets `("VectorIndexesUnavailable", "Vector indexes are bootstrapping and not yet available
  for use")` (`vector_index_manager.rs:179-190`).
- **Empty searches.**
  - A literal empty search string returns nothing before any index check (`Search::is_empty`,
    `transaction.rs:1303-1307`).
  - So does a search with no terms, before the bootstrapping check (`text_index_manager.rs:236-244`; the old
    test `empty_search_works_while_bootstrapping` checks `""`, `"    "`, `"\n"`, `"\t"`).
- **The error's class** (`crates/errors/src/lib.rs`):
  - it is not a deterministic user error (`:513-533`), so it aborts the query or mutation without the JS code
    seeing it (`isolate/src/request_scope.rs:375-385`);
  - HTTP 503 with `{code, message}` (`:724-728`; `local_backend/src/public_api.rs:456-500`);
  - WebSocket close `Again` (`:681-691`).
- **In an action**, `ctx.vectorSearch` rejects with a plain `Error(message)` the action may catch
  (`helpers/promise.rs:60-75`).
  - `Database::vector_search` retries up to 5 times only `if e.is_overloaded()` (`database.rs:2635-2675`).
    The bootstrapping error is not overloaded, so it is **not retried**; its comment there is stale.
  - So STUDY-51 V3's premise (DV-271: "Convex retries up to 5 times") was wrong.
- **A new index a push adds** is different: it is `Backfilling` and answers `IndexBackfillingError`, a bad
  request the function may catch (`indexing/src/index_registry.rs:856-861`).

**The sync worker** (`crates/sync/src/worker.rs`):

- A query failing with a feature-temporarily-unavailable error becomes `QueryResult::TemporarilyUnavailable`
  (`:1194-1201`, documented at `:290-292`).
  - It is left out of the transition: no modification, though the transition is still sent with the new
    version (`:1241-1312`).
  - It keeps no subscription, so the next update runs it again (`state.rs:379-391`).
  - The worker schedules that update after `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY` (3 s,
    `knobs.rs:1978-1981`; `worker.rs:387-398`, `:467-473`).
- So a new query stays loading and an old one keeps its last value until the index is ready.
- A **mutation** that searches meanwhile fails the worker: the socket closes with `Again` and the reason
  `SearchIndexesUnavailable`, and the client reconnects (`web_socket_manager.ts:125-128`: 1 s backoff for
  these reasons) and resends.
- **Scheduled mutations.** A scheduled job's system error is retried later, not failed.

## 2. What an app can observe

1. Right after a start, a search query, or a mutation that searches, fails with Convex's
   `SearchIndexesUnavailable`:
   - the function cannot catch it;
   - HTTP 503 `{code, message}`;
   - over sync, a subscribed query is skipped and answered once the index is ready, and a mutation closes the
     session with 1013 `SearchIndexesUnavailable` (the client retries).
2. `ctx.vectorSearch` throws a catchable `Error("Vector indexes are bootstrapping and not yet available for
   use")`.
3. Empty searches return nothing, whatever the state.
4. Writes work.
5. A new search index added by a push answers `IndexBackfillingError`, which the function may catch, until it
   is built.
6. **How long** this lasts: on Convex, the writes since the last segment flush (seconds); on bunvex, the whole
   table (below).

## 3. How bunvex does it

bunvex keeps search and vector indexes in memory and rebuilds them from their tables at every start. That is
DV-227 and DV-270, decided by the owner. This study does not change it; it makes the rebuild window look as
Convex's bootstrapping does.

- **Which indexes are bootstrapping.** Each search and vector index entry has a `bootstrapping` flag, set for
  the indexes of the schema the engine starts on (`reconcileSearch(true)` / `reconcileVector(true)` in
  `init()`). A later push's new index is not bootstrapping, so it stays `IndexBackfillingError`.
  - bunvex has no `_index` rows for search indexes, so an embedded engine whose code schema adds a search
    index to an existing table at its first start reports it as bootstrapping rather than backfilling. Both
    are "not yet": only the error's class differs, and only in that case.
- **The errors** are `IndexesUnavailableError` (`@bunvex/core`, `searchIndexesUnavailable()` /
  `vectorIndexesUnavailable()`) with Convex's codes and messages.
  - A text search raises it through `failExecution`, so a function cannot catch it.
  - The server classes it as a system error that should be retried (`isSystemError`, `isTryAgainError`).
- **The empty-string short-circuit** comes first. A search whose text has no terms also returns nothing while
  bootstrapping.
- **Server:**
  - `/api/query`, `/api/mutation` and the others answer 503 `{code, message}`.
  - An action's `runQuery`, `runMutation` and `vectorSearch` get a plain `Error(message)`.
  - A scheduled mutation is retried later, as a system failure.
- **Sync.**
  - A run that hits it is a `TemporarilyUnavailable` execution: never kept for other sessions, no
    modification, and the query is left stale.
  - The session runs an update again after `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY` (3 s).
  - A mutation closes the session with 1013 and the code.
- **Vector backfills** now await the engine's `beforeSearchBackfillPage` hook too, so tests can hold them.

**Measured.**

| What | Result |
|---|---|
| A text search (read-only mutation, `take(5)`, 2000 documents, median of 5 × 20 000) | `main` 36.1–36.3 µs, this branch 37.0–37.7 µs (minimums 36.0 against 36.1–36.3): within noise, one `find` over the filters |
| The rebuild window itself (unchanged by this study) on SQLite, ~80-byte texts | 10 000 documents: 0.2 s; 100 000 documents: 2.1 s. About 20 µs a document, so ~20 s for a million |

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| B1 | The rebuild window lasts as long as the tables take to index (§3), not the writes since a segment | DV-227 / DV-270: in memory, no segments | owner (DV-227, DV-270); options in §6 |
| B2 | A scheduled mutation that hits it stops the scheduler's loop for its backoff (bunvex's handling of every system failure), rather than retrying that one job | Existing executor behaviour for system failures | not new (scheduler) |

DV-271 (STUDY-51 V3) is resolved: bunvex now answers at once with `VectorIndexesUnavailable`, which is what
Convex does.

## 5. Tests

**`packages/server/test/search-bootstrap.test.ts`**, against a store restarted with its rebuild held:

- a query gets Convex's code and message;
- a query that catches still fails;
- an empty search returns `[]`;
- writes work and are in the rebuilt index;
- an action's `vectorSearch` gets a catchable `Error` with the message;
- `/api/query` answers 503 `{code, message}`;
- over sync:
  - the query is skipped (no modification), stays skipped through a retry, and is answered after the
    rebuild;
  - a mutation closes with 1013 `SearchIndexesUnavailable`;
- a scheduled mutation stays pending, then succeeds.

**`packages/core/test/search.test.ts`**:

- the restart test now expects `SearchIndexesUnavailable`, and `[]` for `""` and whitespace;
- a new test: a push's new index answers `IndexBackfillingError`, which the function may catch, and `[]` for
  `""`.

**Sabotage checks**, each failing tests:

| Broken | Tests failing |
|---|---|
| bootstrapping treated as backfilling | 5 |
| the error made catchable | 1 |
| sync not skipping | 1 |
| no retry timer | 1 |
| no 503 | 1 |
| the raw error in actions | 1 |
| no empty-string short-circuit | 1 |
| the scheduler not retrying | 1 |

## 6. Open questions

**How long the window lasts** is the owner's (DV-227, DV-270: "persisted later"). The options, cheapest first:

| Option | What an app sees | Cost |
|---|---|---|
| A. **As now** (this study): Convex's bootstrapping answer for as long as the tables take to index | Same as Convex, only longer: seconds per 100 000 documents | done |
| B. **Hold readiness** (`/version` and the API refuse traffic) until the indexes are built | Everything unavailable instead of only search | small; worse for most apps |
| C. **Serve the index as it fills** | Wrong (incomplete) results with no error | rejected: breaks the guarantee |
| D. **Snapshot the in-memory indexes at a clean shutdown**, load them at start and replay the log since | Seconds after a deploy or restart; the full rebuild only after a crash | moderate: a format, and a check that the snapshot matches the store |
| E. **Persisted segments**, as Convex (DV-227's "later") | As Convex: the window is the writes since the last flush | large: segment format, flushers, compaction, retention |

**Recommendation:** A now (this PR). Then D when apps with large searchable tables appear, as a cheap step
towards E. Not B or C.

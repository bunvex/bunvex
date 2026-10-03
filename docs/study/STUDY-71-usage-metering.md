# STUDY-71 — Usage metering: database I/O, user time, egress, storage and search bytes

- **Status:** decisions taken (owner, 2026-10-03): text search bytes estimated from the index (U1); Node
  actions' fetch egress is 0, as Convex self-hosted (U2). Built in four PRs (§5); PR 1 (database I/O) is
  implemented.
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:** [STUDY-61](STUDY-61-usage-limits.md) (the meter and limits; DV-309),
  [STUDY-47](STUDY-47-log-streaming.md) (the function log's `usageStats`; DV-251, DV-252)

## 1. How Convex does it

Sources: `crates/usage_tracking/src/lib.rs` (`FunctionUsageTracker`, `UsageCounter`),
`crates/database/src/{reads.rs,committer.rs,transaction.rs,query/index_range.rs}`,
`crates/usage_limits/src/recorder.rs`, `crates/isolate/src/timeout.rs`.

### 1.1 The plumbing

- A tracker per function run sums counters keyed by component and table; it is flushed once, when the run
  ends (`UsageCounter::track_call`). Every `track_*` takes a `skip` flag: system tables (`_…`) are skipped.
- **No rounding** anywhere on the database counters: raw bytes, divided by 2^30 only for display.
- The v1 and v2 database counters are equal for a function run (they differ for imports, exports and
  backfills, which bunvex's functions never are). The limit metric `databaseIoGb` reads v2; the function log
  shows both.

### 1.2 Database I/O

- **Sizes** are `ConvexValue::size()` (tag, payload, terminators; an object counts its field names), not
  JSON lengths. A document includes `_id` and `_creationTime`.
- **Reads** (`ReadSet::record_read_document`, the index range stream): each document a `get`, an index range
  or a search hands out — the transaction's own pending writes included, documents a `.filter` then drops
  included — is its size, and one row. From a **user-defined** index (not `by_id`, `by_creation_time` or
  `_…`), each returned row adds its index key's bytes (`IndexKeyBytes`, the sort-key encoding; a user index's
  key is `[fields…, _creationTime, _id]`).
- **Writes** (`Committer::track_commit`), only once the commit succeeds:
  - per written document one row, and `num_index_writes` index rows: per index (system ones included) one
    entry, two when its key changed (the old one removed);
  - bytes: the new version's size (a delete adds none), plus `IndexKey::size` (33 for the id, plus each
    indexed value's size, `_id` included) of each user-defined index entry it adds — even when the key did not
    change.
- A failed or conflicting mutation is charged its reads, not its writes.

### 1.3 Search

- **Text:** each non-empty search charges `bytes_searched`, the sum of the index's on-disk segments (0 while
  it backfills; the in-memory part not counted). Result documents are database reads too.
- **Vector:** non-deleted vectors × the query's dimensions × 4; results add (id size + 4) each to the
  vector egress.
- `searchQueryGb` sums both.

### 1.4 Egress and storage

- **`fetch` in V8 actions:** the request body's bytes as they stream, per origin; not headers, the URL or the
  response. Node actions read the Lambda NIC counter (`/proc/net/dev`): 0 outside Lambda.
- **Storage from actions:** `ctx.storage.store` is one call plus the stored bytes (ingress);
  `ctx.storage.get` one call plus the bytes streamed (egress).
- **HTTP storage routes:** a call and the bytes, not attributed to a function.
- `dataEgressGb` = network egress + storage egress (function and HTTP). `functionCalls` includes storage calls.

### 1.5 System functions

- `_system/*` runs do not count as calls, but their compute and bandwidth do (`is_tracked` gates only the
  call count). A cached query has no reads, memory or time.

### 1.6 Compute

- `gb_s = memory_mb / 1024 × duration_s`; isolate functions 64 MB, Node actions 512 MB.
- **User execution time** is not CPU time: the run's wall time minus its pauses (database syscalls, waiting
  for a concurrency permit, initialisation, module loads). `actionComputeCpuGbHours` uses it; Node actions
  have none.

## 2. What an app can observe

- `get_current_usage` and when usage limits trip (`databaseIoGb`, `searchQueryGb`, `dataEgressGb`,
  `functionCalls`, the compute metrics).
- The function log and the log streams' `usage` fields (`database_io_*`, `database_write_index_rows`,
  `storage_*`, `text_index_query_bytes`, `network_egress_bytes`, `user_execution_time`).

## 3. How bunvex does it

- **Database I/O (PR 1, this PR).** The transaction meters what Convex does (`Tx.io`):
  - reads in `get` (its pending writes included), the index range stream and the unfiltered fast path;
  - an index key's bytes from `keyBytesLength`, the length of bunvex's sort keys, which are Convex's encoding
    (STUDY-18), computed without encoding (property-tested equal to the encoded length);
  - writes at completion when the mutation committed, with `IndexKey::size` (`indexKeySize`) and the index
    rows per index.
  - The function log's `usageStats` and the meter's `databaseIoGb` use it.
- **Measured:** 16 000 documents read by a user index and by a scan:

  | Store | Index | Before | After |
  |---|---|---|---|
  | SQLite | `by_n` | 97–101 ms | 106 ms (+5–9 %) |
  | SQLite | scan | 98–101 ms | 104–105 ms (+4–7 %) |
  | Memory | `by_n` | 22–23 ms | 29–31 ms |
  | Memory | scan | 21 ms | 26 ms |

  The cost is the documents' size, about 0.3 µs per document read, the same work Convex does when it packs
  a document. A first version that re-encoded each index key cost +70 % in memory. Writes are unchanged
  (5000 inserts: 90–95 ms before and after).
- **Later PRs:** user time (PR 2), egress and storage (PR 3), search bytes (PR 4); §5.

## 4. Divergences

| # | Topic | Convex | bunvex | Why | Decision |
|---|---|---|---|---|---|
| U1 | Text search bytes | the on-disk segments' bytes per search | the index's indexed bytes (each document's search field and filter values, Convex's `text_ingress` measure) per search | Não dá pra fazer igual: bunvex's text index has no segments | DV-317, owner, 2026-10-03 (as recommended) |
| U2 | Node actions' egress | the Lambda NIC counter, 0 elsewhere | 0 | Same as Convex self-hosted: not a divergence | owner, 2026-10-03 (as recommended) |

Found while reading, not divergences of this study:

- The transaction's read limit counted JSON lengths, every prefetched document and system-table reads;
  Convex counts the documents handed out by their sizes, system reads in a separate, unlimited budget.
  Fixed in the PR after PR 1: the limit now counts what the metering does (`Tx.countEgress`), so the two
  can no longer disagree.

## 5. Plan

| PR | What | Closes |
|---|---|---|
| 1 | Database I/O as §1.2 | DV-251's I/O and index rows; DV-309's database part |
| 2 | User execution time: wall time minus database and permit waits | DV-252; DV-309's CPU part |
| 3 | `fetch` egress, action storage calls and bytes, `dataEgressGb`, system functions' calls | DV-251's storage and egress; DV-309's egress, storage and system parts |
| 4 | Text (U1) and vector search bytes | DV-251's search fields; DV-309's search part |

## 6. Tests (PR 1)

- `packages/server/test/usage-database-io.test.ts`: exact bytes, worked out by hand from Convex's rules, for:
  - an insert, a patch that keeps every key, a patch that moves one, a delete;
  - reads by a user index, a scan, a filter (dropped documents included) and a get;
  - system tables (a scheduled job, `db.system`);
  - a transaction reading its own write;
  - a failed mutation.
- `packages/values/test/sorting.property.test.ts`: `keyBytesLength` equals the encoded length.
- Sabotage checks, each failing a test:
  - system skips (read, write);
  - reserved indexes (read, write);
  - committed-only writes;
  - one entry for an unchanged key;
  - the pending-write read;
  - the stream path;
  - the fast path;
  - document bytes on write.

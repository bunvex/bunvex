# STUDY-72 — Table summary checkpoints

- **Status:** implemented. Owner decision (2026-10-03): an unusable checkpoint falls back to the scan
  (DV-318).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-03
- **Related:**
  - [STUDY-52](STUDY-52-shape-inference.md) (the table summaries; A3, DV-300);
  - PERSIST-01 C12 (the document log), C14 (globals), C16 (document versions, the PR before this one);
  - [STUDY-33](STUDY-33-retention.md) (document retention).

## 1. How Convex does it

Sources: `crates/database/src/table_summary.rs`, `crates/application/src/table_summary_worker.rs`,
`crates/database/src/committer.rs` (`FinishTableSummaryBootstrap`), `crates/common/src/knobs.rs`.

### 1.1 What is stored

- **One persistence global**, `table_summary_v2`, holds one JSON value:
  `{tables: {<tablet>: {totalSize, inferredTypeWithOptionalFields}}, ts}`.
  - `totalSize` and `ts` are `JsonInteger` strings.
  - A table's count is its counted shape's count.
  - There is no version field beyond the key's `_v2`.

### 1.2 When it is written

- **The worker** (`table_summary_worker`, on the lease holder) ticks every 10 s.
- **Before bootstrap ends**, it writes on every tick.
- **After that, it writes when** any of these holds:
  - 500 commits came since the last write (`DATABASE_WORKERS_MIN_COMMITS`);
  - any commit came and the checkpoint is 10 min old (`TABLE_SUMMARY_MAX_AGE_WITH_WRITES`);
  - the checkpoint is 4 h old, ± a jitter of up to 900 s (`TABLE_SUMMARY_MAX_CHECKPOINT_AGE`,
    `TABLE_SUMMARY_AGE_JITTER_SECONDS`), re-rolled after each write.
- **Failures:** a lost lease shuts the worker down; any other failure is retried on the next tick.

### 1.3 On start

- **The bootstrap:**
  1. loads the checkpoint;
  2. replays the document log from its ts to the target ts, each change with its previous revision (old out,
     new in);
  3. without a checkpoint, scans every table at a recent snapshot.
- **The finish:** while the committer holds commits, it replays from the new checkpoint to the latest ts.
- **Until then**, counts and shapes are unavailable: `TableSummariesUnavailable`, a 503.
- **A checkpoint it cannot use** — unparsable, or outside document retention — fails the bootstrap.
  - The worker retries every 10 s; there is no fallback to a scan.
  - In practice a checkpoint is at most about 4 h old and retention keeps 14 days.
- **Tables:**
  - a table deleted since the checkpoint is dropped from the summaries;
  - a table being deleted keeps its count with an `Unknown` shape.

## 2. What an app can observe

- **Startup:** how long `db.count`-style reads, the dashboard's shapes and table sizes, and schema
  predictions answer `TableSummariesUnavailable` after a restart.
  - With a checkpoint this is the replay of the last minutes of the log.
  - Without one it is a read of every document.
- Nothing else: the summaries are the same either way.

## 3. How bunvex does it

`table-summary-checkpoint.ts`, `TableSummaries.restore` / `replace` / `checkpoint`, `Engine.buildSummaries`.

- **Format.** The same global and layout as Convex:
  - per tablet `totalSize` (a decimal string) and `inferredTypeWithOptionalFields`;
  - the shape in bunvex's JSON (`shapeToJson`; an object's fields as ordered pairs), with its count as the
    table's;
  - `ts` (a decimal string).
- **Worker.** `SummaryCheckpointer`, Convex's knobs and defaults. It writes once the summaries are built,
  then by Convex's rules; a lost lease stops it.
- **Restore.** On start, when the store has the document log, globals and `getVersions`:
  1. load the checkpoint; it must be at or below the build's snapshot `at`, and within document retention;
  2. read the document log from the checkpoint's ts to `at`, keeping each changed document's id;
  3. per table, read every changed document's version at the checkpoint and at `at`: two `getVersions` per
     1000 ids;
  4. take the old versions out of the summaries and put the new ones in;
  5. check retention again: if it passed the checkpoint meanwhile, the result is discarded.
  - This is the sum Convex's commit-by-commit replay reaches, in far fewer round trips: counts and sizes are
    exact, and shapes are the same counted shapes, composed in another order.
  - Tables that no longer exist are dropped.
  - Commits while the restore runs are queued and applied after it, as for the scan.
- **Fallback.** Anything unusable falls back to the scan (DV-318):
  - no checkpoint;
  - an unparsable one, or a shape it did not write;
  - one ahead of the store;
  - one outside retention, before or during the restore;
  - a store without the methods;
  - `summaryCheckpoints: false`.
- **Measured:** a restart of a SQLite deployment with 50 000 documents, 200 of them changed since the
  checkpoint. The summaries are ready in 5–8 ms, against 441–461 ms for the scan.

## 4. Divergences

| # | Topic | Convex | bunvex | Why | Decision |
|---|---|---|---|---|---|
| C1 | An unusable checkpoint | bootstrap fails, retried every 10 s; the summaries stay unavailable | scans, as before checkpoints, then writes a new checkpoint | Owner's choice: the summaries come back instead of staying unavailable | DV-318, owner, 2026-10-03 (as recommended) |
| C2 | The replay | commit by commit, with previous revisions | per changed document, its version at the checkpoint and now | Not observable: the same summaries | none needed |
| C3 | The shape's JSON | Convex's `CountedShape` JSON | bunvex's (`shapeToJson`) | Not observable: the global is the deployment's own, never shared between the two | none needed |
| C4 | A table being deleted | its shape reset to `Unknown` in the replay | its summary as its documents give it, as bunvex's scan already did (STUDY-52) | Unchanged by this PR: the restore gives what the scan gives | none needed |

## 5. Tests

`packages/core/test/table-summary-checkpoint.test.ts`:

- **Restart:**
  - after a replace, a type-changing patch, deletes and inserts in two tables, it gives the summaries a scan
    gives;
  - the restore uses the checkpoint (a doctored size shows through);
  - it drops tablets that no longer exist;
  - commits during the restore are applied after it.
- **Fallbacks:**
  - unreadable;
  - ahead of the store;
  - outside retention;
  - an unknown shape;
  - retention passing the checkpoint during the restore.
- **Other cases:**
  - a table the log changed that no longer exists;
  - the worker's pacing (500 commits, 10 min with writes, 4 h);
  - a lost lease;
  - shapes round-tripping, optional fields included.

Sabotage checks, each failing a test:

- old versions not removed, new ones not added;
- the ahead check, and the final retention check;
- the 500-commit threshold;
- staleness requiring writes;
- the lease stop;
- the tablet filter, and deleted tablets in the replay;
- always scanning;
- optional fields.

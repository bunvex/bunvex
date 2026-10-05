# STUDY-107 — `count()` on the query initializer

- **Status:** implemented; DV-359 decided (owner, 2026-10-05); C3 (DV-360) and C4 (DV-361) pending (owner)
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-52](STUDY-52-shape-inference.md) (table summaries, the counts), [STUDY-72](STUDY-72-table-summary-checkpoints.md)
  (summary checkpoints), [STUDY-79](STUDY-79-search-index-bootstrapping.md) (bootstrapping errors),
  [STUDY-16](STUDY-16-query-chaining.md) (query stages)

## 1. How Convex does it

**The JS side.**

- `npm-packages/convex/src/server/query.ts:99-104` declares `count(): Promise<number>` on `QueryInitializer` only. It is
  marked `@internal`, so the published `.d.ts` files leave it out (checked: `dist/esm-types/server/query.d.ts` of
  convex 1.46.0 has no `count`).
- `server/impl/query_impl.ts:103-110` implements it on `QueryInitializerImpl`, the object `db.query(table)`
  returns. It sends the async syscall `1.0/count` with `{ table }` and returns the number.
  - `count` reads only the table name: it neither closes nor consumes the query, so the same initializer can still
    be chained or collected afterwards.
  - The stages after it (`withIndex`, `fullTableScan`, `order`, `filter`, `limit`) return a `QueryImpl`, which has no
    `count`.
- `db.query(name)` and `db.system.query(name)` refuse a table on the wrong side before any syscall
  (`database_impl.ts`, `TableReader.query`): "System tables can only be accessed from db.system.query()." and its
  mirror. `db.system.query` takes **any** `_`-prefixed name there, not only the public virtual tables.

**The backend.**

- `crates/isolate/src/environment/udf/async_syscall.rs:681` routes `1.0/count` to `count` (:872-900):
  - the arguments are parsed under `with_argument_error("db.count", …)`. A missing `table`, or a name that is not a
    valid identifier, is an `InvalidArgument` error: "Invalid argument \`table\` for \`db.count\`: …";
  - it calls `tx.count(component, &table)`. `None` (the summaries are not loaded) becomes
    `table_summary_bootstrapping_error(Some("Table count unavailable while bootstrapping"))`:
    `ErrorMetadata::feature_temporarily_unavailable("TableSummariesUnavailable", …)`
    (`database/src/table_summary.rs:546`). That is a system error: the function cannot catch it, HTTP answers 503,
    and the sync worker retries the query;
  - the result is narrowed to `u32` and returned as a float64.
  - There is no system-table guard (unlike `queryStream`/`queryPage`, which apply `system_table_guard` and
    `TableFilter::ExcludePrivateSystemTables`).
- `crates/database/src/transaction.rs:748-760`, `Transaction::count`: a virtual table (`_storage`,
  `_scheduled_functions`) is mapped to its system table (`_file_storage`, `_scheduled_jobs`); any other name is
  counted as it is.
- `database/src/bootstrap_model/table.rs:101-164`, `TableModel::count` / `count_tablet`:
  - a table that does not exist in the namespace counts `Some(0)`;
  - otherwise it records a read of the whole `by_id` index (`record_indexed_directly`, `Interval::all()`). That
    read counts toward the read-interval limit, but no documents or bytes are charged
    ("we haven't explicitly read the documents");
  - the count is `count_snapshot.count(tablet)` (the table summary at the transaction's begin ts, held by the
    transaction for its whole life) plus `table_count_deltas[tablet]`, this transaction's own inserts minus deletes.
- It works in queries and mutations (both have a transaction); actions have no `db`.

## 2. What an app can observe

- `await ctx.db.query("t").count()` is the number of documents of `t`, at the transaction's snapshot, including
  the function's own inserts and deletes so far. A missing table is 0.
- A query that counts re-runs (subscription, cache) on any write to the table, even one that leaves the count
  unchanged.
- No documents or bytes are charged to the read limits; one read interval is.
- `count` exists on `db.query(t)` (and `db.table(t).query()`), and `db.system.query("_storage" |
  "_scheduled_functions")`; not on any later stage. It does not consume the query.
- TypeScript: not in the public types.
- While the summaries bootstrap: an uncatchable `TableSummariesUnavailable` error, "Table count unavailable
  while bootstrapping", 503 over HTTP; a sync subscription is retried.
- A bad name: "Invalid argument \`table\` for \`db.count\`: …".

## 3. How bunvex does it

- `Tx.countTable` (`packages/core/src/tx.ts`) already had Convex's semantics for the `tableSize` system
  functions. It is now open to app transactions: system tables still need system access, through `findTable`, as
  every other read.
- `QueryInitializerImpl.count()` checks the name (`checkIdentifier`, wrapped as Convex's `db.count` argument
  error) and calls `countTable`. It does not close the query state. `QueryImpl` (the later stages) has no `count`.
- `ProjectedQueryInitializer.count()` (`db.system.query`) counts with system access. bunvex stores the virtual
  tables under their public names, so no mapping is needed.
- The `TxQuery` type has `count`. The public `QueryInitializer` (`database-types.ts`) does not: internal, as Convex's.
- **The snapshot's count.** Convex counts at the transaction's begin ts. bunvex's table summaries were the latest
  visible state only, so a transaction whose snapshot was behind (a query that ran while a commit became visible,
  or one run at an older ts) counted the newer state. `TableSummaries` now keeps each commit's count changes
  (`countAt(tablet, snapshot)` subtracts those after the snapshot). They are dropped with the write log's
  commits (`Committer.logStartTs`). A snapshot older than that is out of the write log's retention: `countAt`
  throws `OutOfRetentionError`, a system error (see C4).
- **Bootstrapping.** `TableSummariesUnavailableError` now extends `IndexesUnavailableError` (STUDY-79). So it is
  handled as Convex's `feature_temporarily_unavailable`: the function cannot catch it (`failExecution`), HTTP
  answers 503 with the code, a sync query is skipped and retried, a scheduled job is delayed. `countAt` uses
  Convex's count message. The `tableSize` system functions get the same handling.
- The read: the whole `by_creation_time` index (DV-359), plus the `_tables` entry every query of a table reads.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| C1 | The read is the whole `by_creation_time` range, not `by_id` | Not observable: both cover every document of the table, and both invalidate on any write to it; bunvex's existing `countTable` read | DV-359, owner 2026-10-05 (keep) |
| C2 | The public `QueryInitializer` type has no `count` | Same as Convex (`@internal`, stripped from its published types) | not a divergence (owner 2026-10-05) |
| C3 | `db.system.query(name)` refuses a non-public system table (`_tables`, `_index`, …) and an unknown `_` name before `count`. Convex lets `db.system.query` take any `_` name, and its `1.0/count` has no system-table guard: `db.system.query("_index").count()` counts Convex's index metadata rows, and an unknown name is 0 | Matching is possible, but it would expose bunvex's own system tables (different from Convex's) to app code; Convex's behaviour looks accidental for an internal API | DV-360, **pending (owner)** |
| C4 | A count at a snapshot older than the write log's retention (≥ 30 s by default; the hard byte cap can shorten it) fails with `OutOfRetentionError`. Convex's transaction holds its count snapshot for its whole life | Ainda não fizemos: keeping every change for as long as a running transaction holds its snapshot needs the engine to track live snapshots. A function's system timeout (15 s) is shorter than the minimum retention, so with default limits no function reaches it; a mutation that old already fails at commit with Convex's `OutOfRetention` | DV-361, **pending (owner)** |

The bootstrapping error matches Convex: bunvex has a summaries-not-ready state (the build at start, STUDY-52 /
STUDY-72), and `count()` there throws Convex's code and message as a system error.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/core/test/count.test.ts`:

- the count with the transaction's own inserts and deletes, and a replace that leaves it unchanged;
- a missing table is 0; a bad name is the `db.count` argument error;
- the snapshot's count: a query run at an older ts counts as of it, while later commits are visible;
- the read: a write to the table invalidates (a replace too), another table's does not; a missing table's
  count is invalidated when the table is created;
- no documents or bytes charged, one read interval;
- `count` only on the initializer (`withIndex`, `fullTableScan`, `order` and `filter` results have none);
  `db.table(t).query().count()`; the initializer stays usable after `count`;
- virtual tables through `db.system` (with a mutation's own insert); `db.query("_storage")` refused;
- while the summaries are built: `TableSummariesUnavailable` with Convex's message;
- the changes kept as long as the write log's commits, and `OutOfRetentionError` past them (a unit test and an
  engine test with zero retention).

`packages/server/test/count.test.ts`: from an app's query and mutation; a sync subscription re-run on a write;
while the summaries are built, the error is uncatchable, HTTP 503 with the code, and a sync query is skipped,
then answered.

`packages/core/test/types/database.test.ts`: `count()` is a type error on the public `QueryInitializer`.

`packages/sync-e2e/test/count-oracle.test.ts` (oracle): Convex's own `setupReader()` from the `convex`
package, its syscalls answered by the test, against a bunvex transaction. Both give the same answers for
which stages have `count` and which tables `db.query` / `db.system.query` refuse, and Convex sends `{ table }` only.

Sabotage checks, each caught:

- S1, `countAt` ignores later commits: 2 tests fail (snapshot, retention);
- S2, own deletes not counted: 1 fails (own writes);
- S3, the read interval made empty: 3 fail (invalidation, server, sync re-run);
- S4, the bootstrapping error made catchable: 1 fails (server, uncatchable);
- S5, the system count without system access: 1 fails (virtual tables);
- S6, every change dropped at once: 2 fail (snapshot, retention);
- S7, `count` on every stage: 2 fail (stages, oracle);
- S8, the bootstrapping error not a system error: 3 fail (core, server 503, sync skip);
- S9, changes never dropped: 2 fail (retention unit and engine).

Measurement (`TableSummaries.apply`, 200 000 one-insert commits; darwin arm64, three runs each):

- before: 167–292 ns per commit; after: 153–338 ns. The ranges overlap, so the difference is within noise;
- `countAt` at the latest snapshot: about 10 ns; 10 commits back: 50–170 ns.

The deltas are about 40 bytes per count-changing commit and table, kept no longer than the write log's entries,
which are larger.

## 6. Open questions

- C3 (DV-360): should `db.system.query(name).count()` count any system table, as Convex? Recommendation: no.
  Keep the public virtual tables only. The others are bunvex's internals, and Convex keeps `count` internal.
- C4 (DV-361): is the write log's retention an acceptable bound for an old snapshot's count? Recommendation:
  yes, as built.

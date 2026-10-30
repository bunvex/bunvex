# STUDY-195 — Two timing gaps: purging a deleted table, and a push's search and vector indexes
<!-- index: a deleted table's `_tables` row and number kept through document retention; a push's search and vector `_index` rows written and built before it finishes | decided (owner, 2026-10-27): purge once the window passes (DV-580); built: (b) #914, (a) #940 -->

- **Status:** decided (owner, 2026-10-27): Q1 as recommended (DV-580). Docs only; (b) is built (#914), (a) is built (#940).
- **Convex source read:** get-convex/convex-backend at `precompiled-2026-10-26-04d2f3b`, the oracle's release
  (STUDY-193).
- **bunvex code read:** `main` at `e84b3b1a` (after #886).
- **Checked against the binary:** both gaps, with a throwaway differential probe on
  `precompiled-2026-10-26-04d2f3b` and on bunvex (§1.2, §2.2). The probe is not committed. Each fix's PR adds its
  own oracle case.
- **Related:** [STUDY-42](STUDY-42-import-export.md) (`_tables` states and the deletion worker),
  [STUDY-04](STUDY-04-table-and-index-metadata.md) (`_tables`, `_index`), [STUDY-01](STUDY-01-document-ids.md)
  (table numbers in ids), [STUDY-35](STUDY-35-push-and-deploy.md) and [STUDY-29](STUDY-29-index-backfill.md) (the schema push and index backfill),
  [STUDY-45](STUDY-45-text-search.md) and [STUDY-111](STUDY-111-search-segments.md) (search and vector index states and workers).

Other agents found both gaps on the way and reported them. This study checks each in Convex's source, shows what
an app can observe, and gives the fix.

## 1. A deleted table: `_tables`, `_index` and its documents

### 1.1 How Convex does it

Deleting a table (`delete_tables`, `delete_active_table`, `replace_with_empty_table`, an import's replace) runs
`TableModel::delete_table_by_id_bypassing_schema_enforcement` (`crates/database/src/bootstrap_model/table.rs`)
in the deletion's transaction. That function:

- drops every `_index` document on the tablet, at once (`all_indexes_on_table`, then `delete`);
- replaces the `_tables` document with `state: Deleting`, keeping its name, number and namespace;
- leaves the documents where they are. The tablet is no longer in the table mapping, so they are invisible.

After that, the purge waits for the document retention window (`crates/database/src/retention.rs`):

- At the start of the leader's retention workers, `tablets_to_delete` lists every `Deleting` tablet with the
  timestamp of its `_tables` revision, which is the moment it was deleted.
- `go_delete_table_documents` waits on `min_document_snapshot_ts`. `delete_documents_in_tablets` skips a tablet
  whose deletion ts is not yet below it ("we must skip deleted tablets that are still within the retention
  period"). The window is `DOCUMENT_RETENTION_DELAY`, 14 days by default (`crates/common/src/knobs.rs`).
- Past the window, `Persistence::delete_tablet_documents` removes the tablet's rows from the document log in
  chunks (`DELETE_TABLET_CHUNK_SIZE`, rate-limited). No new revisions are written. When a chunk comes back empty,
  the tablet id goes down the `deleted_tablet` channel.
- `SystemTableCleanupWorker::cleanup_deleted_tablets` (`crates/application/src/system_table_cleanup/mod.rs`)
  receives it, and `hard_delete_tablet_document` deletes the `_tables` document. That function refuses unless
  the state is `Deleting`; its doc says "Only call this once document retention has emptied the tablet".
- `tablets_to_delete` is read once, when the workers start. A table deleted while the backend runs is therefore
  purged only after a restart that comes after its window has passed. Convex's own comment calls this an
  approximation: "in theory, we should rerun our query … The worst that happens … is that we retain deleted
  tablets a little bit longer than necessary".

While the `_tables` document exists, its number stays taken. `next_table_number` skips every number in
`_tables`, `Deleting` rows included (`table.rs`). A new table cannot get a deleted one's number for at least 14 days.

### 1.2 What an app can observe

**The table number.** An id carries its table's number (STUDY-01). On Convex, an id of a deleted table never
becomes an id of another table. On bunvex, the number is free again within seconds, and the next new table takes
it.

The probe ran on both backends:

1. Insert into `ta`, insert into `tb`.
2. `POST /api/delete_tables {tableNames: ["ta"]}`.
3. Wait 3 s, then insert into a new table `tc`.
4. `db.normalizeId("tc", <the old ta id>)`.

| | Convex | bunvex |
|---|---|---|
| `tc`'s number | a new one | `ta`'s (the ids share the prefix `j97…`) |
| `normalizeId("tc", oldTaId)` | `null` | the old id, now valid for `tc` |

So on bunvex, an app that kept an id of a deleted table can `db.get` it or `normalizeId` it into an unrelated
new table. The ids of the new table's documents differ, so a `get` of the old id still finds nothing. But the id
validates as `v.id("tc")` and normalizes. The table numbers in ids, exports and `_tables` also differ from
Convex's.

The rest is not an app's to see. bunvex keeps the `_index` rows until the table is empty, while Convex drops them
at once; no function reads `_index`, and the dashboard filters by table. A Convex-written store is not at risk:
bunvex reads a `Deleting` tablet as deleting and purges it.

### 1.3 How bunvex does it

`Engine.activateTables` (and through it `deleteTables`, `replaceWithEmptyTables`, imports) patches the `_tables`
row to `deleting` (`packages/core/src/engine.ts`, ~3442). The `_index` rows stay.

`startTableDeletion` then runs at once. Batch by batch, it deletes the table's documents with ordinary deletes
(`TABLE_DELETION_BATCH` = 1000), which writes a tombstone revision for each. Retention removes that history later.
When the table is empty, it deletes the tablet's `_index` rows and its `_tables` row, in the same transaction
(~3597). The number is free from then on. Parity: `platform.md` "Purging deleted tables" says the purge is done
and notes only that Convex purges the documents directly.

### 1.4 The fix to match

1. **At deletion**, delete the tablet's `_index` rows in the deletion's transaction, as Convex does. This means
   `activateTables`, `dropHiddenTables` and the component deletion path (~1005). Index entries of a deleting
   table are already unreachable.
2. **Keep the `_tables` row `deleting`, with its number, and the documents**, until document retention passes the
   deletion: `engine.retention.minDocumentTs` above the ts of the row's `deleting` revision. The catalog already
   keeps deleting tablets out of the table mapping. bunvex's number allocation counts every `_tables` row of the namespace, `deleting` ones included (`planCatalog`, `core/src/catalog.ts`), so
   the number stays taken as long as the row is there.
3. **Past the window, purge without new revisions.** Add a persistence operation like Convex's
   `delete_tablet_documents(tablet, limit)` that removes a tablet's rows (documents and their index entries) in
   chunks. It goes in the persistence contract, with a PERSIST-01 conformance case for each driver: SQLite,
   Postgres, MySQL, MongoDB, memory. The worker then deletes the `_tables` row (Convex's
   `hard_delete_tablet_document`, `deleting` checked). The worker should be rate-limited, as Convex's is.
4. **Tests.**
   - A server test: delete `ta`, create `tc`, and `tc` has a new number while the window lasts. With the window
     moved past the deletion (the retention object, as `data-sync.test.ts` does), the purge runs and the row goes.
   - An oracle case: the probe above, as a test.
   - A conformance case for the new persistence operation.

Cost: the store keeps a deleted table's documents for the window, as Convex's does (14 days by default).
`TABLE_DELETION_BATCH` and the tombstones go away.

What Q1 decides: Convex finds `Deleting` tablets only when its retention workers start (§1.1).

## 2. A push's search and vector indexes

### 2.1 How Convex does it

A push (deploy2 `start_push`) runs `IndexModel::prepare_new_and_mutated_indexes`
(`crates/database/src/bootstrap_model/index.rs`) in the push's transaction, over every index the new schema
declares: database, search and vector alike. `add_application_index` writes each added one's `_index` document as
`Backfilling`.

The search and vector index workers (`crates/search_index_workers`) build them while the push waits.
`wait_for_schema` (`crates/application/src/deploy_config.rs`, `crates/local_backend/src/deploy_config2.rs`) reports
in progress until no index of the push is backfilling. That check is `!metadata.config.is_backfilling()`
(`index.rs`), and it covers text and vector configs. `finish_push` then runs `commit_indexes_for_schema`, which
enables them: `SnapshottedAt`.

When `npx convex deploy` returns, every search and vector index the schema declares is built and queryable.

### 2.2 What an app can observe

A search or vector query right after a deploy that added the index. The probe ran on both backends: 3000
documents in `docs`, then a deploy adding `searchIndex("s", { searchField: "body" })`, then at once a query
`withSearchIndex("s", …)`.

| | Convex | bunvex |
|---|---|---|
| the deploy | 592 ms (it waited for the build) | 156 ms |
| the query right after | 1000 results | `IndexBackfillingError: Index docs.s is currently backfilling and not available to query yet.` |

So on bunvex, an app (or a test, or a CI step) that deploys a new search or vector index and uses it at once gets
an error until the build finishes. On Convex it never does. The `_index` row coming a moment after the push is a
symptom: the index is not built before the push finishes, and its row is written after it.

### 2.3 How bunvex does it

`startSchemaPush` writes the push's database indexes as backfilling, in its transaction (`engine.ts` ~3070).
`schemaPushStatus` stays `inProgress` while one of them is backfilling (~3188). Search and vector indexes are left
out of the push:

- They follow the active schema only. `reconcileSearch` / `reconcileVector` (~1315, ~1334) read
  `declaredActiveTables`, and `commitSchemaPush`'s `onCommitVisible` calls them once the new schema is active
  (~3306).
- Only then is a new index registered and its backfill started.
- `syncIndexRows`, scheduled on a microtask (`scheduleIndexRowsSync`, ~2110), writes its `_index` row in a later
  transaction.

The push therefore finishes before the index exists anywhere, and queries see it backfilling.

### 2.4 The fix to match

1. **In `startSchemaPush`'s transaction**, write each added search and vector index's `_index` row as
   `Backfilling` (Convex's `onDiskState` `Backfilling { cursor, segments, staged }`, already bunvex's format,
   STUDY-111), alongside the database ones. A mutated one is dropped and re-added, as Convex's
   `prepare_new_and_mutated_indexes` does.
2. **Build them from the pending schema**: register the pending push's search and vector indexes with
   `searchIndexes` / `vectorIndexes` as not ready, and start their backfill from the row. A superseded or
   canceled push drops them, as it drops its database indexes.
3. **`schemaPushStatus`** stays `inProgress` while one of them is backfilling, as for database indexes. `deploy`
   then waits, as Convex's CLI does.
4. **`commitSchemaPush`** enables them in the commit (`SnapshottedAt`, Convex's `commit_indexes_for_schema`).
   `reconcileSearch` / `reconcileVector` then find them built, and `syncIndexRows` has no row left to add.
5. **Tests.**
   - A server test: after `deploy` resolves, a search and a vector query on a new index return their results.
     The `_index` row exists, `Backfilling`, in the push's own commit (read at the push's ts).
   - An oracle case: the probe above, a search and a vector index, as a test.

No owner question: this matches Convex, and the backfill machinery it needs exists.

## 3. Owner questions

Decided (owner, 2026-10-27): as recommended.

| # | Question | Recommendation (decided) |
|---|---|---|
| Q1 | Convex reads the list of `Deleting` tablets once, when its retention workers start (§1.1). A table deleted while the backend runs keeps its `_tables` row and number until a restart that comes after its 14-day window. Copy that, or purge as soon as the window has passed, whether or not the server restarted? | **Purge once the window has passed**, recorded as a DV. What an app observes is identical for the 14 days. After that, only how long a number stays reserved differs, and Convex's own comment calls its version an approximation ("retain deleted tablets a little bit longer than necessary"). Tying the purge to restarts would make bunvex's storage depend on how often it is restarted. |

## 4. Divergences

DV-580 (owner, 2026-10-27, Q1): a deleted table is purged once its retention window has passed, while the server runs; Convex purges it at the first retention-worker start after the window.

## 5. Tests

None in this study: it is docs only. The probe (§1.2, §2.2) ran on `precompiled-2026-10-26-04d2f3b` and on bunvex
`main`. Each fix's PR turns it into an oracle case, with the server tests in §1.4 and §2.4 and a sabotage check.

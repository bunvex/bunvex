# STUDY-128 — `_next_persistence_index_id`, the index id allocator

- **Status:** implemented
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-04](STUDY-04-table-and-index-metadata.md) (catalog), [STUDY-29](STUDY-29-index-backfill.md)
  (index lifecycle), [STUDY-42](STUDY-42-import-export.md) (hidden tables)

## 1. How Convex does it

Since migration 130, persistence stores index entries under a small integer per index, the
`PersistenceIndexId` (`crates/common/src/types/index.rs:365`, a `NonZeroU32`; `FIRST` is 1), kept in the index's
`_index` document (`IndexConfig::Database { persistence_index_id, .. }`).

The ids come from one counter, the system table `_next_persistence_index_id`
(`crates/database/src/bootstrap_model/next_persistence_index_id/`). Its number is
`DefaultTableNumber::NextPersistenceIndexId = 42`, so 554, a bootstrap table
(`DEFAULT_BOOTSTRAP_TABLE_NUMBERS`), global, loaded in memory, no index but the defaults. One document,
`{nextId: int64}` (`types.rs`, camelCase).

- **Bootstrap.** `Database::initialize` (`database.rs:1460-1610`) numbers the bootstrap tables' indexes from 1
  as it creates them, then writes the counter with the next value. `initialize_application_system_tables`
  skips the table (it already exists).
- **Allocation.** At commit, `Transaction::assign_missing_persistence_index_ids` (`transaction.rs:277-321`,
  called by `committer.rs:1530`) finds every `_index` document the transaction inserted without an id, takes
  that many ids with `NextPersistenceIndexIdModel::allocate(count)` (reads the document, checks the addition does
  not overflow — "exhausted persistence index IDs" — and replaces it with `nextId + count`), and writes each id
  into its index document. The allocation is part of the same commit, so two transactions creating indexes
  conflict on the counter.
- **Never reused.** Nothing ever lowers `nextId`. Dropping an index deletes its `_index` document only; its id is
  not given back.

## 2. What an app can observe

Nothing directly: the ids are internal. Indirectly, reuse would be visible: an index created with the id of a
dropped one could read the dropped index's leftover entries in persistence (until retention removes them).

## 3. How bunvex does it

bunvex's `IndexMeta.indexId` is the same thing: the number persistence keys index entries by. Before, each
transaction that created indexes (`planCatalog`, for the engine's start, a push, a write to a new table and an
import's hidden table) gave them `max(indexId of the _index documents) + 1`. Dropping the index with the
highest id therefore gave its id to the next index created.

Now (`@bunvex/core` `catalog.ts`, `engine.ts`, `tx.ts`):

- `_next_persistence_index_id`, number 554, holds Convex's `{nextId}` (an int64).
- `readCatalog` reads it with `_tables` and `_index`; `planCatalog` numbers new indexes from it and returns
  the counter's next value; every caller writes it back in the same transaction (`writeNextIndexId`), so the
  allocation commits with the indexes, and concurrent allocations conflict on it, as Convex's.
- The store's first start creates the table and, since a transaction cannot insert into a table it creates,
  writes the counter in the next transaction with the next free id (Convex writes it in its bootstrap). Until
  then (that one first catalog commit) `planCatalog` falls back to max + 1, which is the same value.
- At every start the engine now reads the stored catalog before reconciling it, so that transaction sees the
  system tables (the counter); it used to run on the bootstrap catalog (`_tables` and `_index` only).
- Dropped indexes never lower it: ids are not reused.

bunvex numbers `_tables` and `_index`'s own four indexes 1–4 (fixed, as before) and the others from 5.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| N1 (DV-405) | Was: index ids were `max + 1`, so a dropped index's id could be reused. Now as Convex: a counter in `_next_persistence_index_id` (554), never lowered | match Convex's internal system tables; no legacy data | owner, 2026-10-05: match Convex |
| N2 | The counter is written by the first start's second transaction, not by the bootstrap itself | bunvex creates its system tables in an ordinary transaction, which cannot write a table it creates | not observable; noted |

Tablets (bunvex's persistence table ids) are still `max + 1` (Convex's are random UUIDs). A deleted table's
tablet is removed only after the deletion worker emptied it; whether to stop reusing its number too is a question
for the owner (not in this PR's scope).

## 5. Tests

`packages/core/test/index-ids.test.ts` (and the numbers in `catalog.test.ts`):

- a fresh store has the counter, number 554, `nextId` one above the highest id given;
- an index dropped by a schema change does not give its id back: the next index gets a new one, and the counter
  only grows;
- a write that creates a table, and an import's hidden table, take their ids from the counter too.

Sabotage (each applied alone, then restored):

| Change | Result |
|---|---|
| `planCatalog` ignores the counter (max + 1) | 1 test fails (a dropped id is given again) |
| the counter is never raised | 2 fail |
| a write's new table does not advance the counter | 1 fails |
| the start reconciles on the bootstrap catalog (counter unseen) | 1 fails |
| the table numbered 9997 | 2 fail |

## 6. Open questions

Tablet numbers (above).

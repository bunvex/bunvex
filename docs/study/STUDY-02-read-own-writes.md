# STUDY-02 — Read-your-own-writes inside a transaction

- **Status:** implemented (#3). Written retroactively, after the code.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend

## 1. How Convex does it

`crates/database/src/transaction_index.rs`:

- The transaction keeps, per index, an ordered map of its pending updates (`TransactionIndexMap`,
  key → `Option<document>`).
- A range read (`range_no_deps`) merges the snapshot's results with the pending entries of the same range,
  in key order, ascending or descending:
  - on an equal key the pending entry wins;
  - a pending `None` hides the key.
- A patch that changes an indexed field leaves a `None` at the old key and the new document at the new
  key.

## 2. What an app can observe

Inside one mutation, `db.get` and every `db.query(...)` see the mutation's own earlier inserts, patches
and deletes. The same holds for ranges, order and `take(n)`, exactly as if the writes were already
committed.

## 3. How bunvex does it

`packages/core/src/tx.ts` follows the same model:

- per index, a sorted map (`sorted-btree`, ordered by `compareKeys`) of key → doc, or `null` for a
  removal;
- a range read fetches `limit + removals` snapshot rows, merges them with the pending entries, and takes
  `limit`.

## 4. Divergences

None observable.

## 5. Tests

`packages/core/test/tx.test.ts`:

- specific cases;
- a model-based property: 720 queries inside mutations, checked against a reference view and checked
  again after commit.

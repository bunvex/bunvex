# STUDY-16 — Query chaining, `unique()`, `fullTableScan()` and async iteration

- **Status:** implemented (#NN)
- **Convex source read:** commit `4577b9031`, `npm-packages/convex/src/server/impl/query_impl.ts`
- **Related:** [STUDY-07](STUDY-07-query-semantics.md), [STUDY-15](STUDY-15-query-filter.md)

## 1. How Convex does it

- **Immutable chain:** every operator returns a new query and closes the one it was called on. Using a
  closed query fails with "This query has been chained with another operator and can't be reused.".
  Chaining after iteration has begun fails with "A query can only be chained once and can't be chained
  after iteration begins.".
- **Initializer operators:** `withIndex` and `fullTableScan` exist only on `db.query(table)`.
- **`order`** may be set at most once ("Queries may only specify order at most once").
- **Iteration:** `for await` streams the documents and may begin only once ("Iteration can only begin on a
  query once.").
- **`unique()`** returns the only document or `null`. With more than one it fails with "unique() query
  returned more than one result from table T:\n [id1, id2, ...]".

## 2. What an app can observe

The errors above; `unique()`'s result; and `for await`, which yields the same documents as `collect()`
(filters applied, the mutation's own writes included) and can stop early.

## 3. How bunvex does it

- **`Tx.query`** builds an immutable chain. Each link has its own state: index, range, order, filters,
  stage, and whether it is closed or iterated.
- **Results:** `collect`, `take`, `first` and `unique` read through the page / stream machinery of
  STUDY-15.
- **Iteration:** `[Symbol.asyncIterator]` yields from the stream.
- **Missing tables** support the whole chain and yield nothing.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | `withIndex` after another operator fails with a bunvex message; in Convex the method doesn't exist on that stage (a TypeError) | One object shape in JS | accepted |

## 5. Tests

`packages/core/test/query-chain.test.ts`:

- `unique()` with zero, one and two results;
- `for await` with filters and own writes, and with an early `break`;
- each chaining error;
- `fullTableScan()`;
- the full chain on a missing table.

Sabotage: allowing reuse fails the reuse test.

# STUDY-16 — Query chaining, `unique()`, `fullTableScan()` and async iteration

- **Status:** implemented (#40); D1 resolved to match Convex (owner, 2026-10-04)
- **Convex source read:** commit `4577b9031`, `npm-packages/convex/src/server/impl/query_impl.ts`
- **Related:** [STUDY-07](STUDY-07-query-semantics.md), [STUDY-15](STUDY-15-query-filter.md)

## 1. How Convex does it

- **Immutable chain:** every operator returns a new query and closes the one it was called on. Using a
  closed query fails with "This query has been chained with another operator and can't be reused.".
  Chaining after iteration has begun fails with "A query can only be chained once and can't be chained
  after iteration begins.".
- **Initializer operators:** `withIndex`, `withSearchIndex` and `fullTableScan` exist only on `db.query(table)`.
  At runtime `db.query(table)` is a `QueryInitializerImpl` (`impl/query_impl.ts:44`; `withIndex` l.51,
  `withSearchIndex` l.71, `fullTableScan` l.88), and every operator returns a `QueryImpl` (l.161: `order` l.210,
  `filter` l.225, `limit` l.243, the terminals), which has none of the three. So `db.query(t).filter(…).withIndex(…)`
  is the engine's own `TypeError`: in V8 "… .withIndex is not a function". The types say the same:
  `QueryInitializer` (`query.ts:29`, `withIndex` l.60, `withSearchIndex` l.89) extends `Query` (l.167), which
  has no such methods, so TypeScript reports "Property 'withIndex' does not exist on type 'Query<…>'". The
  runtime `QueryImpl` serves both the Query and OrderedQuery stages: it has `order`, and a second `order` is
  its own "Queries may only specify order at most once" (only the types hide `order` on OrderedQuery).
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
  and whether it is closed or iterated.
- **Stages, as Convex's classes** (D1): `db.query(table)` (and `db.system.query`) is a `QueryInitializerImpl`
  (`ProjectedQueryInitializer` for system tables) with `withIndex`, `withSearchIndex` and `fullTableScan`;
  every operator returns a `QueryImpl` (`ProjectedQuery`), which has none of them. A call at the wrong stage
  is JavaScriptCore's own `TypeError`: "q.filter().withIndex is not a function. (In '…', '…' is undefined)",
  V8's message plus the call site. The internal types say the same (`TxQuery` / `TxQueryChained`, `tx.ts`).
  The engine's objects print by these class names (`QueryInitializerImpl {…}`, `QueryImpl {…}`).
- **Results:** `collect`, `take`, `first` and `unique` read through the page / stream machinery of
  STUDY-15.
- **Iteration:** `[Symbol.asyncIterator]` yields from the stream.
- **Missing tables** support the whole chain and yield nothing.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | ~~`withIndex` after another operator fails with a bunvex message; in Convex the method doesn't exist on that stage (a TypeError)~~ Resolved: the stages are separate objects, as Convex's, so the call is a `TypeError` | the method is missing at that stage | resolved to match Convex (owner, 2026-10-04): DV-06 |

## 5. Tests

`packages/core/test/query-chain.test.ts`:

- `unique()` with zero, one and two results;
- `for await` with filters and own writes, and with an early `break`;
- each chaining error;
- `fullTableScan()`;
- the full chain on a missing table.

Sabotage: allowing reuse fails the reuse test.

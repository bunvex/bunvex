# STUDY-07 — Query semantics: withIndex, order, take/first/unique/collect, filter, paginate

- **Status:** draft (retroactive). The code in §3 was written before the study-first rule.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **bunvex code read:** `main` at `f60e934`
- **Related:**
  - [STUDY-05](STUDY-05-index-keys-and-ordering.md): key order and range compilation.
  - [STUDY-06](STUDY-06-transactions-and-occ.md): read-set footprint and limits.
  - [STUDY-09](STUDY-09-persistence-layout.md): the drivers' scan bugs, which surface here as wrong
    query results.

## 1. How Convex does it

### 1.1 The JS query builder

`npm-packages/convex/src/server/impl/query_impl.ts`:

- `db.query(t)` without `withIndex` is a `FullTableScan`. The server maps it to `by_creation_time`
  (`crates/database/src/query/mod.rs`).
- `order(dir)` may be set **once**. A second call throws "Queries may only specify order at most
  once". A search query cannot be ordered.
- **A query is linear.** Chaining it twice throws "A query can only be chained once and can't be
  chained after iteration begins." It can be iterated only once.
- `filter(pred)` pushes a filter operator, at most 256 operators (`MAX_QUERY_OPERATORS`). The filter
  runs **after** the index scan. Every scanned document counts toward the read limits and the
  read-set.
- `take(n)`:
  - `validateArgIsNonNegativeInteger`, so `n` must be an integer ≥ 0;
  - then a `limit(n)` operator and `collect()`;
  - `take(0)` returns `[]`.
- `first()` is `take(1)[0] ?? null`.
- `unique()` is `take(2)`. With two results it throws:

  > unique() query returned more than one result from table T: [id1, id2, ...]

- `collect()` streams **everything**. There is no cap except the transaction read limits: 32 000
  documents or 16 MiB, raising `TooManyDocumentsRead` / `TooManyBytesRead` (STUDY-06).
- **Async iteration** (`for await (const doc of q)`) streams documents one at a time
  (`1.0/queryStreamNext`), and the read-set grows as it goes.
- `paginate({numItems, cursor, endCursor?, maximumRowsRead?, maximumBytesRead?})`:
  - calls `1.0/queryPage`;
  - returns `{page, isDone, continueCursor, splitCursor, pageStatus}`;
  - `numItems` must be ≥ 0.
  - The cursor is an opaque serialized index position. Pages are made reactive by the `endCursor`
    and the query journal, and the page boundaries stay stable on re-execution
    (`crates/database/src/query/index_range.rs`, `CursorInterval`).

### 1.2 The index range builder

`npm-packages/convex/src/server/impl/index_range_builder_impl.ts` builds `eq`…, then at most one
lower and one upper bound. It is single-use ("IndexRangeBuilder has already been used!").

The server's `IndexRange::compile` (`crates/common/src/query.rs`) validates the range against the
index fields, including the implicit `_creationTime` and `_id` (STUDY-05):

| Rule | Error |
|---|---|
| A field outside the index | `FieldNotInIndex` |
| Fields not an index-order prefix | `InvalidIndexRange` |
| A second `eq` on a field, or a second bound of the same kind | `AlreadyDefinedBound` |
| Bounds on two different fields | `BoundsOnMultipleFields` |
| `eq` and a range on the same field | `AlreadyDefinedBound` |

Values may be `undefined` (a `MaybeValue`), to match missing fields.

### 1.3 Missing tables and indexes

- A query on a **table that does not exist** yields no rows. The "missing index" branch of
  `IndexRange::start_next` returns `Ready(None)`.
- `db.get` of an id whose table does not exist returns `null` (`UserFacingModel::get_with_ts`).
- Writing to a new table creates it (`TableModel::insert_table_metadata`).

## 2. What an app can observe

1. A range expression that does not match the index fails with an error. It never silently returns
   other rows.
2. `take(n)` is exact and validated. `collect()` returns everything, or fails loudly at the read
   limits.
3. `unique()`, `filter()`, `paginate()`, async iteration and `order()` exist, with the errors above.
4. The default order is `_creationTime` ascending.
5. A table that has never been written to reads as empty.

## 3. How bunvex does it today

`packages/core/src/tx.ts`, `Tx.query`:

- The default index is `by_creation_time`, as in Convex.
- `withIndex(name, f)` replaces the index and range. It may be called again, after `order`, and so
  on.
- `order(dir)` can be called any number of times; the last call wins.
- `take(n)` calls `run(n)` with **no validation of `n`**.
  - **Memory driver:** `scan` pushes a row and then checks `out.length >= limit`, so **`take(0)`
    returns 1 document**. A negative `n` does the same.
  - **SQLite:** `take(0)` returns 0.
- `first()` is `run(1)[0] ?? null`.
- `collect()` is `run(8192)`: **silently capped at 8 192 documents**.
- There is no `unique`, `filter`, `paginate`, async iteration or `limit`.
- `IndexRangeBuilder` ignores the field names (STUDY-05 D5). It is not single-use.
- An unknown table throws `unknown table T` for reads and writes alike (`tableDef`). An unknown index
  throws `unknown index T.name`.

The drivers' scan bugs ([STUDY-09](STUDY-09-persistence-layout.md) D1–D2) show up here as short
results. On SQLite, after one document was patched 10 times, `take(2)` returned **1** row. After the 9
oldest of 10 documents were deleted, `first()` returned **null** (probe, `SqlitePersistence`).

## 4. Divergences

| # | Divergence | Class | Why / impact | Decision |
|---|---|---|---|---|
| D1 | `collect()` is silently capped at 8 192 rows (`tx.ts` `collect: () => run(8192)`) | BUG | Silent truncation. Convex returns all rows, or fails with `TooManyDocumentsRead` at 32 000 | owner |
| D2 | `take(n)` is not validated; `take(0)`/negative returns 1 row on the memory driver, 0 on SQLite (`memory.ts` `scan` checks the limit after pushing) | BUG | Wrong result, and it differs across drivers | owner |
| D3 | `withIndex` range fields are not validated (STUDY-05 D5) | BUG | Wrong rows instead of `FieldNotInIndex` / `InvalidIndexRange` / `AlreadyDefinedBound` / `BoundsOnMultipleFields` | owner |
| D4 | Driver scans can return fewer rows than exist (STUDY-09 D1/D2), so `first()` can be `null` and `take(n)` short | BUG | Wrong query results on SQLite, Postgres, MySQL and MongoDB once documents are deleted or patched | owner |
| D5 | Missing: `filter`, `unique`, `paginate`, async iteration, `limit` | OBSERVABLE | ARCHITECTURE lists filter/paginate as M. Apps using them do not run | owner |
| D6 | `order()` can be called repeatedly, `withIndex` after `order`, and a query reused; Convex throws | OBSERVABLE | Code that is invalid on Convex runs on bunvex | owner |
| D7 | A query or `get` on an undeclared table throws, and so does an insert; Convex reads it as empty and creates the table on insert, even with a schema (`DatabaseSchema::check_value` skips tables not in the schema, `crates/common/src/schemas/mod.rs`) | OBSERVABLE | A schema-less or partially declared app fails on bunvex | owner |
| D8 | `db.get(table, id)` with an id from another table returns `null` without a check | OBSERVABLE | Depends on the STUDY-01 id format; with table-tagged ids, a mismatch can be detected as in Convex | owner |

## 5. Tests

- **Model-based:** the tx.test.ts reference model extended with deletes and repeated patches, run on
  **every** driver with small limits (`take(1)`, `take(2)`, `first()`), not only on memory.
- **`take` edge cases:** `take(0)`, `take(-1)` and `take(1.5)` match Convex (`[]`, error, error).
- **Large collect:** `collect()` over 10 000 documents returns 10 000. Over 32 001 documents it fails
  with `TooManyDocumentsRead`.
- **Errors:** every range-builder and chaining error case from §1.1 and §1.2.
- **Cross-check:** run the convex-bench query set on both systems and compare the result lists.

## 6. Open questions

1. Pagination cursors: an opaque encoding of the last index key (as Convex), and does bunvex need the
   query journal and `endCursor` for reactive pages from day one?
2. Should `filter` push predicates into the driver scan (bunvex's advantage), keeping Convex's
   read-limit accounting exactly (every scanned document counts)?

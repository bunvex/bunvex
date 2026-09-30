# STUDY-15 — `.filter()` and the filter builder

- **Status:** implemented (#37)
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend
- **Related:** [STUDY-07](STUDY-07-query-semantics.md), [STUDY-18](STUDY-18-value-model.md)

## 1. How Convex does it

- **The builder** (`npm-packages/convex/src/server/filter_builder.ts`) has these operations:
  - `field(path)`;
  - comparisons: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`;
  - arithmetic: `add`, `sub`, `mul`, `div`, `mod`, `neg`;
  - boolean: `and`, `or`, `not`.

  Literal values may stand in for expressions. Each `.filter(p)` call adds an operator, and the filters
  combine with AND.
- **Evaluation** (`Expression::eval`, `crates/common/src/query.rs`, applied in
  `crates/database/src/query/filter.rs`):
  - A field is the document's value at a dotted path. A missing field is `undefined` (`MaybeValue`), which
    sorts below `null`.
  - Comparisons use the same total order as index keys, so types compare in their cross-type order.
  - Arithmetic works only on two int64s or two float64s. Anything else fails with `EvalError`: `Cannot add
    1 (type int64) and 1.0 (type float64)`, `Cannot divide 10 by zero`, `… out of range for Int64`, and
    `Cannot negate …`.
  - `and`, `or` and `not` need booleans (`Cannot use value 5.0 (type float64) as a Boolean`), and so does
    the predicate's result.
- **Filtering happens as documents are read**, after the index range and before `take`/`first`/`collect`.
  So `take(n)` keeps reading until `n` documents pass, and every document read counts toward the read
  limits.

## 2. What an app can observe

The operations in §1, their results and their error messages. `take(n)` returns up to `n` documents that
match, wherever they are in the range.

## 3. How bunvex does it

- **`packages/core/src/filter.ts`** builds expressions as evaluators, with Convex's semantics and messages.
- **`Tx.query`:**
  - without filters, it keeps the one-page fast path;
  - with filters, it **streams** the range in growing pages, continuing past the last key seen and merging
    the transaction's own writes, until enough documents pass.

  The stream is also the base for async iteration and `paginate`.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| D1 | The limit on the number of query operators (`MAX_QUERY_OPERATORS`) is not enforced | Filters are closures here, not a serialized expression list; follow-up | gap |

## 5. Tests

`packages/core/test/filter.test.ts`:

- comparisons, including missing vs `null` and cross-type order;
- the boolean operators;
- arithmetic and each error;
- `take(n)` past the first pages, ascending and descending;
- chained filters;
- a property: 40 random filtered queries inside a mutation that writes between them, checked against a
  model.

Sabotage: stopping the stream after one page fails 2 tests.

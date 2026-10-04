# STUDY-52 — Table shape inference

- **Status:** A1–A3 accepted as recommended (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03
- **Related:** [STUDY-12](STUDY-12-dashboard.md) (the dashboard's schema views), [STUDY-35](STUDY-35-push.md)

## 1. How Convex does it

### 1.1 The lattice (`crates/shape_inference`)

- A **counted shape** is a variant and the number of values it describes.
- **Variants**:
  - `Never`, `Null`, `Int64`;
  - the floats: `NegativeInf`, `PositiveInf`, `NegativeZero`, `NaN`, `NormalFloat64`, and `Float64` (all of them);
  - `Boolean`;
  - the strings: `StringLiteral` (an identifier), `Id(table)`, `FieldName`, `String`;
  - `Bytes`;
  - `Array(element)`;
  - `Object(fields, each optional or not)`;
  - `Record(key, value)`;
  - `Union`;
  - `Unknown`.
- **`shape_of`**:
  - A string is a literal if it is an identifier, else an id if it decodes as one, else a field name, else a string.
  - An object with at most 64 identifier keys is an `Object`; any other is a `Record`.
- **Unions** have 2 to 16 variants, pairwise disjoint (`may_overlap`), ordered by variant.
- **Adding a value** merges it into a variant that contains it. Otherwise it absorbs the variants it contains, and what still overlaps is contracted. A union over 16 variants is contracted too.
- **Contraction order** (`supertype_candidates`):
  1. arrays into one;
  2. records (and objects, if a record exists);
  3. literals and ids of one table into `Id`;
  4. field names;
  5. strings;
  6. floats into `Float64`;
  7. objects into one, a field missing in any of them becoming optional (up to 64 fields);
  8. objects into a record;
  9. `Unknown`.
- **Deleting a value** decrements the counts but never narrows a widened variant (`remove`).

### 1.2 Storage and freshness (`crates/database/src/table_summary.rs`)

- Shapes live in `TableSummary`, a persistence global, not a table.
- They are not updated per commit. `TableSummaryWorker` checkpoints them:
  - every 500 commits;
  - or 10 minutes after writes;
  - or every 4 hours ± 15 minutes.
- Until the first checkpoint a table is `Unknown`.
- Callers that need exact shapes replay the log to the timestamp they need: schema validation, deploy predictions, `/api/json_schemas`.

### 1.3 Exposure

- **`GET /api/shapes2?component=`** (`local_backend/src/dashboard.rs`, ViewData) returns each user table's reduced shape `{type: …}`.
  - The string kinds become `String`; an id of a known table becomes `{type: "Id", tableName}`.
  - The floats become one `Float64` with `float64Range.hasSpecialValues`.
  - The objects of a union are merged into one, with a field missing in any of them optional.
  - Records become `{keyShape, valueShape: {optional, shape}}`.
- **Consumers**:
  - the dashboard's schema views and "Generate schema" (`dashboard-common/src/lib/format.ts`);
  - the MCP `tables` tool;
  - streaming export's `/api/json_schemas`.
- Functions cannot see shapes.

## 2. What an app can observe

Nothing from functions. Operators see `/api/shapes2` and the dashboard's generated schema.

## 3. How bunvex does it

- **PR 1 (this one, draft)**:
  - `@bunvex/core` `shapes.ts` implements the lattice above (counts, disjoint unions of at most 16, the contraction order, the 64-field limit) and the dashboard's reduced form.
  - `GET /api/shapes2` computes each user table's shape from its documents at one snapshot, page by page, when asked.
- **Later**:
  - shapes kept per commit, so `/api/shapes2` stops scanning;
  - removal (counts down, no narrowing);
  - `/api/json_schemas` with streaming export;
  - the schema-validation shortcut.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| A1 | Shapes are exact and current: computed at one snapshot when asked (PR 1), then kept per commit (PR 2), never `Unknown` while warming up | Convex's checkpoints save work in a large multi-tenant backend; bunvex has one deployment in memory. **Possible to match**; recommended not to: the dashboard shows the truth | DV-265, accepted (owner, 2026-10-03) |
| A2 | After deletes, PR 1's shapes narrow back (they are recomputed); Convex's widened variants stay widened until their count is 0 | A consequence of A1 in PR 1. PR 2 keeps Convex's no-narrowing rule | DV-266, accepted (owner, 2026-10-03); resolved by PR 2 |
| A3 | The table summaries (counts, sizes, shapes) are rebuilt on start from the documents, not loaded from a checkpoint | Convex checkpoints them into a persistence global and replays the log. **Not done yet**: a rebuild reads every document once at start, in the background; until it is done they are unavailable (`TableSummariesUnavailable`, as Convex's while it bootstraps) | DV-300, accepted (owner, 2026-10-03); built in [STUDY-72](STUDY-72-table-summary-checkpoints.md) |

**As built (PR 2).** `@bunvex/core` `table-summaries.ts`:

- **Per table**: the count, the total size (`valueSize`) and the counted shape.
- **Counts and sizes** move with each commit as it becomes visible.
- **Shapes** fold in each commit's documents when asked, or in the background past 1000 changes. Each old version is removed (`removeValue`: counts down, a variant gone at 0, an optional field present everywhere required again, nothing widened narrowed back), and each new one is added.
- **Built on start** at one snapshot; the commits meanwhile are applied once, after.
- **`/api/shapes2`** reads the summaries: tables are `Unknown` until they are built.
- **`_system/cli/tableSize`, `_system/frontend/tableSize` and `tableSize:sizeOfAllTables`** use `Tx.countTable`, Convex's internal `count()`: the summary's count plus the transaction's own writes, reactive over the whole table.
- **Strings**: an id is an `Id` shape at once. Convex makes it a literal first and promotes it when contracting; the dashboard's form is the same.

Ids now validate without re-encoding (a decode went from 1.7 µs to 0.39 µs), which the summaries and every id check use.

Measured (in-memory engine, 20 000 inserts of a 6-field document): an insert went from 22–23 µs to 28 µs. That is about 1 µs for the counts and sizes, and the rest for folding the shapes.

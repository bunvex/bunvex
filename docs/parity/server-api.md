## Parity inventory: server-side function and database API

Scope: everything an app can call or rely on from inside its functions: `ctx.db`, the query builder, function builders and contexts, validators and value types, schema, auth/storage/scheduler/crons/HTTP, components, errors, and the documented limits.

- **Convex reference:** `convex-backend` @ `4577b9031`, brought up to the release `precompiled-2026-10-10-72ce13c` by [STUDY-173](../study/STUDY-173-convex-reference-2026-10-10.md). JS paths are relative to `npm-packages/convex/src/` and Rust paths to `crates/`.
- **bunvex reference:** first written against `main` @ `f60e934`; every row not done was rechecked against the code at `main` @ `52141c8` (2026-10-03, after #245).
- **Status:** **done** means it matches Convex's behaviour; **partial** means it exists but differs (the note says how); **missing** means it isn't there.

Key bunvex facts behind the statuses:

- `@bunvex/values` has Convex's validators and value model (int64, bytes, the `$integer` / `$bytes` / `$float` encoding, Convex's sort keys).
- Ids are Convex's v6 format.
- Functions are pushed as modules and analyzed by file (STUDY-35), with typed builders and codegen (STUDY-36).
- Queries and mutations carry `runQuery` (and mutations `runMutation`) in their transaction since STUDY-41.

---

### 1. Database reader: `ctx.db` in queries and mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.get(table, id)`, the table-scoped form | server/database.ts, impl/database_impl.ts | done (#7) | Checks the id belongs to the table, with Convex's errors. |
| `db.get(id)`, the legacy form where the id carries its table | server/database.ts | done (#44) | The id names its table. |
| `db.get` returns `null` for a missing or deleted doc | impl/database_impl.ts | done | |
| `db.get` sees the transaction's own writes | crates/database/src/transaction.rs | done | Served from the write set. |
| `db.query(table)` returns a QueryInitializer | server/query.ts | done (#40) | An immutable chain, as Convex's (STUDY-16): each operator returns a new query; `withIndex` / `withSearchIndex` / `fullTableScan` only on the initializer: after another operator they don't exist, a `TypeError` as in Convex (DV-06, resolved). |
| `db.normalizeId(table, idString)` | impl/database_impl.ts (`1.0/db/normalizeId`) | done (#44) | Legacy v4/v5 id formats are not accepted (no legacy data). |
| `db.system.get` / `db.system.query` / `db.system.normalizeId` for system tables (read-only) | impl/database_impl.ts | done (STUDY-30, STUDY-32, STUDY-125) | `_scheduled_functions` and `_storage`, virtual tables over Convex's `_scheduled_jobs` / `_scheduled_job_args` and `_file_storage`, with `by_id` / `by_creation_time`; filters see the virtual fields; Convex's guards (a user id in `db.system.get`, a system id in `db.get`). |
| User vs system table separation: `_`-prefixed tables only via `db.system`, and system tables are read-only | impl/database_impl.ts | done (STUDY-30, STUDY-151) | `ctx.db` refuses `_`-prefixed tables and `db.system` reads the public ones, with Convex's message for each operation ("System tables (prefixed with `_`) are read-only." for `insert`, "… from db.system.query()." for `query`, "… with db.system." by id, "User tables can only be accessed from db.query()." the other way); `db.normalizeId` of a system table throws, as Convex's. |
| `db.table(name)` scoped reader (`.get(id)`, `.query()`), the newer "WithTable" API | server/database.ts (`GenericDatabaseReaderWithTable`) | done (STUDY-66) | Each method is the two-argument form with the table, after Convex's argument checks; a reader in a query (and in a query a mutation runs), `db.system.table(name)` too. The `…WithTable` types (`GenericQueryCtxWithTable`, `QueryBuilderWithTable`, …) as Convex's; as there, the default `ctx.db` type does not list `table`. |
| Typed database interfaces: `GenericDatabaseReader<DataModel>` / `GenericDatabaseWriter`, `QueryInitializer`, `IndexRangeBuilder` (index fields in order), `FilterBuilder` (field paths, typed `eq`/`lt`/arithmetic) | server/database.ts, server/query.ts, server/index_range_builder.ts, server/filter_builder.ts | done (STUDY-36) | In `@bunvex/core` (`database-types.ts`), types over the runtime transaction; `db.system` typed with `_scheduled_functions` / `_storage`. The contexts take them in the typed-functions PR. |
| Queries see a consistent snapshot (serializable reads) | crates/database | done | MVCC snapshot at `visibleTs`. |
| A mutation's queries see its own writes (merged in index order) | crates/database/src/transaction_index.rs | done | Pending-entry B-tree merge per index. |
| Read-set tracking for reactivity/OCC ends at the last key actually read | crates/database/src/reads.rs, crates/database/src/query/index_range.rs | done | As Convex since #134 (DV-57): up to the last key read, inclusive (desc: from it), the whole range once a scan runs out ([STUDY-06 §9](../study/STUDY-06-transactions-and-occ.md#9-d3-as-built-the-read-set-ends-at-the-last-key-read)). |

### 2. Query builder: withIndex, filter, order, terminal operations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.withIndex(name)` with no range (whole index) | server/query.ts, impl/query_impl.ts | done | |
| A query's table and index when it starts: names parsed, the index looked up | common/src/json/query.rs (`Query::try_from`), types/index.rs (`IndexName::from_str`), indexing/src/index_registry.rs (`index_not_found_error`) | done (STUDY-161 §5) | Checked when the query starts, after its operators: a full scan's table as an identifier, an index's `table.index` as an index name (``Invalid argument `query` for `queryStream` `` / `queryPage`, Convex's words); then `Index <table>.<index> not found.` for an index of a table that does not exist (even `by_id` and `by_creation_time`; a search index too) or that the table lacks. A full scan of a missing table is empty; the error depends on `_tables`, so it runs again once the table is created. |
| `.withIndex(name, q => …)` range expression | server/index_range_builder.ts | done (#10) | `compileRange`: Convex's `IndexRange::compile` rules and messages (distinct eq fields, one lower and one upper bound on one field, a prefix of the index fields in order). |
| IndexRangeBuilder `eq(field, value)`, in index-field order | index_range_builder.ts | done (#10) | Field names checked against the index, in order. |
| IndexRangeBuilder `gt`/`gte` then `lt`/`lte` on the next field | index_range_builder.ts | done (#10) | Both bounds on the same field, after the eq prefix; Convex's errors otherwise. |
| Index range on `undefined` (missing field) | crates/common/src/query.rs, value/sorting.rs | done (#21) | A missing field is `undefined` in index keys, below `null`; `eq(f, undefined)` works (B6). |
| Using `by_id` / `by_creation_time` system indexes in `withIndex` | system_fields.ts (`SystemIndexes`) | done | Both are created for every table. |
| Every user index implicitly ends with `_creationTime`, then `_id` | crates/common/src/types/index.rs; index_validation_error.rs | done (#10) | |
| `.fullTableScan()` | impl/query_impl.ts | done (#40) | |
| `.order("asc" \| "desc")` | impl/query_impl.ts | done (#40) | A second `.order()` throws "Queries may only specify order at most once"; on a search query, Convex's "Search queries must always be in relevance order" (STUDY-45). |
| `.filter(q => expr)` | server/filter_builder.ts, impl/filter_builder_impl.ts | done (#37) | |
| Filter `q.field("a.b")`, including nested field paths | filter_builder.ts | done (#37) | |
| Filter comparisons `eq` / `neq` / `lt` / `lte` / `gt` / `gte`, including `undefined` | filter_builder.ts | done (#37) | |
| Filter arithmetic `add` / `sub` / `mul` / `div` / `mod` / `neg` | filter_builder.ts | done (#37) | Errors name a value's type as Convex's `type_name` (`Null`, `Int64`, `Float64`, `Boolean`, `String`, `Bytes`, `Array`, `Object`; `undefined` for a missing field), in `Cannot negate …`, `Cannot add … and …` and `… as a Boolean` (STUDY-161 §14). |
| Filter logic `and` / `or` / `not` | filter_builder.ts | done (#37) | |
| Filters compare across types using the global value order | value/sorting.rs | done (#37) | Comparisons use `compareValues`, Convex's total order across types. |
| At most 256 query operators per query (`MAX_QUERY_OPERATORS`) | impl/query_impl.ts; common/src/query.rs | done (STUDY-66) | As Convex: `filter` refuses the 257th operator ("Can't construct query with more than 256 operators"); the start counts every operator, the terminal's limit included, and refuses more than 256 ("Invalid argument `query` for `queryStream`: Query has too many operators: N"). |
| `.limit(n)` (non-terminal operator on OrderedQuery) | server/query.ts | done (STUDY-66) | In chain order with `filter`, in every reader (`take`, `collect`, `for await`, `paginate`, search); a full limit ends the scan and its read-set; `n` checked at the start with Convex's wording. Internal in Convex's published types, so not in bunvex's either. |
| `.collect()` | impl/query_impl.ts | done (#12) | No cap: reads up to the transaction read limits (32k rows / 16 MiB), then Convex's error (B12). |
| `.take(n)`, requiring a non-negative integer | impl/query_impl.ts | done (#40) | A non-integer or negative `n` throws ("must be a non-negative integer"); `take(0)` reads nothing. |
| `.first()` | impl/query_impl.ts | done | |
| `.unique()`: returns null or the only row, and throws if there are ≥2 | impl/query_impl.ts | done (#40) | |
| Async iteration: `for await (const doc of query)` and `.next()` streaming | impl/query_impl.ts (`queryStream` / `queryStreamNext`) | done (#40) | |
| A query is single-use (reusing or rechaining it throws) | impl/query_impl.ts | done (#40) | Reusing or rechaining throws Convex's "This query has been chained with another operator and can't be reused."; iteration only once. |
| Returning a Query object from a function throws a helpful error | impl/registration_impl.ts (`validateReturnValue`) | done (STUDY-66) | Convex's message, for the top-level result of a query or mutation (`db.query` and its operators, `db.system.query`), before `returns` is checked. |
| `.count()` (internal, not public) | impl/query_impl.ts; isolate async_syscall.rs `count`; database transaction.rs `count` | done (STUDY-107) | On `db.query(t)` and `db.system.query(name)` (any system table, as Convex's: a private one counts its rows, an unknown `_` name 0), not in the public types: the snapshot's count with the transaction's own writes, a read of the whole table (no documents charged), 0 for a missing table, Convex's `TableSummariesUnavailable` while the summaries are built. A running transaction counts at its snapshot for its whole life (DV-360, DV-361 resolved). |
| `.withSearchIndex(name, q => q.search(field, text).eq(filterField, v))` | server/search_filter_builder.ts | done (STUDY-45) | `SearchFilterBuilder` (`search` then `eq`s, single use), Convex's checks of the index and filters; the index is segments plus a memory part, loaded at start with the log since (STUDY-111; DV-227); writes refused with `TextIndexTooLarge` past 100 MiB unflushed, as Convex (DV-228 resolved). |
| Search results come in relevance order (order can't be set), with prefix matching on the last term | impl/query_impl.ts; crates/search | done (STUDY-45) | BM25 ranking in relevance order, `order()` refused; the last term also matches as a prefix (DV-231). Reactive, with Convex's search read set (DV-230). |
| Search limits: 16 query terms, 32-char term max, ≤8 filter conditions, ≤1024 results | crates/search/src/constants.rs | done (STUDY-45) | 16 query terms, tokens of 32+ bytes dropped (DV-229), ≤8 `eq` conditions, ≤1024 candidates ("Search query scanned too many documents"). |

### 3. Pagination

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.paginate({ numItems, cursor })` returns `{ page, isDone, continueCursor }` | server/pagination.ts, impl/query_impl.ts | done (#42) | See STUDY-17 §4. |
| `numItems` must be > 0 and ≤ 32000 (`TRANSACTION_MAX_READ_SIZE_ROWS`) | isolate/src/environment/udf/async_syscall.rs | done (#42) | Convex's messages, each where Convex checks it (STUDY-17 §1): the client refuses a negative number or a non-number ("must be a positive number"); the syscall's serde refuses a fraction, `NaN`, the infinities and a misfit limit or cursor ("Invalid arguments for `queryPage`: …"); then 0 ("Must request at least 1 document while paginating"), too many items, a zero limit, the cursors. Checked against Convex's binary (`differential/test/paginate-args.test.ts`). |
| Opaque, encrypted cursors (`cursor: null` starts at the beginning) | async_syscall.rs (`key_broker.encrypt_cursor`) | done (DV-73) | Sealed as Convex's keybroker: AES-128-GCM-SIV under KBKDF(secret, "cursor"), version 7, hex (`cursor.ts`). A cursor that does not open (an empty one included) fails with the keybroker's message alone: "Failed to parse cursor", "Key is invalid for instance …", "Missing position field". |
| `endCursor` pins the page end so a reactive page keeps its boundaries on re-run (taken from the query journal) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `maximumRowsRead` / `maximumBytesRead` (must be > 0) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `splitCursor` + `pageStatus` (`"SplitRecommended"` / `"SplitRequired"`) | pagination.ts; async_syscall.rs (`read_page_from_query`); database query/index_range.rs | done (#42, STUDY-108) | As Convex: `SplitRequired` at `maximumRowsRead`/`maximumBytesRead` (not on a pinned page) and at a transaction read limit (the page so far, instead of the error); `SplitRecommended` past 3/4 of the page's or the transaction's limits or 6144 documents; `splitCursor` the middle document read on any page of more than two (DV-362). |
| Only one paginated query per query function (`MultiplePaginatedDatabaseQueries`); a mutation paginates any number of times | async_syscall.rs (`query_page`, `runUdf`; Convex 8449d41) | done (#42, #718) | A second `paginate()` in a query throws Convex's message, in bunvex's words. A query called from a query shares its caller's limit; one called from a mutation gets its own; a mutation is not limited (Convex 8449d41). |
| `paginate()` isn't supported inside components | async_syscall.rs | done (STUDY-154) | "paginate() is only supported in the app.", as Convex's. |
| `paginationOptsValidator` and `paginationResultValidator(item)` helpers | server/pagination.ts | done (#42) | See STUDY-17 §4. |

### 4. Database writer: `ctx.db` in mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.insert(table, value)` returns `Id<table>` | server/database.ts, impl/database_impl.ts | done (#21, #29) | Values validated at the call, and against the schema. Argument errors in Convex's words and order (STUDY-161 §1, §2): a missing value (`Must provide arg 2 …`), then the value (nesting, then "Value must be an Object", `db.patch` / `db.replace` too), then the table's name (``Invalid argument `table` for `db.insert`: `` and the identifier's own message, Rust's display of the character). |
| A write to a table that does not exist creates it (in the same transaction); reads of a missing table return nothing | database/src/bootstrap_model/table.rs (`insert_table_metadata`) | done (#33) | Reads depend on `_tables`, so they re-run when the table is created. |
| `insert` rejects system tables (names starting with `_`) | impl/database_impl.ts | done (#6) | "System table … is not accessible here." |
| `insert` assigns `_id` and `_creationTime` and rejects caller-supplied values that don't match | crates/common/src/document.rs | done (#21) | A caller-supplied `_id` / `_creationTime` that does not match throws Convex's message, in its display (STUDY-161 §4: the `_id` field as a value; the value being written, with its `_id`, for the creation time; `patch` and `replace` too); other `_`-prefixed fields are refused. |
| `_creationTime` is strictly increasing within a transaction, so inserts sort in insert order | crates/database/src/transaction.rs (`next_creation_time`) | done | `nextUp()` float increment, on main. |
| Convex-format document ids (base32; table number plus random bytes plus checksum; ~31–37 chars) | crates/value/src/id_v6.rs | done (#7) | Convex's format and generator exactly (STUDY-01 option C). Legacy v4/v5 formats are not accepted by `normalizeId`, since bunvex has no legacy data. |
| `db.patch(table, id, partial)`: shallow merge | server/database.ts | done (#21) | Validation, `undefined` removes a field, system fields as Convex. |
| `patch` with a field set to `undefined` removes that field | values/value.ts (`patchValueToJson`) | done (#21) | The key is removed in the transaction too (DV-46 resolved). |
| `patch` / `replace` / `delete` on a nonexistent id throws `NonexistentDocument` | crates/database/src/transaction.rs | done (#21, #35) | `patch`, `replace` and `delete` throw Convex's "Update / Replace / Delete on nonexistent document ID …". |
| `db.replace(table, id, value)`: replace all non-system fields, keeping `_id` / `_creationTime` | server/database.ts | done (#35) |  |
| `db.delete(table, id)` | server/database.ts | done (#35) | Throws "Delete on nonexistent document ID …", as Convex. No legacy `delete(id)` form. |
| Legacy single-argument forms: `patch(id, v)`, `replace(id, v)`, `delete(id)` | impl/database_impl.ts | done (#44) | One-argument `patch(id, v)`, `replace(id, v)`, `delete(id)`: the id names its table. |
| `db.table(name)` scoped writer (`.insert` / `.patch` / `.replace` / `.delete`) | server/database.ts (`BaseTableWriter`) | done (STUDY-66) | In a mutation; see the reader's row. |
| `db.vars.commitTs` placeholder, resolved at commit to an int64 in commit order, plus `v.commitTs()` | server/database.ts; values/value.ts (`CommitTsPlaceholder`) | done (STUDY-53) | Resolved in documents, index entries, the result and session replays; read back as the placeholder; `i64::MAX` before the commit; refused in client and scheduled arguments and filters with Convex's messages; a nested query is a reader (STUDY-53 PR 2). |
| Writes are atomic: all or none, and a throwing mutation commits nothing | crates/database | done | |
| Optimistic concurrency with automatic retry on conflict | crates/database; knobs `UDF_EXECUTOR_OCC_MAX_RETRIES` = 4 | done (STUDY-21) | 4 retries with 100 ms – 2 s full-jitter backoff. After them comes `OptimisticConcurrencyControlFailure` with Convex's message (without its docs link); HTTP 503. |
| Writes are validated against the schema when `schemaValidation` is on | crates/common/src/schemas | done (#29) | As Convex's `DocumentSchema::check_value` (STUDY-161 §3): the document without its top-level `_` fields against the schema's own validator, so an error shows neither `_id` nor `_creationTime` (writes, pending and staged validators, a push's walk). |

### 5. Function builders and registration

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `query`, `mutation`, `action` (public) | impl/registration_impl.ts | done (#25) | A handler, or `{ args, returns, handler }`; args typed from the validators. |
| `internalQuery`, `internalMutation`, `internalAction` | impl/registration_impl.ts | done (#25) | |
| Object form `{ args, returns, handler }` | server/registration.ts (`ValidatedFunction`) | done (#25) | `returns` is checked for queries, mutations and actions (a mutation that fails it writes nothing), extra object fields included, with Convex's `ReturnsValidationError` (`server/test/returns-validation.test.ts`, STUDY-65 G-A10). |
| `args` validation (an object of validators, or `v.object`), with extra fields rejected | impl/registration_impl.ts (`exportArgs`); runtime in crates | done (#25) | As Convex's `check_args` (STUDY-67 H6): the error is the message alone (no `Uncaught`, no frames, two trailing newlines), for a caller function too; a validated function refuses a non-object (`Instead received: 5.0`) and, over HTTP, an `args` array of other than one; a function without a validator gets whatever came. Over the sync protocol, extra array elements are still dropped. |
| `returns` validation | impl/registration_impl.ts (`exportReturns`) | done (#25) | An object of validators is `v.object` of them, as for `args` (STUDY-36). Its error is Convex's `ReturnsValidationError: …` alone, no `Uncaught`, no frames (STUDY-67 H6). |
| Args are always a single object (defaults to `{}`) | server/registration.ts | done | `args ?? {}`. |
| Handler returning `undefined` becomes `null` on the wire | impl/registration_impl.ts | done | `value ?? null`. |
| Function names `"dir/module:export"`; a `default` export omits `:export` | server/api.ts (`getFunctionName`) | done (STUDY-35) | Pushed modules are analyzed by file: `dir/module:export`, and a `default` export is `dir/module`. |
| `api` / `internal` function references (`anyApi`, codegen), `makeFunctionReference`, `getFunctionName`, `filterApi` | server/api.ts | done (STUDY-26, STUDY-36, STUDY-98) | `anyApi`, `makeFunctionReference`, `getFunctionName` and codegen's `api` / `internal`; references accepted everywhere a name is. `filterApi` returns its argument, filtered by type, as Convex's (STUDY-98). |
| Typed `FunctionArgs` / `FunctionReturnType`, `ApiFromModules`, `FilterApi`, `FunctionReferenceFromExport` | server/api.ts | done (STUDY-36) | `_generated/api.d.ts` (codegen PR) builds `api` / `internal` with them; `FunctionReference_future` is missing. |
| Generic builders (`queryGeneric` etc.) and typed `_generated/server` builders bound to the DataModel | impl/registration_impl.ts; codegen | done (STUDY-36) | `queryGeneric` … `httpActionGeneric`, `QueryBuilder<DataModel, Visibility>` …, `GenericQueryCtx` / `GenericMutationCtx` / `GenericActionCtx`, `RegisteredQuery` … typed from the validators; codegen writes `_generated/server` bound to the DataModel. Convex's markers at run time (`isQuery`, `isPublic`, …), with `isBunvexFunction` for `isConvexFunction` (rule 5). |
| `convex/server` is one isomorphic module: an app's shared code and `_generated/` load in a browser bundle and in Node (Next.js), not only in the backend | `npm-packages/convex/package.json` (`./server`); `server/index.ts` | done (STUDY-91) | `bunvex/server` resolves to the whole package under Bun (the `bun` condition) and to `src/isomorphic.ts` elsewhere: every value but the runtime's (engine, persistence, server, admin keys, which Convex's module does not have); a test keeps the two in step and bundles it for a browser. |
| Warning when a registered function is called directly | impl/registration_impl.ts (`dontCallDirectly`) | done (STUDY-66) | A registered function is callable: it warns (the caller's log line) and runs its handler, as Convex's; bunvex's wording, no docs link. |
| Guard against importing functions in a browser | impl/registration_impl.ts (`assertNotBrowser`) | done (STUDY-66) | `console.error` when defined in a real browser (native `window` getter); the opt-out is `window.__bunvexAllowFunctionsInBrowser` (the naming rule). |
| `exportArgs()` / `exportReturns()` metadata, used by the dashboard and codegen | impl/registration_impl.ts | done (STUDY-105) | Plain own properties on every registered function, internal ones too: the validator JSON, `{"type":"any"}` without `args` and `"null"` without `returns`. The push's analysis and `apiSpec` read them, with Convex's errors for a broken export. The strict replacer's message has no docs link (DV-355). |

### 6. Function contexts

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| QueryCtx `{ db, auth, storage (reader), runQuery, meta }` | server/registration.ts | done | `db`, `auth`, `storage`, `runQuery` (STUDY-41), `meta` (STUDY-44). |
| MutationCtx `{ db, auth, storage (writer), scheduler, runQuery, runMutation, meta }` | server/registration.ts | done | `db`, `auth`, `storage`, `scheduler`, `runQuery`, `runMutation` (STUDY-41), `meta` (STUDY-44). |
| ActionCtx `{ runQuery, runMutation, runAction, scheduler, auth, storage (action writer), vectorSearch, meta }` | server/registration.ts | done | `runQuery`, `runMutation`, `runAction` (by reference or name, internal ones included), `auth`, `scheduler`, `storage`, `vectorSearch` (STUDY-51), `meta` (STUDY-44). |
| `ctx.runQuery` from a query or mutation: same transaction, with validation | impl/registration_impl.ts | done (STUDY-41) | In the caller's transaction (its writes, identity, time; reads joining its read set), after the path, kind and arguments are checked with Convex's messages; internal functions allowed; returns checked after; errors catchable, as Convex's `JsError` display ("Uncaught Error: …" and the nested frames; a `BunvexError` keeps its data under the same display, and an action's calls get the same), a store failure not catchable (DV-205, DV-209 resolved). Nested calls from one function run one at a time (DV-207). The result crosses a JSON boundary, as Convex's: a copy, `null` for `undefined`, `undefined` fields dropped, fields sorted, and a non-value fails (`server/test/nested-results.test.ts`). So do the arguments, from a query, a mutation or an action: the callee gets a copy with fields sorted (a top-level call's keep their order). |
| `ctx.runMutation` from a mutation: a sub-transaction that rolls back if it throws | impl/registration_impl.ts | done (STUDY-41) | `Tx.begin` / `rollback` (copy-on-write index trees): a failed nested mutation's writes and created tables are undone, its reads kept; the caller may catch and commit. A failed returns check keeps the writes, as Convex. |
| `ctx.runQuery` / `ctx.runMutation` from an action: each is its own transaction | impl/actions_impl.ts | done | Each its own transaction; by reference or name, internal functions allowed. Results (and `runAction`'s) as Convex's `jsonToConvex`: a copy, `null` for `undefined`. |
| `ctx.runAction` from an action | impl/actions_impl.ts | done (STUDY-31) | By reference or name; internal functions allowed. |
| `runQuery` option `useStaleSnapshot` (mutations only) | server/registration.ts (`AdvancedRunQueryOptions`) | done (STUDY-41) | A query at the transaction's snapshot, without its pending writes, its reads discarded; refused from a query with Convex's message. |
| `transactionLimits` option on `runQuery` / `runMutation` (bytesRead, documentsRead/Written, databaseQueries, functionsScheduled, files…) | server/meta.ts, registration.ts | done (STUDY-41) | Documents and bytes read and written, database queries (read-set intervals), functions scheduled and their argument bytes, as Convex (usage so far plus the budget, never above the current limit; restored after; scheduling usage not given back by a rollback, as Convex). The file limits are accepted and never reached, as in Convex, which does not count them (DV-206 resolved). |
| Maximum nesting of `runQuery`/`runMutation` calls (`MAX_REACTOR_CALL_DEPTH` = 8) | knobs.rs | done (STUDY-41) | 8 levels below the top function; Convex's message. |
| `ctx.meta.getFunctionMetadata()` (name, componentPath, type, visibility) | server/meta.ts | done (STUDY-44) | The stripped path (`dir/module:fn`, a default export `dir/module`), `componentPath` `""` in the app and the instance's path in a component, as Convex's (the name without the component's registry key), the kind and visibility; an HTTP action is `http`, public, as Convex's `http.js:default`. |
| `ctx.meta.getTransactionMetrics()` (used/remaining per limit) | server/meta.ts | done (STUDY-44) | Queries and mutations; `remaining` against the current (a nested call's lowered) limit; the internal file metrics `used: 0` and Convex's defaults, as Convex never counts them. |
| `ctx.meta.getDeploymentMetadata()` | server/meta.ts | done (STUDY-44) | As self-hosted Convex: the instance name, `region: null`, `class: "s16"`. |
| `ctx.meta.getRequestMetadata()` (ip, userAgent, requestId, scheduledFunctionId, authToken) | server/meta.ts | done (STUDY-44) | Mutations and actions (HTTP actions too), not queries; `ip` the first `x-forwarded-for` entry else the connection's address, over HTTP and the sync protocol; a new request id per call, shared with the functions it calls; a scheduled function's id down its call tree; the user's raw token (null for an admin key). |
| `ctx.meta.getSnapshotTs()` (bigint, on the same clock as commitTs) | server/meta.ts; isolate syscall.rs | done (STUDY-44) | The snapshot in nanoseconds, synchronous, shared with nested calls; it makes a query time-dependent, as `Date.now()`. `commitTs` is STUDY-53. |
| `ctx.vectorSearch(table, index, { vector, limit, filter })` returns `[{ _id, _score }]` (actions only) | server/vector_search.ts | done (STUDY-51) | Convex's checks and messages (limit ≤256, filter on `filterFields`, ≤64 conditions, dimensions). Exact search over segments plus a memory part, loaded at start with the log since (DV-269, DV-270, STUDY-111); `VectorIndexesUnavailable` while rebuilt after a start, as Convex (STUDY-79; DV-271 resolved). |

### 7. Deterministic runtime and execution environment

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `Date.now()` / `new Date()` frozen at the start of a query or mutation | crates/isolate/src/environment/udf/phase.rs | done | Via AsyncLocalStorage (determinism.ts). Floored at the snapshot (rounded up to the ms), as `CreationTime::for_transaction`, so a clock behind the stored timestamps after a restart never gives a `Date.now()` or `_creationTime` below what the transaction read (STUDY-06 §3). |
| `Math.random()` seeded per execution | isolate/src/environment/udf | done | sfc32 PRNG. |
| A function's `Date` in UTC (`new Date(0).toString()` is `… GMT+0000 (Coordinated Universal Time)`) | `crates/common/src/utils.rs` `ensure_utc` | done (STUDY-171 §10) | `bunvex-local-backend` sets `TZ=UTC` at start, and refuses a `TZ` set to anything else with Convex's words (bunvex's name). `bunvex dev` starts it with `TZ=UTC` whatever the shell holds (DV-537). An embedded server (`createServer`) leaves its host process's time zone alone (DV-527). |
| `performance.now()` fixed in queries, incrementing in mutations, rounded down to 0.1 ms | isolate/src/environment/udf/phase.rs, helpers/performance.rs, ops/time.rs | done | `performance.timeOrigin` is the process's, not the module import time (STUDY-03 D3). |
| `fetch`, timers and `crypto.getRandomValues` throw in queries and mutations ("NoXInQueriesOrMutations") | isolate/src/environment/udf/mod.rs (`not_allowed_in_udf`) | done (STUDY-66) | As Convex's isolate: `fetch()` rejects and timers return then fail the function (uncatchable), with Convex's "Can't use … in queries and mutations. Please consider using an action." (no docs link); `crypto.getRandomValues` / `randomUUID` are **allowed**, from a stream fixed per execution (AES-CTR, as strong as Convex's ChaCha12); `crypto.subtle`'s randomness (`generateKey`, RSA-OAEP `encrypt`, RSA-PSS / ECDSA `sign`) is refused. Not a sandbox: captured globals escape. |
| `Date` / `Math.random` at module import time | udf/phase.rs | done (STUDY-35) | Convex's import phase: `Math.random` seeded and `Date.now()` fixed by the deployment, `performance.now()` 0; fetch and timers fail with Convex's "… unsupported at import time" (a timer after it returns), `crypto.getRandomValues` / `randomUUID` draw from a stream keyed by the deployment, and `crypto.subtle`'s randomness fails with "Cannot use cryptographic randomness at import time" (STUDY-66 §4). |
| Actions run with the real globals (`fetch`, timers) | isolate/src/environment/action | done | |
| An action's `fetch` takes `http:` / `https:` only ("Unsupported URL scheme -- http and https are supported (scheme was …)") and the web's `RequestInit` | udf-runtime/src/23_request.ts (`validateURL`), 26_fetch.ts | done (STUDY-80) | Bun's `fetch` also reads `file:` and `s3:` and takes `unix` / `proxy` / `tls` / `s3`: an action gets none of them (Convex's `TypeError`; the options dropped). A `"use node"` action as Node's `fetch` (`data:` too). The host's own `fetch` is untouched. ~0.12 µs per call (with STUDY-142's request and response handling, ~0.7 µs). A `new Request("file:…")` still builds (Convex's constructor throws). |
| A failed action `fetch` is `TypeError: fetch to <url> failed: <cause>` (query string dropped); default `User-Agent: Convex/1.0` | udf-runtime/src/26_fetch.ts; common/src/http/fetch.rs | done (STUDY-142) | Convex's `fetchFailure` and redirect loop (20 hops, its three errors, method/body/`Authorization`/`Referrer-Policy` rules, `redirected`); reqwest's causes from Bun's codes (refused, unreachable, DNS, closed, a body's "error decoding response body"), checked against Convex's binary; aborts as Convex's `AbortError`; no idle timeout. `User-Agent: Bunvex/1.0` (DV-456). TLS and malformed-answer causes in Bun's words (DV-457); a pre-aborted signal rejects (DV-458). A 307 or 308 that sends the body again is metered again, per hop; OIDC discovery and JWKS send `Bunvex/1.0` too. |
| Function isolation (per-function V8 isolate, memory cap `ISOLATE_MAX_USER_HEAP_SIZE` = 64 MiB) | knobs.rs; isolate | partial (STUDY-35) | Deployed code runs in one `vm` context per code version (DV-164): its own globals and deterministic `Date`/`Math`, imports limited to `bunvex/*` and the bundle (Node builtins only in `"use node"`), freed when superseded. Not a security boundary; no heap cap. Module state lasts the version (DV-165). A sandboxed process per call, with Convex's 96 MiB cap, is coming as an opt-in executor (AD-44, STUDY-168): every load goes through one factory and `BUNVEX_FUNCTION_SANDBOX` is parsed (STUDY-171), a child process loads and analyzes a push as `vm` does (`packages/sandbox`, STUDY-171 §7), and under `BUNVEX_FUNCTION_SANDBOX=process` (isolation `none`, no OS boundary yet) queries and mutations run in it, every `ctx` operation on the host's transaction, user time counted in the child and a function that never yields stopped at its limit (STUDY-171 §8), their console lines and error stacks as under `vm` (STUDY-171 §11), and actions too (STUDY-171 §12): `fetch` through the host's `isolateFetch` (the address screen, the proxy, the meters, the timeout's abort), bodies and stored files streamed as chunk frames, `ctx.storage`, `ctx.vectorSearch` with its filter recorded in the child, rooms (their gates run in the child), an action past its timeout cut off in its child and the child killed if it does not hear it; a promise a query, mutation or action leaves rejected with no handler fails it, as on Convex, where `vm` prints it (STUDY-171 §13, DV-528); `"use node"` actions, HTTP actions and components run only in `vm` so far. |
| `process.env` environment variables available to functions (name ≤ 256, value ≤ 8 KiB) | common/src/types/environment_variables.rs | done (STUDY-37) | Pushed code reads the deployment's variables, each read in the read set; see [platform §env](platform.md). Managed over HTTP; the CLI's `bunvex env` comes next. |
| `console.log` / `info` / `warn` / `error` captured as function logs (≤256 lines, ≤32 KiB each) | isolate/src/environment/helpers/mod.rs | done (STUDY-20) | Also `debug`, `trace`, `time`/`timeLog`/`timeEnd`, rendered with object-inspect as Convex does. A retried mutation keeps only the committed attempt's lines. Engine objects (`ctx.db`, a query, `ctx.db.system`, a table scope) print as `Name {…}`, never their state (STUDY-20 D9, DV-321). Cached query results carry no lines (STUDY-20 D2). A "use node" action's lines go through Node's `util.inspect`, as Convex's node executor writes them (objects on one line, the timer's label line and warnings quoted). Objects from pushed code's vm context and from the server render alike, with no `null prototype` tag (`object-inspect` patched: `patches/`). |
| `log.audit(body)` + `log.vars` (requestId, ip, userAgent, now, convexActor) | server/log.ts, audit_logging.ts, logVars.ts | done (STUDY-82) | `log` from `bunvex/server`: Convex's body checks (`$` keys, unknown variables; their errors carry the app's frames, never the server's, STUDY-171 §10), a query's or mutation's lines (nested calls' included) resolved when it ends and sent as `custom_audit` events, Convex's limits (500 lines, 100 KB a line, 4 MB in all, 4 MB held; HTTP 400 with the code), refused in actions. `log.vars.bunvexActor` for `convexActor` (DV-03), null on a self-hosted deployment. No sink can subscribe to `custom_audit` without an entitlement, as Convex self-hosted (DV-304). A cached query's hit does not replay its lines (unobservable until a sink can take them). |
| `getServiceToken("ai-gateway")` / `getServiceUrl` | impl/actions_impl.ts | done (STUDY-151 §4) | Exported from `bunvex/server`, for actions: the AI gateway is a hosted cloud service, so both fail with `AiGatewayUnavailable`, as a self-hosted Convex's token does (the URL: DV-491); outside an action, Convex's "Unknown async operation"; the argument checked as Convex's. |
| Node runtime actions (`"use node"`) | CLI / node-executor | done (STUDY-35) | **Divergence (DV-87, DV-169):** the directive is accepted and those modules run in Bun itself, with Node builtins; Convex's rules for them enforced (only actions; not `http`, `crons`). No separate Node action timeout (§19). |
| Query result caching keyed by args and identity, invalidated by read-set | crates/application cache | done (STUDY-08 §3.6) | As Convex (DV-63): keyed by name, canonical args and (when read) identity; an LRU bounded by bytes (`UDF_CACHE_MAX_SIZE`, 100 MiB); identical concurrent calls coalesced, HTTP included; validated against the write log when looked up, at any later ts (`query_at_ts` too); clock readers expire after 17 s, and only they (until STUDY-171 §9, the server's own metrics made every pushed query a clock reader). Sync subscriptions keep their own shared executions (DV-09). Decided, internal: a hit writes its token back (DV-153). |

### 8. Validators (`v`) and value types

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `v.id(table)` | values/validator.ts | done (#24) | Checks the id names the table (catalog lookup). |
| **bunvex addition** ([AD-21, AD-22](additions.md#additions)): table names in `v.id` — the system tables suggested everywhere (`schema.ts` included), and `v` from `_generated/server` typed with the app's tables (a misspelled table is a type error; any name with no schema or `strictTableNameTypes: false`) | — (convex-helpers' `typedV` is the nearest) | done (STUDY-100 T1, T2) | Type-only; the generated `v` is bunvex's `v`. |
| `v.null()` | values/validator.ts | done (#24) | |
| `v.number()` / `v.float64()` | values/validator.ts | done (#24) | |
| `v.bigint()` / `v.int64()` | values/validator.ts | done (#24) | |
| `v.boolean()` | values/validator.ts | done (#24) | |
| `v.string()` | values/validator.ts | done (#24) | |
| `v.bytes()` (ArrayBuffer) | values/validator.ts | done (#24) | In a message's value display (a validator's `Value:`, `Document(value: …)`, a system-field mismatch, a filter's), bytes are Convex's `b"AQI="`: padded standard base64, never cut (STUDY-161 §13). |
| `v.literal(string \| number \| bigint \| boolean)` | values/validator.ts | done (#24) | |
| `v.array(el)` | values/validator.ts | done (#24) | |
| `v.object(fields)`, rejecting unknown fields | values/validator.ts | done (#24) | |
| `v.record(keys, values)` (keys are string-like or ids; no optional keys or values) | values/validators.ts (`VRecord`) | done (#24) | |
| `v.union(...members)` | values/validator.ts | done (#24) | |
| `v.any()` | values/validator.ts | done (#24) | |
| `v.optional(x)` and the `.optional()` method on every validator | values/validator.ts, validators.ts | done (#24) | |
| `v.nullable(x)` (= `union(x, null)`) | values/validator.ts | done (#24) | |
| `v.commitTs()` | values/validator.ts (`VCommitTs`) | done (STUDY-53) | `{type: "commitTs"}`; accepts an int64 or the placeholder. |
| VObject helpers `.omit()`, `.pick()`, `.partial()`, `.extend()` | values/validators.ts | done (#24) | |
| Validator introspection (`.kind`, `.isOptional`, `.fields`, `.members`, `.element`, `.json`) | values/validators.ts | done (#24) | bunvex marker is `isValidator` (no "convex" in names). |
| `Infer<typeof validator>`, `ObjectType`, `PropertyValidators`, `asObjectValidator`, `GenericValidator` | values/validator.ts | done (#24) | asObjectValidator not yet. |
| Undefined-validator error (catches circular imports) | validators.ts; registration_impl.ts (`strictReplacer`) | done (#24; STUDY-13 §6) | Every builder throws Convex's message when called with `undefined`: `v.object` (the field), `v.array`, `v.record` (key, value), `v.union` (the member's index). Its other argument checks are Convex's in order and words too, `v.literal` and `v.id` included. No docs link (DV-358). The `strictReplacer` side is STUDY-105. |
| Value `null` | values/value.ts | done | JSON. |
| Value `boolean` | values/value.ts | done | |
| Value `string` | values/value.ts | done | |
| Value `number` (float64), including NaN, ±Infinity and −0 | values/value.ts (`$float` encoding) | done (#21) | NaN, ±Infinity and −0 kept (the `$float` encoding); −0 sorts below +0. |
| Value `bigint` (int64, range-checked) | values/value.ts | done (#21) | Range-checked to int64; `$integer` encoding. |
| Value `ArrayBuffer` (bytes) | values/value.ts | done (#21) | `$bytes` encoding; copied at the call. |
| Value arrays and plain objects | values/value.ts | done (#21) | Stored and index-keyable, in Convex's order (B11). |
| `undefined` isn't a value (error at a path); `undefined` object fields are dropped | values/value.ts (`convexToJsonInternal`) | done (#21) | `toJsonValue` refuses `undefined` with a path and drops `undefined` fields. |
| Only plain objects allowed (class instances rejected) | values/value.ts (`isSimpleObject`) | done (#21) | Class instances, `Map` and `Set` refused ("… is not a supported value type", Convex's message structure without "Convex"). The message names a class instance (`Point {…}`) without opening it (DV-316, decided by the owner 2026-10-03). The refused `Set` / `Map` prints its entries as Convex's (`Set[1]`, `Map[["a",1]]`), a pushed function's too, and a result, scheduled or nested-call arguments are converted first, as Convex's app-side `convexToJson` (STUDY-18 §9). |
| Wire encoding `convexToJson` / `jsonToConvex` (`$integer`, `$bytes`, `$float`) | values/value.ts | done (#21) | As `toJsonValue` / `fromJsonValue` (no "convex" in bunvex's public names). |
| `Id<T>` / `GenericId` branded string type | values/value.ts | done (STUDY-36) | `GenericId<T>` in `@bunvex/values`; `v.id(t)` infers it; `_generated/dataModel` names it `Id<T>` (codegen PR). |
| `compareValues`, `getConvexSize`, `getDocumentSize`, `Base64` utilities | values/compare.ts, size.ts, base64.ts | done (STUDY-97) | `compareValues`, `getDocumentSize` and `Base64` with Convex's names and results (checked against Convex's functions); `getConvexSize` is `valueSize`, with Convex's edges and errors (DV-347: rule 5, an import of `getConvexSize` fails). |
| `ConvexError(data)`: `data` is any Convex value and reaches the client as `errorData` | values/errors.ts; registration_impl.ts | done (STUDY-20) | As `BunvexError` (owner's decision). HTTP `errorData`, WebSocket `d`. |

### 9. Value ordering (index order and filter comparisons)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Cross-type order: undefined < null < int64 < float64 < boolean < string < bytes < array < object | crates/value/src/sorting.rs | done (#21) | Convex's sort keys (STUDY-18): undefined < null < int64 < float64 < boolean < string < bytes < array < object (DV-34 resolved). |
| float64 total order (`total_cmp`: −NaN < −∞ < … < −0 < +0 < … < +∞ < NaN) | sorting.rs | done (#21) | IEEE total order; −0 < +0. |
| int64 ordered numerically and separately from float64 (1n ≠ 1) | sorting.rs | done (#21) | Its own tag below float64. |
| Strings ordered by UTF-8 bytes | sorting.rs; values/compare_utf8.ts | done | Escaped, 0x00-terminated UTF-8 in keyenc. |
| A string with a lone surrogate never crosses into the backend | isolate/src/execution_scope.rs; isolate/src/helpers.rs; value/src/serialized_args_ext.rs | done (STUDY-135) | Writes, queries, nested calls and the scheduler fail with serde's "Received invalid json: …" and its column in Convex's syscall text; a result fails its function; a client's arguments are "Invalid arguments provided"; logs and messages carry U+FFFD; an application error's data holding one is left out (string data: DV-431). Checked against Convex in the differential tests. |
| Bytes ordered lexicographically | sorting.rs | done | Tag exists. The `_id` tiebreaker uses it. |
| Arrays ordered element-wise; objects by (field, value) pairs in field order | sorting.rs | done (#21) | Array and object tags; objects by sorted field names. |
| Missing index fields sort as `undefined`, which is distinct from `null` | sorting.rs (`write_sort_key_or_undefined`) | done (#21) | `undefined` below `null` (B6). |

### 10. System fields and document shape

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `_id` on every document | server/system_fields.ts | done (#7) | A Convex-format id. |
| `_creationTime` (float64 ms since epoch) | system_fields.ts; common/src/document.rs | done | |
| Types `WithoutSystemFields`, `WithOptionalSystemFields`, `SystemFields`, `IdField`, `Doc<T>` | system_fields.ts; codegen | done (STUDY-36) | In `@bunvex/core` (`data-model.ts`); `Doc<T>` comes with `_generated/dataModel`. |
| Top-level user fields can't start with `_` | crates/common/src/document.rs (validate) | done (#21) | Refused at write, as `must_validate`: "Document(value: {…}) isn't a valid document: Field '…' starts with an underscore, which is only allowed for system fields like '_id'", every violation joined by "\n " (`core/test/writes.test.ts`, found by the differential tests). |
| Field names: ≤1024 chars, non-control ASCII, no leading `$` | crates/convex/sync_types/src/identifier.rs; values/value.ts | done (#21) | `validateObjectField`, with the same messages. |
| Documents must be objects | common/src/document.rs | done (#21) | A non-object write value throws ("expected an object"). |

### 11. Schema

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineSchema({ table: defineTable(...) })` | server/schema.ts | done (#29) | |
| `defineTable(validatorFields \| v.object \| v.union of objects \| v.any)` | server/schema.ts | done (#29; STUDY-14 §6) | As Convex, `defineTable` itself checks nothing more. A push refuses a validator a table cannot have with `InvalidTopLevelTypeInSchemaError`, and one whose JSON is not an object with `InvalidSchemaExport`. Messages without the docs link (DV-397). |
| `.index(name, [fields])` | server/schema.ts | done (#29) | `defineTable(...).index(name, fields)`. |
| `.index(name, { fields, staged })`: staged indexes that don't block a push | server/schema.ts | done (STUDY-29) | `{ fields, staged: true }`: backfilled in the background, not enabled until un-staged; a query on it gets Convex's error. |
| `.searchIndex(name, { searchField, filterFields, staged })` | server/schema.ts | done (STUDY-45) | Convex's push-time checks and messages; `staged` too. |
| `.vectorIndex(name, { vectorField, dimensions, filterFields, staged })` | server/schema.ts | done (STUDY-51) | Convex's push-time checks and messages; `staged` too. The vector field is not checked against the document schema (DV-272). |
| `.staged(validator)`: the next document validator, staged | server/schema.ts | done (STUDY-106) | Accepted, serialized as `stagedDocumentType` and stored with the schema, as Convex: a change to it alone is a schema change; its top-level type is checked at push (`InvalidTopLevelTypeInSchemaError`). Each staged table has its `_schema_validations` row (`validatorHash`, carried over when it can be reused, kept at activation), and a push refuses a staged validator on a table whose enforced change needs a walk (400 `StagedSchemaWithEnforcedValidatorChanges`), as Convex's. Every write to the table is checked against it (the active schema's and an in-progress push's): one it refuses still succeeds and fails the table's staged validation, as Convex's (DV-438 PR 3). The existing documents are walked against it in the background after a push (valid, or failed at the first document that does not match; a table its shape or the enforced validator proves is valid without a walk), as Convex's (DV-438 PR 4). A staged validator proven valid stands in for the walk when the enforced validator it proves is pushed (`supersetOfStagedValidated`, predicted by `evaluate_schema` and passing the 400's check), and deleting or replacing a table it points to with `v.id` fails its validation, as Convex's (DV-438 PR 5, STUDY-106 §7). `evaluate_schema` reports each table's staged validation (`staged`), whether its finishing would spare the walk (`canSkipAfterStagedValidation`), and the pending or valid staged validations the push throws away (`discardedStagedValidators`); the dashboard's `getSchemas:stagedSchemaValidationProgress` lists the active schema's (DV-438 PR 6, 5b65aedb3). Messages without the docs link (DV-356). |
| `schemaValidation` option (default true) | server/schema.ts | done (#29) | |
| `strictTableNameTypes` option (type-level) | server/schema.ts | done (STUDY-36) | `false` adds `AnyDataModel` to the data model: any other table name is allowed. |
| `schema.doc(table)` / `schema.id(table)` / `docValidator()` helpers | server/schema.ts | done (STUDY-66) | Convex's validators and types (`DocValidator`), and its error for a table the schema does not have; `TableDefinition.validator` too. |
| `schema.tables` is the record of `TableDefinition`s (`schema.tables.messages.validator`) | server/schema.ts | done (STUDY-144) | `schema.tables` is the record given to `defineSchema` (typed: `schema.tables.messages.validator`), so `docValidator("messages", schema.tables.messages)` works; the schema's own fields are Convex's (`tables`, `strictTableNameTypes`, `schemaValidation`); `TableDefinition`'s experimental `" indexes"()` too. The engine reads `declaredTables(schema)`, made from the record on first use (an index added after `defineSchema` counts, as Convex exports at push). Checked against the `convex` package. Not built: the internal `export()` methods. |
| Pushing a schema validates existing documents against it | crates/model / schema worker | done (STUDY-35) | A pushed schema is pending until existing documents are checked: the first that does not match fails the push, named as Convex's; writes meanwhile fail the pending schema. A push of the schema already active (or pending) reuses it, as Convex's `submit_pending` (STUDY-35 §7). |
| Index backfill when an index is added to an existing table | crates/database/src/database_index_workers | done (STUDY-29) | In the background, as Convex: a worker, `backfilling` → `backfilled` → `enabled`, checkpoints and resume (DV-54 resolved; DV-126, DV-127). |
| Table names: identifier ≤64, starts with a letter, `[A-Za-z0-9_]`; `_` prefix reserved | sync_types/identifier.rs; index_validation_error.rs | done (#6) | Convex's identifier rule; a leading `_` is reserved for system tables. |
| Index names: identifier; not `by_id` / `by_creation_time` / `_`-prefixed; unique per table | index_validation_error.rs | done (#6) | Reserved and repeated names of database indexes fail in `defineSchema` with Convex's messages, naming the table (STUDY-65 M1). |
| Index fields: ≥1 field, ≤16 fields, unique, no `_id` / `_creationTime`, no `_`-prefixed fields | index_validation_error.rs; bootstrap_model/index/mod.rs | done (STUDY-65 M1) | In `defineSchema`, in Convex's order and with its messages (`IndexFieldsContainId`, `IndexFieldsContainCreationTime` without its docs link, `IndexFieldNameReserved`, `FieldsNotUniqueWithinIndex`, `IndexTooManyFields`, `EmptyIndex`). As Convex, 16 fields are refused too: `_creationTime` is appended before the last count. |
| No two indexes with identical fields on a table | index_validation_error.rs | done (STUDY-45, STUDY-51, STUDY-65 M1) | Checked for search indexes (same `searchField` and filter fields), vector indexes and database indexes (staged ones included), with Convex's messages. |
| ≤64 indexes per table (`MAX_INDEXES_PER_TABLE`) and ≤10,000 tables | common/src/schemas/mod.rs; database/src/bootstrap_model/table.rs | done (STUDY-45, STUDY-101) | ≤64 indexes per table (database, search and vector together) checked in `defineSchema`; ≤10,000 active user tables, Convex's `TooManyTables` (STUDY-101). |
| Vector dimensions between 2 and 4096; ≤16 filter fields for search and vector indexes | common/src/bootstrap_model/index | done (STUDY-45, STUDY-51) | 2–4096 dimensions, ≤16 filter fields, with Convex's messages. |
| `DataModelFromSchemaDefinition` typed data model | server/schema.ts | done (STUDY-36) | Each table's document (system fields on every union branch; `v.any()` tables are `any`), field paths (nested object fields dotted, not into arrays or records) and indexes (`_creationTime` appended, plus `by_id` / `by_creation_time`); `defineTable` / `.index` / `defineSchema` keep their types. The typed database is `database-types.ts`. |

### 12. Auth (`ctx.auth`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `ctx.auth.getUserIdentity()` returns `UserIdentity \| null` in queries, mutations, actions and HTTP actions | server/authentication.ts | done (STUDY-27, STUDY-31) | Queries, mutations, actions (passed to `runQuery` / `runMutation`) and HTTP actions (from `Authorization`; a bad token throws at `getUserIdentity()`). |
| `UserIdentity` fields (tokenIdentifier, subject, issuer, name, email, emailVerified, …, custom claims) | server/authentication.ts | done (STUDY-27) | `@bunvex/auth` `identityFromOidc` / `identityFromCustomJwt`, with Convex's dropped claims and custom-JWT flattening. |
| `auth.config.ts` providers: OIDC `{ domain, applicationID }` and `customJwt` `{ issuer, jwks, algorithm RS256/ES256 }` | server/authentication.ts (`AuthConfig`) | done (STUDY-27) | `createServer({ auth })` with `bunvex/auth.config.ts`'s default export (DV-100). |
| Query cache and subscriptions scoped by identity | crates/application | done (STUDY-27) | A result is keyed by identity only if the run read it, in the query cache and in sync's shared executions (B13). |

### 13. File storage (`ctx.storage`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `storage.getUrl(id)` (queries, mutations, actions) | server/storage.ts | done (STUDY-32) | `{cloud origin}/api/storage/<uuid>`; reactive in queries and mutations. An id's errors as Convex's, from every storage method (checked against Convex's binary): another table's id unwrapped, an id that does not parse wrapped as ``Invalid argument `storageId` for `<method>`: …`` with Convex's line break. In a component (STUDY-157 PR 3): its own `_storage`, the URL with `?component=<id>`, which `GET /api/storage/<uuid>` reads (a missing or other component: 404 `FileNotFound`). |
| `storage.getMetadata(id)` (deprecated in favour of `db.system.get("_storage", id)`) | server/storage.ts | done (STUDY-32) | `{storageId: uuid, sha256: hex, size, contentType}`. |
| `storage.generateUploadUrl()` (mutations, actions) + HTTP POST upload returning `{ storageId }` | server/storage.ts | done (STUDY-32) | Tokens valid for an hour, reusable. A component's token seals its id: the upload goes to its `_storage` (STUDY-157 PR 3). |
| `storage.delete(id)` (mutations, actions) | server/storage.ts | done (STUDY-32) | Transactional; a missing file throws; the blob goes after commit (F3). |
| `storage.store(blob, { sha256 })` (actions; the mutation variant is internal/unreleased) | server/storage.ts; async_syscall.rs | done (STUDY-32) | In mutations: Convex's "not supported" error. |
| `storage.get(id)` returns `Blob` (actions only) | server/storage.ts | done (STUDY-32) | Actions and HTTP actions. |
| `_storage` system table `{ sha256, size, contentType? }` | server/schema.ts (`_systemSchema`) | done (STUDY-32, STUDY-125) | Through `db.system`, a virtual table over `_file_storage`; `contentType` null when absent. |
| Per-transaction file limits: 10 files / 16 MiB written, 10 files / 16 MiB read | knobs.rs | done (STUDY-32) | As Convex: declared there but never enforced, so none here. |

### 14. Scheduler (`ctx.scheduler`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `scheduler.runAfter(ms, fnRef, args)` returns `Id<"_scheduled_functions">` | server/scheduler.ts | done (STUDY-30) | Typed since STUDY-36: a reference's arguments, and the id. In components (STUDY-157 PR 1): a component schedules its own functions, and a parent a child's by reference or handle; the job lives in the scheduler's namespace and runs in its target's component, with Convex's texts naming it (`in '<path>'`); the limits count the whole transaction. |
| `scheduler.runAt(timestamp \| Date, fnRef, args)` | server/scheduler.ts | done (STUDY-30) | A pushed function's own `Date` is a time (it failed before STUDY-18 §9). |
| `scheduler.cancel(id)` | server/scheduler.ts | done (STUDY-30) | In the caller's namespace; a component action's too (DV-536: Convex's resolves it in the root's). A job scheduled by a canceled job's action is born canceled, its parent looked up across namespaces (STUDY-157 PR 1). |
| Scheduling from a mutation is transactional (only if the mutation commits); from an action it isn't | docs; crates/model scheduled_jobs | done (STUDY-30) | |
| Scheduled mutations run exactly once, scheduled actions at most once | crates/application scheduled_jobs | done (STUDY-30) | |
| `_scheduled_functions` system table (name, args, scheduledTime, completedTime, state pending/inProgress/success/failed/canceled) | server/schema.ts | done (STUDY-30) | Read through `db.system.get` / `db.system.query`. Per namespace: a component reads its own jobs. A job whose function is in a component carries `component: "<path>"` (AD-33, STUDY-157 PR 1); the app's have none, as Convex's. |
| Limits: 1000 scheduled per transaction, 16 MiB total args, 4 MiB per job's args; retention 7 days | knobs.rs | done (STUDY-30) | The 4 MiB per job is only a warning in Convex; bunvex does not warn yet. |
| Only mutations and actions (public or internal) can be scheduled | server/scheduler.ts | done (STUDY-30) | Checked when the job runs, as Convex. |

### 15. Crons

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `cronJobs()` + `export default crons` in `crons.ts` | server/cron.ts | done (STUDY-35) | The default export of the pushed `crons.ts`, as Convex (checked at push); or `createServer({ crons })`. A component's `crons.ts` runs its own functions, its next runs and logs in its namespace; an unmount deletes them (STUDY-157 PR 2). |
| `crons.interval(id, { seconds \| minutes \| hours }, fn, args)` | server/cron.ts | done (STUDY-30) | |
| `crons.hourly(id, { minuteUTC }?, fn, args)` | server/cron.ts | done (STUDY-30) | |
| `crons.daily(id, { hourUTC, minuteUTC }?, …)` | server/cron.ts | done (STUDY-30) | |
| `crons.weekly(id, { dayOfWeek, hourUTC, minuteUTC }, …)` | server/cron.ts | done (STUDY-30) | |
| `crons.monthly(id, { day, hourUTC, minuteUTC }, …)` | server/cron.ts | done (STUDY-30) | |
| `crons.cron(id, "unix cron string", …)` | server/cron.ts | done (STUDY-30) | saffron's grammar and semantics. |
| Unique cron identifiers; input validation (ranges for minute, hour and day) | server/cron.ts | done (STUDY-30) | |

### 16. HTTP actions and router

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `httpAction(async (ctx, request) => Response)` with an ActionCtx | impl/registration_impl.ts (`httpActionGeneric`) | done (STUDY-31) | Served on `/http/*` and the site port. A handler whose client went away runs to the end (its writes commit); before the head, its Completion fails with "Client disconnected", as Convex's (STUDY-65 G-A11). Not yet: the `[INFO] Client disconnected` line when the client leaves while the body streams. |
| `httpRouter()` + `http.route({ path, method, handler })` in `http.ts` | server/router.ts | done (STUDY-31) | The default export of the pushed `http.ts` (STUDY-35), or `createServer({ http })` (H1, DV-143). |
| `http.route({ pathPrefix: "/x/", … })` prefix routes, longest prefix wins | server/router.ts | done (STUDY-31) | |
| Methods GET / POST / PUT / DELETE / OPTIONS / PATCH; HEAD maps to GET | server/router.ts (`normalizeMethod`) | done (STUDY-31) | |
| Route validation: leading `/`, prefix ends with `/`, `/.files` reserved, duplicate detection | server/router.ts | done (STUDY-31) | Convex's messages, in its order; the start checks of `http.js` too. |
| `getRoutes()` / `lookup(path, method)` | server/router.ts | done (STUDY-31) | |
| Served on the separate HTTP-actions origin/port (`/.site`-style), with `defineApp({ httpPrefix })` | components/index.ts; crates/local_backend | done (STUDY-31, STUDY-157 PR 4) | `/http/*` and the site port. The app's `http.js` is matched after its `httpPrefix`, as Convex's `route_http_action`; a component's `http.js` under its mount (below). |

### 17. Components

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineComponent(name, { env })` in `convex.config.ts` | server/components/index.ts | done (STUDY-153, STUDY-156 PR 1) | In `bunvex/server`, as Convex's: its env validators, `env` references, `use`, and `export()` the same as Convex's package for the same calls (compared in packages/differential); the file is `bunvex.config.ts` (DV-494). Pushed by the CLI (STUDY-156 PR 1) and evaluated and written by the server (STUDY-153 PRs 3–4). |
| `defineApp({ httpPrefix, env })` + `app.use(component, { name, httpPrefix, env })` | server/components/index.ts | done (STUDY-153, STUDY-156 PR 1) | In `bunvex/server`, as Convex's (names, prefixes normalized, env bindings, the errors); the server evaluates `bunvex.config.js` as Convex evaluates its definitions (STUDY-153 PR 3a, `definition-eval.ts`) at every push (PR 3c); the CLI pushes it (STUDY-156 PR 1). The app's `httpPrefix` and the mounts route HTTP requests from STUDY-157 PR 4. |
| `components.<name>.<module>.<fn>` references (`componentsGeneric`) | server/components/index.ts | done (STUDY-153 PR 1, STUDY-156 PR 2) | `componentsGeneric` is in `bunvex/server`, its references Convex's (`_reference/childComponent/…`, compared in packages/differential); codegen types `components` with each child's `ComponentApi`, `FunctionReference`'s fifth parameter the component's path, as Convex's (DV-174 closed). The server resolves them in `ctx.runQuery` / `runMutation` / `runAction` among the caller's direct children, public exports only, with Convex's texts (STUDY-155 PR 1, DV-531). |
| Component env definitions with validators and env refs | server/components/index.ts (`EnvDefinition`) | done (STUDY-153, STUDY-154) | Declared with validators and bound by the parent (STUDY-153 PR 1), checked at push (PR 3b); a component's `process.env` its bindings, a value or the deployment's variable, then the built-ins, `BUNVEX_SITE_URL` with its HTTP prefix (STUDY-154). |
| `createFunctionHandle(fnRef)` returns a string handle usable in `runX` / scheduler | server/components/index.ts | done (STUDY-50) | In queries, mutations and actions; Convex's errors. Across components (STUDY-155 PR 2): `createFunctionHandle(components.…)`, a child's handle called by the app and the app's by a child, each in its own namespace; an unmounted component's handles are not found; scheduled by the app or a component (STUDY-157 PR 1). |
| Isolated per-component tables, functions and data | crates (component registry) | partial (STUDY-152 steps 1–7) | Tables: each component's in its own namespace, as Convex stores them; a store the Convex binary wrote with components opens with them apart (step 1). The registry: `_components` rows in Convex's shape, paths resolved through the tree in the transaction, a new component's namespace with its twelve system tables (step 2). Functions inside a component: run by an admin (STUDY-154) and called from the app or a parent component, in the callee's namespace (STUDY-155 PR 1); its scheduler (STUDY-157 PR 1, #740), crons (PR 2, #744), storage (PR 3, #752), HTTP mounts (PR 4, #758) and search and vector indexes (PR 5). Still to build: export and import by component (STUDY-152 step 10, DV-215). |

### 18. Errors surfaced to apps

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `throw new ConvexError(data)`, where the client receives `data` intact | values/errors.ts; impl/registration_impl.ts | done (STUDY-20, STUDY-26) | `BunvexError` (DV-03): the server sends `data` intact; the clients rethrow it with `data`. |
| Non-ConvexError errors redacted in production ("Server Error") | crates/application | done (STUDY-20) | `[Request ID: …] Server Error`, with the details unless `REDACT_LOGS_TO_CLIENT` / `redactLogsToClient` (off by default, as self-hosted Convex). |
| Limit error codes (e.g. `TooManyDocumentsRead`, `TooManyWrites`, `ValueTooLarge`): not exposed to apps | crates/errors/src/lib.rs (`ErrorMetadata`); database reads.rs, writes.rs; npm server/impl/syscall.ts | done (STUDY-108) | As Convex: the codes stay in the backend; an app gets a plain `Error` with Convex's message (no `code`, no `data`). Internally the read and write limit errors are marked so `paginate()` ends its page with `SplitRequired` at one, as Convex's `read_page_from_query`. |
| `unique()` error when there are multiple results; errors for misuse of closed/chained queries | impl/query_impl.ts | done (#40) | |
| An uncaught error's stack: the app's frames only, each mapped through its module's source map to the original file, line and column, for the client, logs, `run`, a failed push and a nested call's caller | crates/common/src/errors.rs (`JsError::from_frames`); udf-runtime/src/errors.ts | done (STUDY-95) | Frames name sources as Convex's bundler does (`../bunvex/messages.ts`); the server's frames are dropped, also from an error the server raises with no frame of the app's (a value it cannot serialize: no frame of bunvex's library either, DV-501). Function names are JavaScriptCore's (DV-345); positions as the map defines them (DV-346). An action's (and an HTTP action's) failed `runQuery` / `runMutation` / `runAction` ends with the action's own frame, where it awaited the call (`at async …`), as Convex's: the caller's error is made by an async wrapper in the code's own vm context, since JavaScriptCore follows `await`s within one realm only. A function reading `error.stack` sees the same frames, as Convex's `prepareStackTrace`: in V8 the frames alone, in Node `Error: <message>` and the frames (mapped, DV-482 pending); an engine error (`db.*`, the scheduler, storage, nested calls) gets the app's frames where it awaited the call (`at async …`, Convex's `performAsyncSyscall`), through an in-realm view of the context; no server frame or path reaches the client, `error.stack` or the log stream (STUDY-150). |

### 19. Limits

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Document size ≤ 1 MiB (`MAX_USER_SIZE`, including system fields) | crates/common/src/document.rs | done (#35) | |
| Document nesting ≤ 16 levels (`MAX_DOCUMENT_NESTING`) | crates/common/src/document.rs | done (#35) | The message follows the document's display, as `must_validate`'s. |
| Generic value (args/results) size ≤ 32 MiB and nesting ≤ 64 | crates/value/src/size.rs | done (STUDY-109) | Nesting: arguments 63 levels (Convex parses `[args]`), results 64, written values 64 (a patch: each field 64), with Convex's messages and order (nesting, then size, then validator; a written value before its table and document; `runUdf`'s message for a query's or mutation's nested call past 64). Any depth fails with the message, never a stack overflow; past serde's 128 JSON levels Convex answers otherwise (DV-363). Size and nesting are measured in one walk. The 32 MiB size is never reached: the 16 MiB argument and result limits and the 1 MiB document limit come first. |
| Array length ≤ 8192 | crates/value/src/array.rs | done (#35) | In a write, "Invalid argument \`value\` for \`db.<method>\`: …", as the syscall parses it; objects over 1024 fields too. Function arguments too, before the call (DV-439): "Invalid arguments for <path>: …", a nested call's "Invalid argument \`args\` for \`runUdf\`: …", the scheduler's, and a system function's "Uncaught Error: Invalid arguments: …" (checked against Convex's local backend). |
| Object fields ≤ 1024 | crates/value/src/object.rs | done (#35) |  |
| Field name ≤ 1024 chars; identifiers (tables, indexes) ≤ 64 | sync_types/identifier.rs | done (#6, #21) |  |
| Function args ≤ 16 MiB; function result ≤ 16 MiB | knobs.rs (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`) | done (STUDY-64 §1.7) | Convex's messages and order (args size before the validator; result size before `returns`); the same knobs. `_system/` functions: 24 MiB (`SYSTEM_FUNCTION_MAX_RESULT_SIZE`, STUDY-147). The WS frame cap is 16 MiB, as Convex's. No 80 % warnings yet. |
| Reads per transaction ≤ 32,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_READ_SIZE_ROWS/BYTES`) | done (#12) | 32,000 documents and 16 MiB, Convex's messages. |
| Read-set intervals (database queries) ≤ 4096 per transaction | knobs.rs (`TRANSACTION_MAX_READ_SET_INTERVALS`); database/src/reads.rs | done (#12; STUDY-161 §16) | 4096, Convex's message. Counted as Convex counts them: per index the merged intervals the function read (a document read again, a patch of a document read, adjacent or overlapping ranges add nothing), the engine's own reads (table and index metadata, a new document's id, a search's terms) not counted, Convex's reads at a function's start (its configuration, environment and modules; a component's function one more, its modules its own, STUDY-161 §16.7), at a table's creation and at the first nested call (its callee's start: two, one more from or into another namespace, the callee's modules; STUDY-161 §16.7) counted. What subscriptions and OCC see is unchanged. |
| Writes per transaction ≤ 16,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_NUM_USER_WRITES`, `…WRITE_SIZE_BYTES`) | done (#35) | |
| Query/mutation user execution time ≤ 1 s (`DATABASE_UDF_USER_TIMEOUT`) | knobs.rs | done (STUDY-41) | User time is wall time minus the time awaiting the store and nested calls (each nested call has its own budget); Convex's message ("Function execution timed out (maximum duration: 1s)"), not catchable, a mutation commits nothing; the 15 s system budget with Convex's message; `DATABASE_UDF_USER_TIMEOUT_SECONDS` / `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS`. Checked at store calls and at the end: a synchronous loop that never reaches the store is not interrupted (DV-208). |
| Action timeout (V8 1800 s knob default here; Node 600 s; Convex cloud documents 10 min) | knobs.rs (`V8_ACTION_USER_TIMEOUT`, `NODE_ACTION_USER_TIMEOUT`) | done (STUDY-77) | Same knobs and messages; awaited calls count; after it, `ctx` calls and `fetch` are refused and in-flight fetches aborted. A V8 action also ends with its answer, as Convex's isolate (STUDY-77 §7, owner 2026-10-21): the timers its code left are cleared, and its `ctx` and `fetch` refuse afterwards ("the action has ended: its operations can no longer run"); what was in flight goes on. |
| The `N unawaited operations: [...]` warning for an action's pending calls when it ends or times out | isolate/src/environment/action/mod.rs (`add_warnings_to_log_lines`) | done (STUDY-76, STUDY-143) | Convex's text (no docs link, DV-04), code `UnawaitedOperations`, names sorted with their counts summed; what counts as Convex's tasks: `ctx`'s calls, `ctx.meta`, `createFunctionHandle`, `log.audit`, `fetch`, `storage.store` / `get`, a multipart `formData()`, not timers. An answer is handed over in a later turn, as Convex's, so a call left unawaited is listed even if it answered at once; a timed-out action lists what was pending then; an HTTP action, once its body is sent. Checked against Convex's binary. |
| Isolate heap ≤ 64 MiB; ArrayBuffers ≤ 64 MiB | knobs.rs | n/a (DV-164) | No isolates: deployed code runs in `vm` contexts in the server's process. |
| Log lines ≤ 256 per execution, ≤ 32 KiB each | isolate/src/environment/helpers/mod.rs | done (STUDY-20) | See §7. |
| Scheduling: 1000 per transaction, 4 MiB per job, 16 MiB total | knobs.rs | done (STUDY-30) | 1000 per transaction and 16 MiB total enforced; the 4 MiB per job is only a warning in Convex, and bunvex does not warn yet. |
| Files per transaction: 10 read / 10 written, 16 MiB each way | knobs.rs | done (STUDY-32) | As Convex: declared but never enforced, so none here (§13). |
| Search: 16 terms, ≤1024 results; vector: ≤256 results, 2–4096 dimensions, ≤64 filter length | crates/search/src/constants.rs; crates/vector/src/lib.rs | done (STUDY-45, STUDY-51) | Search: 16 terms, ≤1024 candidates; vector: ≤256 results, 2–4096 dimensions, ≤64 filter conditions. |
| `runQuery` / `runMutation` call depth ≤ 8 | knobs.rs (`MAX_REACTOR_CALL_DEPTH`) | done (STUDY-41) | See §6: Convex's limit and message. |
| OCC retries for mutations (4 by default) | knobs.rs | done (STUDY-21) | |

---

### Summary counts

| Status | Count |
|---|---|
| done | 244 |
| partial | 3 |
| missing | 0 |
| n/a (a decided divergence) | 1 |
| **total** | **248** |

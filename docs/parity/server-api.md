## Parity inventory: server-side function and database API

Scope: everything an app can call or rely on from inside its functions: `ctx.db`, the query builder, function builders and contexts, validators and value types, schema, auth/storage/scheduler/crons/HTTP, components, errors, and the documented limits.

- **Convex reference:** `convex-backend` @ `4577b9031`. JS paths are relative to `npm-packages/convex/src/` and Rust paths to `crates/`.
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
| `db.query(table)` returns a QueryInitializer | server/query.ts | done (#40) | An immutable chain, as Convex's (STUDY-16): each operator returns a new query; `withIndex` / `withSearchIndex` / `fullTableScan` only on the initializer (DV-06: a bunvex message, not a `TypeError`). |
| `db.normalizeId(table, idString)` | impl/database_impl.ts (`1.0/db/normalizeId`) | done (#44) | Legacy v4/v5 id formats are not accepted (no legacy data). |
| `db.system.get` / `db.system.query` / `db.system.normalizeId` for system tables (read-only) | impl/database_impl.ts | done (STUDY-30, STUDY-32) | `_scheduled_functions` and `_storage`, in their public shapes with `by_id` / `by_creation_time`. |
| User vs system table separation: `_`-prefixed tables only via `db.system`, and system tables are read-only | impl/database_impl.ts | partial (STUDY-30) | `ctx.db` refuses `_`-prefixed tables and `db.system` reads the public ones, but the message is bunvex's ("System table … is not accessible here."), not Convex's ("System tables can only be accessed with db.system." / "System tables (prefixed with `_`) are read-only."). |
| `db.table(name)` scoped reader (`.get(id)`, `.query()`), the newer "WithTable" API | server/database.ts (`GenericDatabaseReaderWithTable`) | done (STUDY-66) | Each method is the two-argument form with the table, after Convex's argument checks; a reader in a query (and in a query a mutation runs), `db.system.table(name)` too. The `…WithTable` types (`GenericQueryCtxWithTable`, `QueryBuilderWithTable`, …) as Convex's; as there, the default `ctx.db` type does not list `table`. |
| Typed database interfaces: `GenericDatabaseReader<DataModel>` / `GenericDatabaseWriter`, `QueryInitializer`, `IndexRangeBuilder` (index fields in order), `FilterBuilder` (field paths, typed `eq`/`lt`/arithmetic) | server/database.ts, server/query.ts, server/index_range_builder.ts, server/filter_builder.ts | done (STUDY-36) | In `@bunvex/core` (`database-types.ts`), types over the runtime transaction; `db.system` typed with `_scheduled_functions` / `_storage`. The contexts take them in the typed-functions PR. |
| Queries see a consistent snapshot (serializable reads) | crates/database | done | MVCC snapshot at `visibleTs`. |
| A mutation's queries see its own writes (merged in index order) | crates/database/src/transaction_index.rs | done | Pending-entry B-tree merge per index. |
| Read-set tracking for reactivity/OCC ends at the last key actually read | crates/database/src/reads.rs, crates/database/src/query/index_range.rs | done | As Convex since #134 (DV-57): up to the last key read, inclusive (desc: from it), the whole range once a scan runs out ([STUDY-06 §9](../study/STUDY-06-transactions-and-occ.md#9-d3-as-built-the-read-set-ends-at-the-last-key-read)). |

### 2. Query builder: withIndex, filter, order, terminal operations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.withIndex(name)` with no range (whole index) | server/query.ts, impl/query_impl.ts | done | |
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
| Filter arithmetic `add` / `sub` / `mul` / `div` / `mod` / `neg` | filter_builder.ts | done (#37) | |
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
| `.count()` (internal, not public) | impl/query_impl.ts | missing | Low priority. |
| `.withSearchIndex(name, q => q.search(field, text).eq(filterField, v))` | server/search_filter_builder.ts | done (STUDY-45) | `SearchFilterBuilder` (`search` then `eq`s, single use), Convex's checks of the index and filters; the index is in memory, rebuilt at start (DV-227, DV-228). |
| Search results come in relevance order (order can't be set), with prefix matching on the last term | impl/query_impl.ts; crates/search | done (STUDY-45) | BM25 ranking in relevance order, `order()` refused; the last term also matches as a prefix (DV-231). Reactive, with Convex's search read set (DV-230). |
| Search limits: 16 query terms, 32-char term max, ≤8 filter conditions, ≤1024 results | crates/search/src/constants.rs | done (STUDY-45) | 16 query terms, tokens of 32+ bytes dropped (DV-229), ≤8 `eq` conditions, ≤1024 candidates ("Search query scanned too many documents"). |

### 3. Pagination

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.paginate({ numItems, cursor })` returns `{ page, isDone, continueCursor }` | server/pagination.ts, impl/query_impl.ts | done (#42) | See STUDY-17 §4. |
| `numItems` must be > 0 and ≤ 32000 (`TRANSACTION_MAX_READ_SIZE_ROWS`) | isolate/src/environment/udf/async_syscall.rs | done (#42) | Convex's messages ("must be a positive number", "Requested too many items"). |
| Opaque, encrypted cursors (`cursor: null` starts at the beginning) | async_syscall.rs (`key_broker.encrypt_cursor`) | done (DV-73) | Sealed as Convex's keybroker: AES-128-GCM-SIV under KBKDF(secret, "cursor"), version 7, hex (`cursor.ts`). |
| `endCursor` pins the page end so a reactive page keeps its boundaries on re-run (taken from the query journal) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `maximumRowsRead` / `maximumBytesRead` (must be > 0) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `splitCursor` + `pageStatus` (`"SplitRecommended"` / `"SplitRequired"`) | pagination.ts | done (#42) | See STUDY-17 §4. |
| Only one paginated query per query or mutation (`MultiplePaginatedDatabaseQueries`) | async_syscall.rs | done (#42) | A second `paginate()` in one function throws Convex's message. |
| `paginate()` isn't supported inside components | async_syscall.rs | missing | Components are phase 4. |
| `paginationOptsValidator` and `paginationResultValidator(item)` helpers | server/pagination.ts | done (#42) | See STUDY-17 §4. |

### 4. Database writer: `ctx.db` in mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.insert(table, value)` returns `Id<table>` | server/database.ts, impl/database_impl.ts | done (#21, #29) | Values validated at the call, and against the schema. |
| A write to a table that does not exist creates it (in the same transaction); reads of a missing table return nothing | database/src/bootstrap_model/table.rs (`insert_table_metadata`) | done (#33) | Reads depend on `_tables`, so they re-run when the table is created. |
| `insert` rejects system tables (names starting with `_`) | impl/database_impl.ts | done (#6) | "System table … is not accessible here." |
| `insert` assigns `_id` and `_creationTime` and rejects caller-supplied values that don't match | crates/common/src/document.rs | done (#21) | A caller-supplied `_id` / `_creationTime` that does not match throws Convex's message; other `_`-prefixed fields are refused. |
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
| Writes are validated against the schema when `schemaValidation` is on | crates/common/src/schemas | done (#29) | |

### 5. Function builders and registration

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `query`, `mutation`, `action` (public) | impl/registration_impl.ts | done (#25) | A handler, or `{ args, returns, handler }`; args typed from the validators. |
| `internalQuery`, `internalMutation`, `internalAction` | impl/registration_impl.ts | done (#25) | |
| Object form `{ args, returns, handler }` | server/registration.ts (`ValidatedFunction`) | done (#25) | |
| `args` validation (an object of validators, or `v.object`), with extra fields rejected | impl/registration_impl.ts (`exportArgs`); runtime in crates | done (#25) | As Convex's `check_args` (STUDY-67 H6): the error is the message alone (no `Uncaught`, no frames, two trailing newlines), for a caller function too; a validated function refuses a non-object (`Instead received: 5.0`) and, over HTTP, an `args` array of other than one; a function without a validator gets whatever came. Over the sync protocol, extra array elements are still dropped. |
| `returns` validation | impl/registration_impl.ts (`exportReturns`) | done (#25) | An object of validators is `v.object` of them, as for `args` (STUDY-36). Its error is Convex's `ReturnsValidationError: …` alone, no `Uncaught`, no frames (STUDY-67 H6). |
| Args are always a single object (defaults to `{}`) | server/registration.ts | done | `args ?? {}`. |
| Handler returning `undefined` becomes `null` on the wire | impl/registration_impl.ts | done | `value ?? null`. |
| Function names `"dir/module:export"`; a `default` export omits `:export` | server/api.ts (`getFunctionName`) | done (STUDY-35) | Pushed modules are analyzed by file: `dir/module:export`, and a `default` export is `dir/module`. |
| `api` / `internal` function references (`anyApi`, codegen), `makeFunctionReference`, `getFunctionName`, `filterApi` | server/api.ts | partial (STUDY-26, STUDY-36) | `anyApi`, `makeFunctionReference`, `getFunctionName` and codegen's `api` / `internal`; references accepted everywhere a name is. The runtime `filterApi` helper is missing (the `FilterApi` type exists). |
| Typed `FunctionArgs` / `FunctionReturnType`, `ApiFromModules`, `FilterApi`, `FunctionReferenceFromExport` | server/api.ts | done (STUDY-36) | `_generated/api.d.ts` (codegen PR) builds `api` / `internal` with them; `FunctionReference_future` is missing. |
| Generic builders (`queryGeneric` etc.) and typed `_generated/server` builders bound to the DataModel | impl/registration_impl.ts; codegen | done (STUDY-36) | `queryGeneric` … `httpActionGeneric`, `QueryBuilder<DataModel, Visibility>` …, `GenericQueryCtx` / `GenericMutationCtx` / `GenericActionCtx`, `RegisteredQuery` … typed from the validators; codegen writes `_generated/server` bound to the DataModel. Convex's markers at run time (`isQuery`, `isPublic`, …), with `isBunvexFunction` for `isConvexFunction` (rule 5). |
| Warning when a registered function is called directly | impl/registration_impl.ts (`dontCallDirectly`) | done (STUDY-66) | A registered function is callable: it warns (the caller's log line) and runs its handler, as Convex's; bunvex's wording, no docs link. |
| Guard against importing functions in a browser | impl/registration_impl.ts (`assertNotBrowser`) | done (STUDY-66) | `console.error` when defined in a real browser (native `window` getter); the opt-out is `window.__bunvexAllowFunctionsInBrowser` (the naming rule). |
| `exportArgs()` / `exportReturns()` metadata, used by the dashboard and codegen | impl/registration_impl.ts | partial (STUDY-35) | The push analysis records each function's `args` / `returns` validator JSON (Convex's `AnalyzedFunction`), for the dashboard and `_system` functions; the `exportArgs()` / `exportReturns()` methods on a registered function are missing. |

### 6. Function contexts

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| QueryCtx `{ db, auth, storage (reader), runQuery, meta }` | server/registration.ts | done | `db`, `auth`, `storage`, `runQuery` (STUDY-41), `meta` (STUDY-44). |
| MutationCtx `{ db, auth, storage (writer), scheduler, runQuery, runMutation, meta }` | server/registration.ts | done | `db`, `auth`, `storage`, `scheduler`, `runQuery`, `runMutation` (STUDY-41), `meta` (STUDY-44). |
| ActionCtx `{ runQuery, runMutation, runAction, scheduler, auth, storage (action writer), vectorSearch, meta }` | server/registration.ts | done | `runQuery`, `runMutation`, `runAction` (by reference or name, internal ones included), `auth`, `scheduler`, `storage`, `vectorSearch` (STUDY-51), `meta` (STUDY-44). |
| `ctx.runQuery` from a query or mutation: same transaction, with validation | impl/registration_impl.ts | done (STUDY-41) | In the caller's transaction (its writes, identity, time; reads joining its read set), after the path, kind and arguments are checked with Convex's messages; internal functions allowed; returns checked after; errors catchable, as Convex's `JsError` display ("Uncaught Error: …" and the nested frames; `BunvexError` data kept), a store failure not catchable (DV-205, DV-209 resolved). Nested calls from one function run one at a time (DV-207). |
| `ctx.runMutation` from a mutation: a sub-transaction that rolls back if it throws | impl/registration_impl.ts | done (STUDY-41) | `Tx.begin` / `rollback` (copy-on-write index trees): a failed nested mutation's writes and created tables are undone, its reads kept; the caller may catch and commit. A failed returns check keeps the writes, as Convex. |
| `ctx.runQuery` / `ctx.runMutation` from an action: each is its own transaction | impl/actions_impl.ts | done | Each its own transaction; by reference or name, internal functions allowed. |
| `ctx.runAction` from an action | impl/actions_impl.ts | done (STUDY-31) | By reference or name; internal functions allowed. |
| `runQuery` option `useStaleSnapshot` (mutations only) | server/registration.ts (`AdvancedRunQueryOptions`) | done (STUDY-41) | A query at the transaction's snapshot, without its pending writes, its reads discarded; refused from a query with Convex's message. |
| `transactionLimits` option on `runQuery` / `runMutation` (bytesRead, documentsRead/Written, databaseQueries, functionsScheduled, files…) | server/meta.ts, registration.ts | done (STUDY-41) | Documents and bytes read and written, database queries (read-set intervals), functions scheduled and their argument bytes, as Convex (usage so far plus the budget, never above the current limit; restored after; scheduling usage not given back by a rollback, as Convex). The file limits are accepted and never reached, as in Convex, which does not count them (DV-206 resolved). |
| Maximum nesting of `runQuery`/`runMutation` calls (`MAX_REACTOR_CALL_DEPTH` = 8) | knobs.rs | done (STUDY-41) | 8 levels below the top function; Convex's message. |
| `ctx.meta.getFunctionMetadata()` (name, componentPath, type, visibility) | server/meta.ts | done (STUDY-44) | The stripped path (`dir/module:fn`, a default export `dir/module`), `componentPath` `""`, the kind and visibility; an HTTP action is `http`, public, as Convex's `http.js:default`. |
| `ctx.meta.getTransactionMetrics()` (used/remaining per limit) | server/meta.ts | done (STUDY-44) | Queries and mutations; `remaining` against the current (a nested call's lowered) limit; the internal file metrics `used: 0` and Convex's defaults, as Convex never counts them. |
| `ctx.meta.getDeploymentMetadata()` | server/meta.ts | done (STUDY-44) | As self-hosted Convex: the instance name, `region: null`, `class: "s16"`. |
| `ctx.meta.getRequestMetadata()` (ip, userAgent, requestId, scheduledFunctionId, authToken) | server/meta.ts | done (STUDY-44) | Mutations and actions (HTTP actions too), not queries; `ip` the first `x-forwarded-for` entry else the connection's address, over HTTP and the sync protocol; a new request id per call, shared with the functions it calls; a scheduled function's id down its call tree; the user's raw token (null for an admin key). |
| `ctx.meta.getSnapshotTs()` (bigint, on the same clock as commitTs) | server/meta.ts; isolate syscall.rs | done (STUDY-44) | The snapshot in nanoseconds, synchronous, shared with nested calls; it makes a query time-dependent, as `Date.now()`. `commitTs` is STUDY-53. |
| `ctx.vectorSearch(table, index, { vector, limit, filter })` returns `[{ _id, _score }]` (actions only) | server/vector_search.ts | done (STUDY-51) | Convex's checks and messages (limit ≤256, filter on `filterFields`, ≤64 conditions, dimensions). Exact search in memory, rebuilt at start (DV-269, DV-270); no bootstrap retries (DV-271). |

### 7. Deterministic runtime and execution environment

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `Date.now()` / `new Date()` frozen at the start of a query or mutation | crates/isolate/src/environment/udf/phase.rs | done | Via AsyncLocalStorage (determinism.ts). Floored at the snapshot (rounded up to the ms), as `CreationTime::for_transaction`, so a clock behind the stored timestamps after a restart never gives a `Date.now()` or `_creationTime` below what the transaction read (STUDY-06 §3). |
| `Math.random()` seeded per execution | isolate/src/environment/udf | done | sfc32 PRNG. |
| `performance.now()` fixed in queries, incrementing in mutations, rounded down to 0.1 ms | isolate/src/environment/udf/phase.rs, helpers/performance.rs, ops/time.rs | done | `performance.timeOrigin` is the process's, not the module import time (STUDY-03 D3). |
| `fetch`, timers and `crypto.getRandomValues` throw in queries and mutations ("NoXInQueriesOrMutations") | isolate/src/environment/udf/mod.rs (`not_allowed_in_udf`) | done (STUDY-66) | As Convex's isolate: `fetch()` rejects and timers return then fail the function (uncatchable), with Convex's "Can't use … in queries and mutations. Please consider using an action." (no docs link); `crypto.getRandomValues` / `randomUUID` are **allowed**, from a stream fixed per execution (AES-CTR, as strong as Convex's ChaCha12); `crypto.subtle`'s randomness (`generateKey`, RSA-OAEP `encrypt`, RSA-PSS / ECDSA `sign`) is refused. Not a sandbox: captured globals escape. |
| `Date` / `Math.random` at module import time | udf/phase.rs | done (STUDY-35) | Convex's import phase: `Math.random` seeded and `Date.now()` fixed by the deployment, `performance.now()` 0; fetch and timers fail with Convex's "… unsupported at import time" (a timer after it returns), `crypto.getRandomValues` / `randomUUID` draw from a stream keyed by the deployment, and `crypto.subtle`'s randomness fails with "Cannot use cryptographic randomness at import time" (STUDY-66 §4). |
| Actions run with the real globals (`fetch`, timers) | isolate/src/environment/action | done | |
| Function isolation (per-function V8 isolate, memory cap `ISOLATE_MAX_USER_HEAP_SIZE` = 64 MiB) | knobs.rs; isolate | partial (STUDY-35) | Deployed code runs in one `vm` context per code version (DV-164): its own globals and deterministic `Date`/`Math`, imports limited to `bunvex/*` and the bundle (Node builtins only in `"use node"`), freed when superseded. Not a security boundary; no heap cap. Module state lasts the version (DV-165). |
| `process.env` environment variables available to functions (name ≤ 256, value ≤ 8 KiB) | common/src/types/environment_variables.rs | done (STUDY-37) | Pushed code reads the deployment's variables, each read in the read set; see [platform §env](platform.md). Managed over HTTP; the CLI's `bunvex env` comes next. |
| `console.log` / `info` / `warn` / `error` captured as function logs (≤256 lines, ≤32 KiB each) | isolate/src/environment/helpers/mod.rs | done (STUDY-20) | Also `debug`, `trace`, `time`/`timeLog`/`timeEnd`, rendered with object-inspect as Convex does. A retried mutation keeps only the committed attempt's lines. Engine objects (`ctx.db`, a query, `ctx.db.system`, a table scope) print as `Name {…}`, never their state (STUDY-20 D9, DV-321). Cached query results carry no lines (STUDY-20 D2). |
| `log.audit(body)` + `log.vars` (requestId, ip, userAgent, now, convexActor) | server/log.ts, audit_logging.ts, logVars.ts | missing | New Convex feature. |
| `getServiceToken("ai-gateway")` / `getServiceUrl` | impl/actions_impl.ts | missing | Convex-cloud specific, probably out of scope. |
| Node runtime actions (`"use node"`) | CLI / node-executor | done (STUDY-35) | **Divergence (DV-87, DV-169):** the directive is accepted and those modules run in Bun itself, with Node builtins; Convex's rules for them enforced (only actions; not `http`, `crons`). No separate Node action timeout (§19). |
| Query result caching keyed by args and identity, invalidated by read-set | crates/application cache | done (STUDY-08 §3.6) | As Convex (DV-63): keyed by name, canonical args and (when read) identity; an LRU bounded by bytes (`UDF_CACHE_MAX_SIZE`, 100 MiB); identical concurrent calls coalesced, HTTP included; validated against the write log when looked up, at any later ts (`query_at_ts` too); clock readers expire after 17 s. Sync subscriptions keep their own shared executions (DV-09). Decided, internal: a hit writes its token back (DV-153). |

### 8. Validators (`v`) and value types

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `v.id(table)` | values/validator.ts | done (#24) | Checks the id names the table (catalog lookup). |
| `v.null()` | values/validator.ts | done (#24) | |
| `v.number()` / `v.float64()` | values/validator.ts | done (#24) | |
| `v.bigint()` / `v.int64()` | values/validator.ts | done (#24) | |
| `v.boolean()` | values/validator.ts | done (#24) | |
| `v.string()` | values/validator.ts | done (#24) | |
| `v.bytes()` (ArrayBuffer) | values/validator.ts | done (#24) | |
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
| Undefined-validator error (catches circular imports) | validators.ts; registration_impl.ts (`strictReplacer`) | done (#24) | |
| Value `null` | values/value.ts | done | JSON. |
| Value `boolean` | values/value.ts | done | |
| Value `string` | values/value.ts | done | |
| Value `number` (float64), including NaN, ±Infinity and −0 | values/value.ts (`$float` encoding) | done (#21) | NaN, ±Infinity and −0 kept (the `$float` encoding); −0 sorts below +0. |
| Value `bigint` (int64, range-checked) | values/value.ts | done (#21) | Range-checked to int64; `$integer` encoding. |
| Value `ArrayBuffer` (bytes) | values/value.ts | done (#21) | `$bytes` encoding; copied at the call. |
| Value arrays and plain objects | values/value.ts | done (#21) | Stored and index-keyable, in Convex's order (B11). |
| `undefined` isn't a value (error at a path); `undefined` object fields are dropped | values/value.ts (`convexToJsonInternal`) | done (#21) | `toJsonValue` refuses `undefined` with a path and drops `undefined` fields. |
| Only plain objects allowed (class instances rejected) | values/value.ts (`isSimpleObject`) | done (#21) | Class instances, `Map` and `Set` refused ("… is not a supported value type", Convex's message structure without "Convex"). The message names a class instance (`Point {…}`) without opening it (DV-316, decided by the owner 2026-10-03). |
| Wire encoding `convexToJson` / `jsonToConvex` (`$integer`, `$bytes`, `$float`) | values/value.ts | done (#21) | As `toJsonValue` / `fromJsonValue` (no "convex" in bunvex's public names). |
| `Id<T>` / `GenericId` branded string type | values/value.ts | done (STUDY-36) | `GenericId<T>` in `@bunvex/values`; `v.id(t)` infers it; `_generated/dataModel` names it `Id<T>` (codegen PR). |
| `compareValues`, `getConvexSize`, `getDocumentSize`, `Base64` utilities | values/compare.ts, size.ts, base64.ts | partial (#21) | `compareValues` and `valueSize` (Convex's `getConvexSize`) are exported by `@bunvex/values`; `getDocumentSize` and `Base64` are missing. |
| `ConvexError(data)`: `data` is any Convex value and reaches the client as `errorData` | values/errors.ts; registration_impl.ts | done (STUDY-20) | As `BunvexError` (owner's decision). HTTP `errorData`, WebSocket `d`. |

### 9. Value ordering (index order and filter comparisons)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Cross-type order: undefined < null < int64 < float64 < boolean < string < bytes < array < object | crates/value/src/sorting.rs | done (#21) | Convex's sort keys (STUDY-18): undefined < null < int64 < float64 < boolean < string < bytes < array < object (DV-34 resolved). |
| float64 total order (`total_cmp`: −NaN < −∞ < … < −0 < +0 < … < +∞ < NaN) | sorting.rs | done (#21) | IEEE total order; −0 < +0. |
| int64 ordered numerically and separately from float64 (1n ≠ 1) | sorting.rs | done (#21) | Its own tag below float64. |
| Strings ordered by UTF-8 bytes | sorting.rs; values/compare_utf8.ts | done | Escaped, 0x00-terminated UTF-8 in keyenc. |
| Bytes ordered lexicographically | sorting.rs | done | Tag exists. The `_id` tiebreaker uses it. |
| Arrays ordered element-wise; objects by (field, value) pairs in field order | sorting.rs | done (#21) | Array and object tags; objects by sorted field names. |
| Missing index fields sort as `undefined`, which is distinct from `null` | sorting.rs (`write_sort_key_or_undefined`) | done (#21) | `undefined` below `null` (B6). |

### 10. System fields and document shape

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `_id` on every document | server/system_fields.ts | done (#7) | A Convex-format id. |
| `_creationTime` (float64 ms since epoch) | system_fields.ts; common/src/document.rs | done | |
| Types `WithoutSystemFields`, `WithOptionalSystemFields`, `SystemFields`, `IdField`, `Doc<T>` | system_fields.ts; codegen | done (STUDY-36) | In `@bunvex/core` (`data-model.ts`); `Doc<T>` comes with `_generated/dataModel`. |
| Top-level user fields can't start with `_` | crates/common/src/document.rs (validate) | done (#21) | Refused at write: "Field '…' starts with an underscore, which is only allowed for system fields like '_id'". |
| Field names: ≤1024 chars, non-control ASCII, no leading `$` | crates/convex/sync_types/src/identifier.rs; values/value.ts | done (#21) | `validateObjectField`, with the same messages. |
| Documents must be objects | common/src/document.rs | done (#21) | A non-object write value throws ("expected an object"). |

### 11. Schema

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineSchema({ table: defineTable(...) })` | server/schema.ts | done (#29) | |
| `defineTable(validatorFields \| v.object \| v.union of objects \| v.any)` | server/schema.ts | done (#29) | |
| `.index(name, [fields])` | server/schema.ts | done (#29) | `defineTable(...).index(name, fields)`. |
| `.index(name, { fields, staged })`: staged indexes that don't block a push | server/schema.ts | done (STUDY-29) | `{ fields, staged: true }`: backfilled in the background, not enabled until un-staged; a query on it gets Convex's error. |
| `.searchIndex(name, { searchField, filterFields, staged })` | server/schema.ts | done (STUDY-45) | Convex's push-time checks and messages; `staged` too. |
| `.vectorIndex(name, { vectorField, dimensions, filterFields, staged })` | server/schema.ts | done (STUDY-51) | Convex's push-time checks and messages; `staged` too. The vector field is not checked against the document schema (DV-272). |
| `.staged(validator)`: staged document validator, checked in the background | server/schema.ts | missing | New. |
| `schemaValidation` option (default true) | server/schema.ts | done (#29) | |
| `strictTableNameTypes` option (type-level) | server/schema.ts | done (STUDY-36) | `false` adds `AnyDataModel` to the data model: any other table name is allowed. |
| `schema.doc(table)` / `schema.id(table)` / `docValidator()` helpers | server/schema.ts | done (STUDY-66) | Convex's validators and types (`DocValidator`), and its error for a table the schema does not have; `TableDefinition.validator` too. |
| `schema.tables` is the record of `TableDefinition`s (`schema.tables.messages.validator`) | server/schema.ts | missing (STUDY-66 §6) | bunvex's `schema.tables` is a `Map` of the engine's declared tables, so Convex's `docValidator("messages", schema.tables.messages)` does not work; `schema.doc("messages")` does. |
| Pushing a schema validates existing documents against it | crates/model / schema worker | done (STUDY-35) | A pushed schema is pending until existing documents are checked: the first that does not match fails the push, named as Convex's; writes meanwhile fail the pending schema. |
| Index backfill when an index is added to an existing table | crates/database/src/database_index_workers | done (STUDY-29) | In the background, as Convex: a worker, `backfilling` → `backfilled` → `enabled`, checkpoints and resume (DV-54 resolved; DV-126, DV-127). |
| Table names: identifier ≤64, starts with a letter, `[A-Za-z0-9_]`; `_` prefix reserved | sync_types/identifier.rs; index_validation_error.rs | done (#6) | Convex's identifier rule; a leading `_` is reserved for system tables. |
| Index names: identifier; not `by_id` / `by_creation_time` / `_`-prefixed; unique per table | index_validation_error.rs | done (#6) | Reserved and repeated names of database indexes fail in `defineSchema` with Convex's messages, naming the table (STUDY-65 M1). |
| Index fields: ≥1 field, ≤16 fields, unique, no `_id` / `_creationTime`, no `_`-prefixed fields | index_validation_error.rs; bootstrap_model/index/mod.rs | done (STUDY-65 M1) | In `defineSchema`, in Convex's order and with its messages (`IndexFieldsContainId`, `IndexFieldsContainCreationTime` without its docs link, `IndexFieldNameReserved`, `FieldsNotUniqueWithinIndex`, `IndexTooManyFields`, `EmptyIndex`). As Convex, 16 fields are refused too: `_creationTime` is appended before the last count. |
| No two indexes with identical fields on a table | index_validation_error.rs | done (STUDY-45, STUDY-51, STUDY-65 M1) | Checked for search indexes (same `searchField` and filter fields), vector indexes and database indexes (staged ones included), with Convex's messages. |
| ≤64 indexes per table (`MAX_INDEXES_PER_TABLE`) and ≤10,000 tables | common/src/schemas/mod.rs; database/src/bootstrap_model/table.rs | partial (STUDY-45) | ≤64 indexes per table (database, search and vector together) checked in `defineSchema`; no 10,000-table limit. |
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
| `storage.getUrl(id)` (queries, mutations, actions) | server/storage.ts | done (STUDY-32) | `{cloud origin}/api/storage/<uuid>`; reactive in queries and mutations. |
| `storage.getMetadata(id)` (deprecated in favour of `db.system.get("_storage", id)`) | server/storage.ts | done (STUDY-32) | `{storageId: uuid, sha256: hex, size, contentType}`. |
| `storage.generateUploadUrl()` (mutations, actions) + HTTP POST upload returning `{ storageId }` | server/storage.ts | done (STUDY-32) | Tokens valid for an hour, reusable. |
| `storage.delete(id)` (mutations, actions) | server/storage.ts | done (STUDY-32) | Transactional; a missing file throws; the blob goes after commit (F3). |
| `storage.store(blob, { sha256 })` (actions; the mutation variant is internal/unreleased) | server/storage.ts; async_syscall.rs | done (STUDY-32) | In mutations: Convex's "not supported" error. |
| `storage.get(id)` returns `Blob` (actions only) | server/storage.ts | done (STUDY-32) | Actions and HTTP actions. |
| `_storage` system table `{ sha256, size, contentType? }` | server/schema.ts (`_systemSchema`) | done (STUDY-32) | Through `db.system`; `contentType` null when absent (F1, DV-148). |
| Per-transaction file limits: 10 files / 16 MiB written, 10 files / 16 MiB read | knobs.rs | done (STUDY-32) | As Convex: declared there but never enforced, so none here. |

### 14. Scheduler (`ctx.scheduler`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `scheduler.runAfter(ms, fnRef, args)` returns `Id<"_scheduled_functions">` | server/scheduler.ts | done (STUDY-30) | Typed since STUDY-36: a reference's arguments, and the id. |
| `scheduler.runAt(timestamp \| Date, fnRef, args)` | server/scheduler.ts | done (STUDY-30) | |
| `scheduler.cancel(id)` | server/scheduler.ts | done (STUDY-30) | |
| Scheduling from a mutation is transactional (only if the mutation commits); from an action it isn't | docs; crates/model scheduled_jobs | done (STUDY-30) | |
| Scheduled mutations run exactly once, scheduled actions at most once | crates/application scheduled_jobs | done (STUDY-30) | |
| `_scheduled_functions` system table (name, args, scheduledTime, completedTime, state pending/inProgress/success/failed/canceled) | server/schema.ts | done (STUDY-30) | Read through `db.system.get` / `db.system.query`. |
| Limits: 1000 scheduled per transaction, 16 MiB total args, 4 MiB per job's args; retention 7 days | knobs.rs | done (STUDY-30) | The 4 MiB per job is only a warning in Convex; bunvex does not warn yet. |
| Only mutations and actions (public or internal) can be scheduled | server/scheduler.ts | done (STUDY-30) | Checked when the job runs, as Convex. |

### 15. Crons

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `cronJobs()` + `export default crons` in `crons.ts` | server/cron.ts | done (STUDY-35) | The default export of the pushed `crons.ts`, as Convex (checked at push); or `createServer({ crons })`. |
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
| `httpAction(async (ctx, request) => Response)` with an ActionCtx | impl/registration_impl.ts (`httpActionGeneric`) | done (STUDY-31) | Served on `/http/*` and the site port. |
| `httpRouter()` + `http.route({ path, method, handler })` in `http.ts` | server/router.ts | done (STUDY-31) | The default export of the pushed `http.ts` (STUDY-35), or `createServer({ http })` (H1, DV-143). |
| `http.route({ pathPrefix: "/x/", … })` prefix routes, longest prefix wins | server/router.ts | done (STUDY-31) | |
| Methods GET / POST / PUT / DELETE / OPTIONS / PATCH; HEAD maps to GET | server/router.ts (`normalizeMethod`) | done (STUDY-31) | |
| Route validation: leading `/`, prefix ends with `/`, `/.files` reserved, duplicate detection | server/router.ts | done (STUDY-31) | Convex's messages, in its order; the start checks of `http.js` too. |
| `getRoutes()` / `lookup(path, method)` | server/router.ts | done (STUDY-31) | |
| Served on the separate HTTP-actions origin/port (`/.site`-style), with `defineApp({ httpPrefix })` | components/index.ts; crates/local_backend | partial (STUDY-31) | `/http/*` and the site port; `httpPrefix` waits for components. |

### 17. Components

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineComponent(name, { env })` in `convex.config.ts` | server/components/index.ts | missing | |
| `defineApp({ httpPrefix, env })` + `app.use(component, { name, httpPrefix, env })` | server/components/index.ts | missing | |
| `components.<name>.<module>.<fn>` references (`componentsGeneric`) | server/components/index.ts | missing | |
| Component env definitions with validators and env refs | server/components/index.ts (`EnvDefinition`) | missing | New. |
| `createFunctionHandle(fnRef)` returns a string handle usable in `runX` / scheduler | server/components/index.ts | done (STUDY-50) | In queries, mutations and actions; Convex's errors. |
| Isolated per-component tables, functions and data | crates (component registry) | missing | |

### 18. Errors surfaced to apps

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `throw new ConvexError(data)`, where the client receives `data` intact | values/errors.ts; impl/registration_impl.ts | done (STUDY-20, STUDY-26) | `BunvexError` (DV-03): the server sends `data` intact; the clients rethrow it with `data`. |
| Non-ConvexError errors redacted in production ("Server Error") | crates/application | done (STUDY-20) | `[Request ID: …] Server Error`, with the details unless `REDACT_LOGS_TO_CLIENT` / `redactLogsToClient` (off by default, as self-hosted Convex). |
| Typed error codes for limits (e.g. `ValueTooLargeError`, `TooManyWrites`) | crates/common/src/document.rs, database | missing | |
| `unique()` error when there are multiple results; errors for misuse of closed/chained queries | impl/query_impl.ts | done (#40) | |

### 19. Limits

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Document size ≤ 1 MiB (`MAX_USER_SIZE`, including system fields) | crates/common/src/document.rs | done (#35) | |
| Document nesting ≤ 16 levels (`MAX_DOCUMENT_NESTING`) | crates/common/src/document.rs | done (#35) | |
| Generic value (args/results) size ≤ 32 MiB and nesting ≤ 64 | crates/value/src/size.rs | missing | |
| Array length ≤ 8192 | crates/value/src/array.rs | done (#35) | |
| Object fields ≤ 1024 | crates/value/src/object.rs | done (#35) |  |
| Field name ≤ 1024 chars; identifiers (tables, indexes) ≤ 64 | sync_types/identifier.rs | done (#6, #21) |  |
| Function args ≤ 16 MiB; function result ≤ 16 MiB | knobs.rs (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`) | done (STUDY-64 §1.7) | Convex's messages and order (args size before the validator; result size before `returns`); the same knobs. The WS frame cap is 16 MiB, as Convex's. No 80 % warnings yet. |
| Reads per transaction ≤ 32,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_READ_SIZE_ROWS/BYTES`) | done (#12) | 32,000 documents and 16 MiB, Convex's messages. |
| Read-set intervals (database queries) ≤ 4096 per transaction | knobs.rs (`TRANSACTION_MAX_READ_SET_INTERVALS`) | done (#12) | 4096, Convex's message. |
| Writes per transaction ≤ 16,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_NUM_USER_WRITES`, `…WRITE_SIZE_BYTES`) | done (#35) | |
| Query/mutation user execution time ≤ 1 s (`DATABASE_UDF_USER_TIMEOUT`) | knobs.rs | done (STUDY-41) | User time is wall time minus the time awaiting the store and nested calls (each nested call has its own budget); Convex's message ("Function execution timed out (maximum duration: 1s)"), not catchable, a mutation commits nothing; the 15 s system budget with Convex's message; `DATABASE_UDF_USER_TIMEOUT_SECONDS` / `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS`. Checked at store calls and at the end: a synchronous loop that never reaches the store is not interrupted (DV-208). |
| Action timeout (V8 1800 s knob default here; Node 600 s; Convex cloud documents 10 min) | knobs.rs (`V8_ACTION_USER_TIMEOUT`, `NODE_ACTION_USER_TIMEOUT`) | missing | |
| Isolate heap ≤ 64 MiB; ArrayBuffers ≤ 64 MiB | knobs.rs | missing | |
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
| done | 213 |
| partial | 9 |
| missing | 18 |
| **total** | **240** |

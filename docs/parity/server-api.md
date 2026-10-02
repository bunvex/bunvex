## Parity inventory: server-side function and database API

Scope: everything an app can call or rely on from inside its functions: `ctx.db`, the query builder, function builders and contexts, validators and value types, schema, auth/storage/scheduler/crons/HTTP, components, errors, and the documented limits.

- **Convex reference:** `convex-backend` @ `4577b9031`. JS paths are relative to `npm-packages/convex/src/` and Rust paths to `crates/`.
- **bunvex reference:** `main` @ `f60e934` (after the read-own-writes and determinism PRs). The working tree was on `feat/core-table-metadata` at the time, with uncommitted changes to `packages/core/src/schema.ts` (identifier and reserved-name checks, a table/index catalog). Rows those changes affect say "in flight".
- **Status:** **done** means it matches Convex's behaviour; **partial** means it exists but differs (the note says how); **missing** means it isn't there.

Key bunvex facts behind the statuses:

- `@bunvex/values` is empty, so there are no validators or special value types yet.
- Documents are stored as `JSON.stringify` output.
- Ids are `crypto.randomUUID()`.
- Function definitions are bare handlers (`query(handler, internal?)`).
- Contexts carry only `db` (queries and mutations) or `runQuery`/`runMutation` (actions).

---

### 1. Database reader: `ctx.db` in queries and mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.get(table, id)`, the table-scoped form | server/database.ts, impl/database_impl.ts | done (#7) | Checks the id belongs to the table, with Convex's errors. |
| `db.get(id)`, the legacy form where the id carries its table | server/database.ts | done (#44) | The id names its table. |
| `db.get` returns `null` for a missing or deleted doc | impl/database_impl.ts | done | |
| `db.get` sees the transaction's own writes | crates/database/src/transaction.rs | done | Served from the write set. |
| `db.query(table)` returns a QueryInitializer | server/query.ts | partial | Exists and defaults to `by_creation_time` ascending. It is one mutable object rather than Convex's chain of single-use stages. |
| `db.normalizeId(table, idString)` | impl/database_impl.ts (`1.0/db/normalizeId`) | done (#44) | Legacy v4/v5 id formats are not accepted (no legacy data). |
| `db.system.get` / `db.system.query` / `db.system.normalizeId` for system tables (read-only) | impl/database_impl.ts | done (STUDY-30, STUDY-32) | `_scheduled_functions` and `_storage`, in their public shapes with `by_id` / `by_creation_time`. |
| User vs system table separation: `_`-prefixed tables only via `db.system`, and system tables are read-only | impl/database_impl.ts | partial (STUDY-30) | `ctx.db` refuses `_`-prefixed tables ("System table … is not accessible here."); `db.system` reads the public ones. Convex's exact message is not checked yet. |
| `db.table(name)` scoped reader (`.get(id)`, `.query()`), the newer "WithTable" API | server/database.ts (`GenericDatabaseReaderWithTable`) | missing | |
| Queries see a consistent snapshot (serializable reads) | crates/database | done | MVCC snapshot at `visibleTs`. |
| A mutation's queries see its own writes (merged in index order) | crates/database/src/transaction_index.rs | done | Pending-entry B-tree merge per index. |
| Read-set tracking for reactivity/OCC ends at the last key actually read | crates/database/src/reads.rs, crates/database/src/query/index_range.rs | done | As Convex since #134 (DV-57): up to the last key read, inclusive (desc: from it), the whole range once a scan runs out ([STUDY-06 §9](../study/STUDY-06-transactions-and-occ.md#9-d3-as-built-the-read-set-ends-at-the-last-key-read)). |

### 2. Query builder: withIndex, filter, order, terminal operations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.withIndex(name)` with no range (whole index) | server/query.ts, impl/query_impl.ts | done | |
| `.withIndex(name, q => …)` range expression | server/index_range_builder.ts | partial | Supports eq/gt/gte/lt/lte, but field names are ignored. It doesn't check that fields follow index order, that eq comes before range, or that there is at most one lower and one upper bound. |
| IndexRangeBuilder `eq(field, value)`, in index-field order | index_range_builder.ts | partial | Positional only; the field name isn't checked. |
| IndexRangeBuilder `gt`/`gte` then `lt`/`lte` on the next field | index_range_builder.ts | partial | Works for the common case. A mismatched field name, or bounds on different fields, silently produce a wrong range. |
| Index range on `undefined` (missing field) | crates/common/src/query.rs, value/sorting.rs | missing | bunvex maps missing fields to `null`. Convex keeps `undefined` as its own value that sorts below `null`. |
| Using `by_id` / `by_creation_time` system indexes in `withIndex` | system_fields.ts (`SystemIndexes`) | done | Both are created for every table. |
| Every user index implicitly ends with `_creationTime`, then `_id` | crates/common/src/types/index.rs; index_validation_error.rs | done (#10) | |
| `.fullTableScan()` | impl/query_impl.ts | done (#40) | |
| `.order("asc" \| "desc")` | impl/query_impl.ts | partial | Works. It doesn't reject a second `.order()` or `.order()` on a search query. |
| `.filter(q => expr)` | server/filter_builder.ts, impl/filter_builder_impl.ts | done (#37) | |
| Filter `q.field("a.b")`, including nested field paths | filter_builder.ts | done (#37) | |
| Filter comparisons `eq` / `neq` / `lt` / `lte` / `gt` / `gte`, including `undefined` | filter_builder.ts | done (#37) | |
| Filter arithmetic `add` / `sub` / `mul` / `div` / `mod` / `neg` | filter_builder.ts | done (#37) | |
| Filter logic `and` / `or` / `not` | filter_builder.ts | done (#37) | |
| Filters compare across types using the global value order | value/sorting.rs | missing | |
| At most 256 query operators per query (`MAX_QUERY_OPERATORS`) | impl/query_impl.ts; common/src/query.rs | missing | |
| `.limit(n)` (non-terminal operator on OrderedQuery) | server/query.ts | missing | |
| `.collect()` | impl/query_impl.ts | partial | bunvex silently stops at 8192 rows. Convex reads everything, up to the transaction read limits (32k rows / 16 MiB), and then throws. |
| `.take(n)`, requiring a non-negative integer | impl/query_impl.ts | partial | Works, but `n` isn't validated. |
| `.first()` | impl/query_impl.ts | done | |
| `.unique()`: returns null or the only row, and throws if there are ≥2 | impl/query_impl.ts | done (#40) | |
| Async iteration: `for await (const doc of query)` and `.next()` streaming | impl/query_impl.ts (`queryStream` / `queryStreamNext`) | done (#40) | |
| A query is single-use (reusing or rechaining it throws) | impl/query_impl.ts | missing | bunvex's query object is mutable and reusable. |
| Returning a Query object from a function throws a helpful error | impl/registration_impl.ts (`validateReturnValue`) | missing | |
| `.count()` (internal, not public) | impl/query_impl.ts | missing | Low priority. |
| `.withSearchIndex(name, q => q.search(field, text).eq(filterField, v))` | server/search_filter_builder.ts | missing | Search is phase 4. |
| Search results come in relevance order (order can't be set), with prefix matching on the last term | impl/query_impl.ts; crates/search | missing | |
| Search limits: 16 query terms, 32-char term max, ≤8 filter conditions, ≤1024 results | crates/search/src/constants.rs | missing | |

### 3. Pagination

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.paginate({ numItems, cursor })` returns `{ page, isDone, continueCursor }` | server/pagination.ts, impl/query_impl.ts | done (#42) | See STUDY-17 §4. |
| `numItems` must be > 0 and ≤ 32000 (`TRANSACTION_MAX_READ_SIZE_ROWS`) | isolate/src/environment/udf/async_syscall.rs | missing | |
| Opaque, encrypted cursors (`cursor: null` starts at the beginning) | async_syscall.rs (`key_broker.encrypt_cursor`) | missing | |
| `endCursor` pins the page end so a reactive page keeps its boundaries on re-run (taken from the query journal) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `maximumRowsRead` / `maximumBytesRead` (must be > 0) | pagination.ts; async_syscall.rs | done (#42) | See STUDY-17 §4. |
| `splitCursor` + `pageStatus` (`"SplitRecommended"` / `"SplitRequired"`) | pagination.ts | done (#42) | See STUDY-17 §4. |
| Only one paginated query per query or mutation (`MultiplePaginatedDatabaseQueries`) | async_syscall.rs | missing | |
| `paginate()` isn't supported inside components | async_syscall.rs | missing | Components are phase 4. |
| `paginationOptsValidator` and `paginationResultValidator(item)` helpers | server/pagination.ts | done (#42) | See STUDY-17 §4. |

### 4. Database writer: `ctx.db` in mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.insert(table, value)` returns `Id<table>` | server/database.ts, impl/database_impl.ts | done (#21, #29) | Values validated at the call, and against the schema. |
| A write to a table that does not exist creates it (in the same transaction); reads of a missing table return nothing | database/src/bootstrap_model/table.rs (`insert_table_metadata`) | done (#33) | Reads depend on `_tables`, so they re-run when the table is created. |
| `insert` rejects system tables (names starting with `_`) | impl/database_impl.ts | done (#6) | "System table … is not accessible here." |
| `insert` assigns `_id` and `_creationTime` and rejects caller-supplied values that don't match | crates/common/src/document.rs | partial | bunvex overwrites `_id` / `_creationTime` silently instead of rejecting them. |
| `_creationTime` is strictly increasing within a transaction, so inserts sort in insert order | crates/database/src/transaction.rs (`next_creation_time`) | done | `nextUp()` float increment, on main. |
| Convex-format document ids (base32; table number plus random bytes plus checksum; ~31–37 chars) | crates/value/src/id_v6.rs | done (#7) | Convex's format and generator exactly (STUDY-01 option C). Legacy v4/v5 formats are not accepted by `normalizeId`, since bunvex has no legacy data. |
| `db.patch(table, id, partial)`: shallow merge | server/database.ts | done (#21) | Validation, `undefined` removes a field, system fields as Convex. |
| `patch` with a field set to `undefined` removes that field | values/value.ts (`patchValueToJson`) | partial | It only works by accident: `JSON.stringify` drops the key on persist. Within the transaction, a read returns the key with the value `undefined`. |
| `patch` / `replace` / `delete` on a nonexistent id throws `NonexistentDocument` | crates/database/src/transaction.rs | partial | `patch` throws. `delete` of a missing doc is a silent no-op. |
| `db.replace(table, id, value)`: replace all non-system fields, keeping `_id` / `_creationTime` | server/database.ts | done (#35) |  |
| `db.delete(table, id)` | server/database.ts | done (#35) | Throws "Delete on nonexistent document ID …", as Convex. No legacy `delete(id)` form. |
| Legacy single-argument forms: `patch(id, v)`, `replace(id, v)`, `delete(id)` | impl/database_impl.ts | missing | Needs ids that encode their table. |
| `db.table(name)` scoped writer (`.insert` / `.patch` / `.replace` / `.delete`) | server/database.ts (`BaseTableWriter`) | missing | |
| `db.vars.commitTs` placeholder, resolved at commit to an int64 in commit order, plus `v.commitTs()` | server/database.ts; values/value.ts (`CommitTsPlaceholder`) | missing | New Convex feature. |
| Writes are atomic: all or none, and a throwing mutation commits nothing | crates/database | done | |
| Optimistic concurrency with automatic retry on conflict | crates/database; knobs `UDF_EXECUTOR_OCC_MAX_RETRIES` = 4 | done (STUDY-21) | 4 retries with 100 ms – 2 s full-jitter backoff. After them comes `OptimisticConcurrencyControlFailure` with Convex's message (without its docs link); HTTP 503. |
| Writes are validated against the schema when `schemaValidation` is on | crates/common/src/schemas | done (#29) | |

### 5. Function builders and registration

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `query`, `mutation`, `action` (public) | impl/registration_impl.ts | done (#25) | A handler, or `{ args, returns, handler }`; args typed from the validators. |
| `internalQuery`, `internalMutation`, `internalAction` | impl/registration_impl.ts | done (#25) | |
| Object form `{ args, returns, handler }` | server/registration.ts (`ValidatedFunction`) | done (#25) | |
| `args` validation (an object of validators, or `v.object`), with extra fields rejected | impl/registration_impl.ts (`exportArgs`); runtime in crates | done (#25) | |
| `returns` validation | impl/registration_impl.ts (`exportReturns`) | done (#25) | |
| Args are always a single object (defaults to `{}`) | server/registration.ts | done | `args ?? {}`. |
| Handler returning `undefined` becomes `null` on the wire | impl/registration_impl.ts | done | `value ?? null`. |
| Function names `"dir/module:export"`; a `default` export omits `:export` | server/api.ts (`getFunctionName`) | partial | Manual `register(module, fns)` builds `module:fn`. There is no default-export rule and no file-based discovery. |
| `api` / `internal` function references (`anyApi`, codegen), `makeFunctionReference`, `getFunctionName`, `filterApi` | server/api.ts | missing | Callers use strings. Codegen vs inference is an open decision. |
| `FunctionReference_future` / typed `FunctionArgs` / `FunctionReturnType` | server/api.ts | missing | |
| Generic builders (`queryGeneric` etc.) and typed `_generated/server` builders bound to the DataModel | impl/registration_impl.ts; codegen | missing | Contexts are untyped. |
| Warning when a registered function is called directly | impl/registration_impl.ts (`dontCallDirectly`) | missing | Minor. |
| Guard against importing functions in a browser | impl/registration_impl.ts (`assertNotBrowser`) | missing | Minor. |
| `exportArgs()` / `exportReturns()` metadata, used by the dashboard and codegen | impl/registration_impl.ts | missing | |

### 6. Function contexts

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| QueryCtx `{ db, auth, storage (reader), runQuery, meta }` | server/registration.ts | partial | Only `db`. |
| MutationCtx `{ db, auth, storage (writer), scheduler, runQuery, runMutation, meta }` | server/registration.ts | partial | `db`, `auth`, `scheduler`. |
| ActionCtx `{ runQuery, runMutation, runAction, scheduler, auth, storage (action writer), vectorSearch, meta }` | server/registration.ts | partial | `runQuery`, `runMutation`, `runAction` (by reference or name, internal ones included), `auth`, `scheduler`. |
| `ctx.runQuery` from a query or mutation: same transaction, with validation | impl/registration_impl.ts | missing | |
| `ctx.runMutation` from a mutation: a sub-transaction that rolls back if it throws | impl/registration_impl.ts | missing | |
| `ctx.runQuery` / `ctx.runMutation` from an action: each is its own transaction | impl/actions_impl.ts | done | Strings instead of references, and internal functions are allowed. |
| `ctx.runAction` from an action | impl/actions_impl.ts | missing | |
| `runQuery` option `useStaleSnapshot` (mutations only) | server/registration.ts (`AdvancedRunQueryOptions`) | missing | |
| `transactionLimits` option on `runQuery` / `runMutation` (bytesRead, documentsRead/Written, databaseQueries, functionsScheduled, files…) | server/meta.ts, registration.ts | missing | |
| Maximum nesting of `runQuery`/`runMutation` calls (`MAX_REACTOR_CALL_DEPTH` = 8) | knobs.rs | missing | |
| `ctx.meta.getFunctionMetadata()` (name, componentPath, type, visibility) | server/meta.ts | missing | |
| `ctx.meta.getTransactionMetrics()` (used/remaining per limit) | server/meta.ts | missing | |
| `ctx.meta.getDeploymentMetadata()` | server/meta.ts | missing | |
| `ctx.meta.getRequestMetadata()` (ip, userAgent, requestId, scheduledFunctionId, authToken) | server/meta.ts | missing | |
| `ctx.meta.getSnapshotTs()` (bigint, on the same clock as commitTs) | server/meta.ts; isolate syscall.rs | missing | |
| `ctx.vectorSearch(table, index, { vector, limit, filter })` returns `[{ _id, _score }]` (actions only) | server/vector_search.ts | missing | |

### 7. Deterministic runtime and execution environment

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `Date.now()` / `new Date()` frozen at the start of a query or mutation | crates/isolate/src/environment/udf/phase.rs | done | Via AsyncLocalStorage (determinism.ts). |
| `Math.random()` seeded per execution | isolate/src/environment/udf | done | sfc32 PRNG. |
| `performance.now()` fixed in queries, incrementing in mutations, rounded down to 0.1 ms | isolate/src/environment/udf/phase.rs, helpers/performance.rs, ops/time.rs | done | `performance.timeOrigin` is the process's, not the module import time (STUDY-03 D3). |
| `fetch`, timers and `crypto.getRandomValues` throw in queries and mutations ("NoXInQueriesOrMutations") | isolate/src/environment/udf/mod.rs (`not_allowed_in_udf`) | partial | Blocked, but `crypto.randomUUID` and `crypto.subtle` aren't. This is not a sandbox: captured globals escape. |
| `Date` / `Math.random` unsupported at module import time | udf/phase.rs | missing | |
| Actions run with the real globals (`fetch`, timers) | isolate/src/environment/action | done | |
| Function isolation (per-function V8 isolate, memory cap `ISOLATE_MAX_USER_HEAP_SIZE` = 64 MiB) | knobs.rs; isolate | missing | Single shared process. Sandboxing is an open decision. |
| `process.env` environment variables available to functions (name ≤ 256, value ≤ 8 KiB) | common/src/types/environment_variables.rs | missing | Env var management is listed as M. |
| `console.log` / `info` / `warn` / `error` captured as function logs (≤256 lines, ≤32 KiB each) | isolate/src/environment/helpers/mod.rs | done (STUDY-20) | Also `debug`, `trace`, `time`/`timeLog`/`timeEnd`, rendered with object-inspect as Convex does. A retried mutation keeps only the committed attempt's lines. Cached query results carry no lines (STUDY-20 D2). |
| `log.audit(body)` + `log.vars` (requestId, ip, userAgent, now, convexActor) | server/log.ts, audit_logging.ts, logVars.ts | missing | New Convex feature. |
| `getServiceToken("ai-gateway")` / `getServiceUrl` | impl/actions_impl.ts | missing | Convex-cloud specific, probably out of scope. |
| Node runtime actions (`"use node"`) | CLI / node-executor | missing | bunvex runs everything on Bun, which is arguably not needed. |
| Query result caching keyed by args and identity, invalidated by read-set | crates/application cache | partial | Keyed by name and args only, with no identity yet. FIFO eviction. |

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
| `v.commitTs()` | values/validator.ts (`VCommitTs`) | missing | New. |
| VObject helpers `.omit()`, `.pick()`, `.partial()`, `.extend()` | values/validators.ts | done (#24) | |
| Validator introspection (`.kind`, `.isOptional`, `.fields`, `.members`, `.element`, `.json`) | values/validators.ts | done (#24) | bunvex marker is `isValidator` (no "convex" in names). |
| `Infer<typeof validator>`, `ObjectType`, `PropertyValidators`, `asObjectValidator`, `GenericValidator` | values/validator.ts | done (#24) | asObjectValidator not yet. |
| Undefined-validator error (catches circular imports) | validators.ts; registration_impl.ts (`strictReplacer`) | done (#24) | |
| Value `null` | values/value.ts | done | JSON. |
| Value `boolean` | values/value.ts | done | |
| Value `string` | values/value.ts | done | |
| Value `number` (float64), including NaN, ±Infinity and −0 | values/value.ts (`$float` encoding) | partial | Finite numbers work. NaN and ±Infinity become `null` through JSON, and −0 is lost (keyenc also normalises −0 to 0). |
| Value `bigint` (int64, range-checked) | values/value.ts | missing | `JSON.stringify` throws on bigint. |
| Value `ArrayBuffer` (bytes) | values/value.ts | missing | Serialises to `{}`. |
| Value arrays and plain objects | values/value.ts | partial | Stored fine. Not index-keyable: keyenc has no array/object tags, and objects fall into the bytes branch. |
| `undefined` isn't a value (error at a path); `undefined` object fields are dropped | values/value.ts (`convexToJsonInternal`) | done (#21) | `toJsonValue` refuses `undefined` with a path and drops `undefined` fields. |
| Only plain objects allowed (class instances rejected) | values/value.ts (`isSimpleObject`) | missing | |
| Wire encoding `convexToJson` / `jsonToConvex` (`$integer`, `$bytes`, `$float`) | values/value.ts | done (#21) | As `toJsonValue` / `fromJsonValue` (no "convex" in bunvex's public names). |
| `Id<T>` / `GenericId` branded string type | values/value.ts | missing | |
| `compareValues`, `getConvexSize`, `getDocumentSize`, `Base64` utilities | values/compare.ts, size.ts, base64.ts | missing | |
| `ConvexError(data)`: `data` is any Convex value and reaches the client as `errorData` | values/errors.ts; registration_impl.ts | done (STUDY-20) | As `BunvexError` (owner's decision). HTTP `errorData`, WebSocket `d`. |

### 9. Value ordering (index order and filter comparisons)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Cross-type order: undefined < null < int64 < float64 < boolean < string < bytes < array < object | crates/value/src/sorting.rs | partial | bunvex keyenc: null < false < true < number < string < bytes. Booleans sort **before** numbers (Convex puts them after). There is no int64, undefined, array or object. |
| float64 total order (`total_cmp`: −NaN < −∞ < … < −0 < +0 < … < +∞ < NaN) | sorting.rs | partial | IEEE-flip encoding matches, except that −0 is folded into +0. |
| int64 ordered numerically and separately from float64 (1n ≠ 1) | sorting.rs | missing | |
| Strings ordered by UTF-8 bytes | sorting.rs; values/compare_utf8.ts | done | Escaped, 0x00-terminated UTF-8 in keyenc. |
| Bytes ordered lexicographically | sorting.rs | done | Tag exists. The `_id` tiebreaker uses it. |
| Arrays ordered element-wise; objects by (field, value) pairs in field order | sorting.rs | missing | |
| Missing index fields sort as `undefined`, which is distinct from `null` | sorting.rs (`write_sort_key_or_undefined`) | missing | Mapped to `null`. |

### 10. System fields and document shape

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `_id` on every document | server/system_fields.ts | done (#7) | A Convex-format id. |
| `_creationTime` (float64 ms since epoch) | system_fields.ts; common/src/document.rs | done | |
| Types `WithoutSystemFields`, `WithOptionalSystemFields`, `SystemFields`, `IdField`, `Doc<T>` | system_fields.ts; codegen | missing | |
| Top-level user fields can't start with `_` | crates/common/src/document.rs (validate) | missing | |
| Field names: ≤1024 chars, non-control ASCII, no leading `$` | crates/convex/sync_types/src/identifier.rs; values/value.ts | done (#21) | `validateObjectField`, with the same messages. |
| Documents must be objects | common/src/document.rs | partial | Implicit through the TS signature only. |

### 11. Schema

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineSchema({ table: defineTable(...) })` | server/schema.ts | done (#29) | |
| `defineTable(validatorFields \| v.object \| v.union of objects \| v.any)` | server/schema.ts | done (#29) | |
| `.index(name, [fields])` | server/schema.ts | partial | Declared as `{ name: fields[] }` in `Schema.table`. |
| `.index(name, { fields, staged })`: staged indexes that don't block a push | server/schema.ts | missing | |
| `.searchIndex(name, { searchField, filterFields, staged })` | server/schema.ts | missing | |
| `.vectorIndex(name, { vectorField, dimensions, filterFields, staged })` | server/schema.ts | missing | |
| `.staged(validator)`: staged document validator, checked in the background | server/schema.ts | missing | New. |
| `schemaValidation` option (default true) | server/schema.ts | done (#29) | |
| `strictTableNameTypes` option (type-level) | server/schema.ts | missing | |
| `schema.doc(table)` / `schema.id(table)` / `docValidator()` helpers | server/schema.ts | missing | |
| Pushing a schema validates existing documents against it | crates/model / schema worker | missing | |
| Index backfill when an index is added to an existing table | crates/database/src/database_index_workers | partial (#6) | Backfilled synchronously at startup, before serving; Convex backfills in the background (STUDY-04 D3). |
| Table names: identifier ≤64, starts with a letter, `[A-Za-z0-9_]`; `_` prefix reserved | sync_types/identifier.rs; index_validation_error.rs | done (#6) | Convex's identifier rule; a leading `_` is reserved for system tables. |
| Index names: identifier; not `by_id` / `by_creation_time` / `_`-prefixed; unique per table | index_validation_error.rs | done (#6) | |
| Index fields: ≥1 field, ≤16 fields, unique, no `_id` / `_creationTime`, no `_`-prefixed fields | index_validation_error.rs; bootstrap_model/index/mod.rs | partial | In flight: the empty-fields check only. |
| No two indexes with identical fields on a table | index_validation_error.rs | missing | |
| ≤64 indexes per table (`MAX_INDEXES_PER_TABLE`) and ≤10,000 tables | common/src/schemas/mod.rs; database/src/bootstrap_model/table.rs | missing | |
| Vector dimensions between 2 and 4096; ≤16 filter fields for search and vector indexes | common/src/bootstrap_model/index | missing | |
| `DataModelFromSchemaDefinition` typed data model | server/schema.ts | missing | |

### 12. Auth (`ctx.auth`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `ctx.auth.getUserIdentity()` returns `UserIdentity \| null` in queries, mutations, actions and HTTP actions | server/authentication.ts | partial (STUDY-27) | Queries, mutations and actions (actions pass it to `runQuery` / `runMutation`); HTTP actions do not exist yet. |
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
| `scheduler.runAfter(ms, fnRef, args)` returns `Id<"_scheduled_functions">` | server/scheduler.ts | done (STUDY-30) | |
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
| `cronJobs()` + `export default crons` in `crons.ts` | server/cron.ts | partial (STUDY-30) | `cronJobs()` as Convex; passed as `createServer({ crons })` until the CLI (S1). |
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
| `httpRouter()` + `http.route({ path, method, handler })` in `http.ts` | server/router.ts | done (STUDY-31) | Passed as `createServer({ http })` (H1, DV-143) once served. |
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
| `createFunctionHandle(fnRef)` returns a string handle usable in `runX` / scheduler | server/components/index.ts | missing | |
| Isolated per-component tables, functions and data | crates (component registry) | missing | |

### 18. Errors surfaced to apps

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `throw new ConvexError(data)`, where the client receives `data` intact | values/errors.ts; impl/registration_impl.ts | partial (STUDY-20) | `BunvexError`: the server sends `data` intact; there is no client yet to rethrow it. |
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
| Function args ≤ 16 MiB; function result ≤ 16 MiB | knobs.rs (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`) | missing | The WS frame cap of 8 MiB is incidental. |
| Reads per transaction ≤ 32,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_READ_SIZE_ROWS/BYTES`) | missing | `collect()` silently truncates at 8192 instead. |
| Read-set intervals (database queries) ≤ 4096 per transaction | knobs.rs (`TRANSACTION_MAX_READ_SET_INTERVALS`) | missing | |
| Writes per transaction ≤ 16,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_NUM_USER_WRITES`, `…WRITE_SIZE_BYTES`) | done (#35) | |
| Query/mutation user execution time ≤ 1 s (`DATABASE_UDF_USER_TIMEOUT`) | knobs.rs | missing | No timeout at all. |
| Action timeout (V8 1800 s knob default here; Node 600 s; Convex cloud documents 10 min) | knobs.rs (`V8_ACTION_USER_TIMEOUT`, `NODE_ACTION_USER_TIMEOUT`) | missing | |
| Isolate heap ≤ 64 MiB; ArrayBuffers ≤ 64 MiB | knobs.rs | missing | |
| Log lines ≤ 256 per execution, ≤ 32 KiB each | isolate/src/environment/helpers/mod.rs | missing | |
| Scheduling: 1000 per transaction, 4 MiB per job, 16 MiB total | knobs.rs | missing | |
| Files per transaction: 10 read / 10 written, 16 MiB each way | knobs.rs | missing | |
| Search: 16 terms, ≤1024 results; vector: ≤256 results, 2–4096 dimensions, ≤64 filter length | crates/search/src/constants.rs; crates/vector/src/lib.rs | missing | |
| `runQuery` / `runMutation` call depth ≤ 8 | knobs.rs (`MAX_REACTOR_CALL_DEPTH`) | missing | |
| OCC retries for mutations (4 by default) | knobs.rs | done (STUDY-21) | |

---

### Summary counts

| Status | Count |
|---|---|
| done | 21 |
| partial | 39 |
| missing | 176 |
| **total** | **236** |

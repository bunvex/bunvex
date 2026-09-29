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
| `db.get(table, id)`, the table-scoped form | server/database.ts, impl/database_impl.ts | partial | Exists as `Tx.get(table, id)`. It doesn't check that the id belongs to `table`, and it has no argument validation. |
| `db.get(id)`, the legacy form where the id carries its table | server/database.ts | missing | Ids now carry their table (#7), so this is unblocked; the one-argument form is not wired up yet. |
| `db.get` returns `null` for a missing or deleted doc | impl/database_impl.ts | done | |
| `db.get` sees the transaction's own writes | crates/database/src/transaction.rs | done | Served from the write set. |
| `db.query(table)` returns a QueryInitializer | server/query.ts | partial | Exists and defaults to `by_creation_time` ascending. It is one mutable object rather than Convex's chain of single-use stages. |
| `db.normalizeId(table, idString)` | impl/database_impl.ts (`1.0/db/normalizeId`) | missing | Needs the Convex id format. |
| `db.system.get` / `db.system.query` / `db.system.normalizeId` for system tables (read-only) | impl/database_impl.ts | missing | There are no user-visible system tables yet (`_storage`, `_scheduled_functions`). |
| User vs system table separation: `_`-prefixed tables only via `db.system`, and system tables are read-only | impl/database_impl.ts | missing | The in-flight schema change rejects `_`-prefixed user table names. There is no `db.system` split. |
| `db.table(name)` scoped reader (`.get(id)`, `.query()`), the newer "WithTable" API | server/database.ts (`GenericDatabaseReaderWithTable`) | missing | |
| Queries see a consistent snapshot (serializable reads) | crates/database | done | MVCC snapshot at `visibleTs`. |
| A mutation's queries see its own writes (merged in index order) | crates/database/src/transaction_index.rs | done | Pending-entry B-tree merge per index. |
| Read-set tracking for reactivity/OCC ends at the last key actually read | crates/database/src/reads.rs | partial | bunvex records the whole scanned interval even for `take(n)`/`first()`. That is correct but invalidates more often than Convex. |

### 2. Query builder: withIndex, filter, order, terminal operations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.withIndex(name)` with no range (whole index) | server/query.ts, impl/query_impl.ts | done | |
| `.withIndex(name, q => …)` range expression | server/index_range_builder.ts | partial | Supports eq/gt/gte/lt/lte, but field names are ignored. It doesn't check that fields follow index order, that eq comes before range, or that there is at most one lower and one upper bound. |
| IndexRangeBuilder `eq(field, value)`, in index-field order | index_range_builder.ts | partial | Positional only; the field name isn't checked. |
| IndexRangeBuilder `gt`/`gte` then `lt`/`lte` on the next field | index_range_builder.ts | partial | Works for the common case. A mismatched field name, or bounds on different fields, silently produce a wrong range. |
| Index range on `undefined` (missing field) | crates/common/src/query.rs, value/sorting.rs | missing | bunvex maps missing fields to `null`. Convex keeps `undefined` as its own value that sorts below `null`. |
| Using `by_id` / `by_creation_time` system indexes in `withIndex` | system_fields.ts (`SystemIndexes`) | done | Both are created for every table. |
| Every user index implicitly ends with `_creationTime`, then `_id` | crates/common/src/types/index.rs; index_validation_error.rs | partial | bunvex appends only `_id` (as UTF-8 bytes). Ties on equal index values sort by UUID, not creation time. |
| `.fullTableScan()` | impl/query_impl.ts | missing | Only the implicit default (`by_creation_time`). |
| `.order("asc" \| "desc")` | impl/query_impl.ts | partial | Works. It doesn't reject a second `.order()` or `.order()` on a search query. |
| `.filter(q => expr)` | server/filter_builder.ts, impl/filter_builder_impl.ts | missing | Listed as "M" in ARCHITECTURE.md. |
| Filter `q.field("a.b")`, including nested field paths | filter_builder.ts | missing | |
| Filter comparisons `eq` / `neq` / `lt` / `lte` / `gt` / `gte`, including `undefined` | filter_builder.ts | missing | |
| Filter arithmetic `add` / `sub` / `mul` / `div` / `mod` / `neg` | filter_builder.ts | missing | |
| Filter logic `and` / `or` / `not` | filter_builder.ts | missing | |
| Filters compare across types using the global value order | value/sorting.rs | missing | |
| At most 256 query operators per query (`MAX_QUERY_OPERATORS`) | impl/query_impl.ts; common/src/query.rs | missing | |
| `.limit(n)` (non-terminal operator on OrderedQuery) | server/query.ts | missing | |
| `.collect()` | impl/query_impl.ts | partial | bunvex silently stops at 8192 rows. Convex reads everything, up to the transaction read limits (32k rows / 16 MiB), and then throws. |
| `.take(n)`, requiring a non-negative integer | impl/query_impl.ts | partial | Works, but `n` isn't validated. |
| `.first()` | impl/query_impl.ts | done | |
| `.unique()`: returns null or the only row, and throws if there are ≥2 | impl/query_impl.ts | missing | |
| Async iteration: `for await (const doc of query)` and `.next()` streaming | impl/query_impl.ts (`queryStream` / `queryStreamNext`) | missing | Needed for early exit without materialising the result. |
| A query is single-use (reusing or rechaining it throws) | impl/query_impl.ts | missing | bunvex's query object is mutable and reusable. |
| Returning a Query object from a function throws a helpful error | impl/registration_impl.ts (`validateReturnValue`) | missing | |
| `.count()` (internal, not public) | impl/query_impl.ts | missing | Low priority. |
| `.withSearchIndex(name, q => q.search(field, text).eq(filterField, v))` | server/search_filter_builder.ts | missing | Full-text search is "D" in ARCHITECTURE.md. |
| Search results come in relevance order (order can't be set), with prefix matching on the last term | impl/query_impl.ts; crates/search | missing | |
| Search limits: 16 query terms, 32-char term max, ≤8 filter conditions, ≤1024 results | crates/search/src/constants.rs | missing | |

### 3. Pagination

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `.paginate({ numItems, cursor })` returns `{ page, isDone, continueCursor }` | server/pagination.ts, impl/query_impl.ts | missing | |
| `numItems` must be > 0 and ≤ 32000 (`TRANSACTION_MAX_READ_SIZE_ROWS`) | isolate/src/environment/udf/async_syscall.rs | missing | |
| Opaque, encrypted cursors (`cursor: null` starts at the beginning) | async_syscall.rs (`key_broker.encrypt_cursor`) | missing | |
| `endCursor` pins the page end so a reactive page keeps its boundaries on re-run (taken from the query journal) | pagination.ts; async_syscall.rs | missing | |
| `maximumRowsRead` / `maximumBytesRead` (must be > 0) | pagination.ts; async_syscall.rs | missing | |
| `splitCursor` + `pageStatus` (`"SplitRecommended"` / `"SplitRequired"`) | pagination.ts | missing | |
| Only one paginated query per query or mutation (`MultiplePaginatedDatabaseQueries`) | async_syscall.rs | missing | |
| `paginate()` isn't supported inside components | async_syscall.rs | missing | |
| `paginationOptsValidator` and `paginationResultValidator(item)` helpers | server/pagination.ts | missing | Depends on validators. |

### 4. Database writer: `ctx.db` in mutations

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `db.insert(table, value)` returns `Id<table>` | server/database.ts, impl/database_impl.ts | partial | Returns a Convex-format id (#7), but the value isn't validated at all. Convex checks the schema, value types, field names and size. |
| `insert` rejects system tables (names starting with `_`) | impl/database_impl.ts | missing | |
| `insert` assigns `_id` and `_creationTime` and rejects caller-supplied values that don't match | crates/common/src/document.rs | partial | bunvex overwrites `_id` / `_creationTime` silently instead of rejecting them. |
| `_creationTime` is strictly increasing within a transaction, so inserts sort in insert order | crates/database/src/transaction.rs (`next_creation_time`) | done | `nextUp()` float increment, on main. |
| Convex-format document ids (base32; table number plus random bytes plus checksum; ~31–37 chars) | crates/value/src/id_v6.rs | done (#7) | Convex's format and generator exactly (STUDY-01 option C). Legacy v4/v5 formats are not accepted by `normalizeId`, since bunvex has no legacy data. |
| `db.patch(table, id, partial)`: shallow merge | server/database.ts | partial | Implemented. Missing: validation, rejecting patches of `_id` / `_creationTime` to a different value, and the legacy `patch(id, v)` form. |
| `patch` with a field set to `undefined` removes that field | values/value.ts (`patchValueToJson`) | partial | It only works by accident: `JSON.stringify` drops the key on persist. Within the transaction, a read returns the key with the value `undefined`. |
| `patch` / `replace` / `delete` on a nonexistent id throws `NonexistentDocument` | crates/database/src/transaction.rs | partial | `patch` throws. `delete` of a missing doc is a silent no-op. |
| `db.replace(table, id, value)`: replace all non-system fields, keeping `_id` / `_creationTime` | server/database.ts | missing | |
| `db.delete(table, id)` | server/database.ts | partial | Works for existing docs. It lacks the legacy `delete(id)` form and doesn't throw on a missing doc. |
| Legacy single-argument forms: `patch(id, v)`, `replace(id, v)`, `delete(id)` | impl/database_impl.ts | missing | Needs ids that encode their table. |
| `db.table(name)` scoped writer (`.insert` / `.patch` / `.replace` / `.delete`) | server/database.ts (`BaseTableWriter`) | missing | |
| `db.vars.commitTs` placeholder, resolved at commit to an int64 in commit order, plus `v.commitTs()` | server/database.ts; values/value.ts (`CommitTsPlaceholder`) | missing | New Convex feature. |
| Writes are atomic: all or none, and a throwing mutation commits nothing | crates/database | done | |
| Optimistic concurrency with automatic retry on conflict | crates/database; knobs `UDF_EXECUTOR_OCC_MAX_RETRIES` = 4 | partial | Retries up to 30 times with jittered backoff (Convex: 4). The conflict error isn't user-visible in Convex's shape. |
| Writes are validated against the schema when `schemaValidation` is on | crates/common/src/schemas | missing | There are no document validators. |

### 5. Function builders and registration

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `query`, `mutation`, `action` (public) | impl/registration_impl.ts | partial | They exist but take only a bare handler: `query(handler, internal?)`. |
| `internalQuery`, `internalMutation`, `internalAction` | impl/registration_impl.ts | partial | Done as a boolean flag, not as separate builders. Clients can't call internal functions (done). |
| Object form `{ args, returns, handler }` | server/registration.ts (`ValidatedFunction`) | missing | |
| `args` validation (an object of validators, or `v.object`), with extra fields rejected | impl/registration_impl.ts (`exportArgs`); runtime in crates | missing | `Args = any`, and nothing is validated. Listed as "N" in ARCHITECTURE.md. |
| `returns` validation | impl/registration_impl.ts (`exportReturns`) | missing | |
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
| MutationCtx `{ db, auth, storage (writer), scheduler, runQuery, runMutation, meta }` | server/registration.ts | partial | Only `db`. |
| ActionCtx `{ runQuery, runMutation, runAction, scheduler, auth, storage (action writer), vectorSearch, meta }` | server/registration.ts | partial | Only `runQuery` / `runMutation`. |
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
| `fetch`, timers and `crypto.getRandomValues` throw in queries and mutations ("NoXInQueriesOrMutations") | isolate/src/environment/udf/mod.rs (`not_allowed_in_udf`) | partial | Blocked, but `crypto.randomUUID` and `crypto.subtle` aren't. This is not a sandbox: captured globals escape. |
| `Date` / `Math.random` unsupported at module import time | udf/phase.rs | missing | |
| Actions run with the real globals (`fetch`, timers) | isolate/src/environment/action | done | |
| Function isolation (per-function V8 isolate, memory cap `ISOLATE_MAX_USER_HEAP_SIZE` = 64 MiB) | knobs.rs; isolate | missing | Single shared process. Sandboxing is an open decision. |
| `process.env` environment variables available to functions (name ≤ 256, value ≤ 8 KiB) | common/src/types/environment_variables.rs | missing | Env var management is listed as M. |
| `console.log` / `info` / `warn` / `error` captured as function logs (≤256 lines, ≤32 KiB each) | isolate/src/environment/helpers/mod.rs | missing | Logs are listed as M. |
| `log.audit(body)` + `log.vars` (requestId, ip, userAgent, now, convexActor) | server/log.ts, audit_logging.ts, logVars.ts | missing | New Convex feature. |
| `getServiceToken("ai-gateway")` / `getServiceUrl` | impl/actions_impl.ts | missing | Convex-cloud specific, probably out of scope. |
| Node runtime actions (`"use node"`) | CLI / node-executor | missing | bunvex runs everything on Bun, which is arguably not needed. |
| Query result caching keyed by args and identity, invalidated by read-set | crates/application cache | partial | Keyed by name and args only, with no identity yet. FIFO eviction. |

### 8. Validators (`v`) and value types

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `v.id(table)` | values/validator.ts | missing | `@bunvex/values` is empty. |
| `v.null()` | values/validator.ts | missing | |
| `v.number()` / `v.float64()` | values/validator.ts | missing | |
| `v.bigint()` / `v.int64()` | values/validator.ts | missing | |
| `v.boolean()` | values/validator.ts | missing | |
| `v.string()` | values/validator.ts | missing | |
| `v.bytes()` (ArrayBuffer) | values/validator.ts | missing | |
| `v.literal(string \| number \| bigint \| boolean)` | values/validator.ts | missing | |
| `v.array(el)` | values/validator.ts | missing | |
| `v.object(fields)`, rejecting unknown fields | values/validator.ts | missing | |
| `v.record(keys, values)` (keys are string-like or ids; no optional keys or values) | values/validators.ts (`VRecord`) | missing | |
| `v.union(...members)` | values/validator.ts | missing | |
| `v.any()` | values/validator.ts | missing | |
| `v.optional(x)` and the `.optional()` method on every validator | values/validator.ts, validators.ts | missing | |
| `v.nullable(x)` (= `union(x, null)`) | values/validator.ts | missing | |
| `v.commitTs()` | values/validator.ts (`VCommitTs`) | missing | New. |
| VObject helpers `.omit()`, `.pick()`, `.partial()`, `.extend()` | values/validators.ts | missing | |
| Validator introspection (`.kind`, `.isOptional`, `.fields`, `.members`, `.element`, `.json`) | values/validators.ts | missing | |
| `Infer<typeof validator>`, `ObjectType`, `PropertyValidators`, `asObjectValidator`, `GenericValidator` | values/validator.ts | missing | |
| Undefined-validator error (catches circular imports) | validators.ts; registration_impl.ts (`strictReplacer`) | missing | |
| Value `null` | values/value.ts | done | JSON. |
| Value `boolean` | values/value.ts | done | |
| Value `string` | values/value.ts | done | |
| Value `number` (float64), including NaN, ±Infinity and −0 | values/value.ts (`$float` encoding) | partial | Finite numbers work. NaN and ±Infinity become `null` through JSON, and −0 is lost (keyenc also normalises −0 to 0). |
| Value `bigint` (int64, range-checked) | values/value.ts | missing | `JSON.stringify` throws on bigint. |
| Value `ArrayBuffer` (bytes) | values/value.ts | missing | Serialises to `{}`. |
| Value arrays and plain objects | values/value.ts | partial | Stored fine. Not index-keyable: keyenc has no array/object tags, and objects fall into the bytes branch. |
| `undefined` isn't a value (error at a path); `undefined` object fields are dropped | values/value.ts (`convexToJsonInternal`) | partial | Dropped by JSON with no error. `undefined` in arrays becomes `null` silently. |
| Only plain objects allowed (class instances rejected) | values/value.ts (`isSimpleObject`) | missing | |
| Wire encoding `convexToJson` / `jsonToConvex` (`$integer`, `$bytes`, `$float`) | values/value.ts | missing | Plain JSON only. |
| `Id<T>` / `GenericId` branded string type | values/value.ts | missing | |
| `compareValues`, `getConvexSize`, `getDocumentSize`, `Base64` utilities | values/compare.ts, size.ts, base64.ts | missing | |
| `ConvexError(data)`: `data` is any Convex value and reaches the client as `errorData` | values/errors.ts; registration_impl.ts | missing | Errors reach the client as `String(message)` only. |

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
| Field names: ≤1024 chars, non-control ASCII, no leading `$` | crates/convex/sync_types/src/identifier.rs; values/value.ts | missing | |
| Documents must be objects | common/src/document.rs | partial | Implicit through the TS signature only. |

### 11. Schema

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `defineSchema({ table: defineTable(...) })` | server/schema.ts | partial | bunvex uses an imperative `new Schema().table(name, indexes)`. There is no `defineSchema` / `defineTable` API. |
| `defineTable(validatorFields \| v.object \| v.union of objects \| v.any)` | server/schema.ts | missing | Tables have no document type. |
| `.index(name, [fields])` | server/schema.ts | partial | Declared as `{ name: fields[] }` in `Schema.table`. |
| `.index(name, { fields, staged })`: staged indexes that don't block a push | server/schema.ts | missing | |
| `.searchIndex(name, { searchField, filterFields, staged })` | server/schema.ts | missing | |
| `.vectorIndex(name, { vectorField, dimensions, filterFields, staged })` | server/schema.ts | missing | |
| `.staged(validator)`: staged document validator, checked in the background | server/schema.ts | missing | New. |
| `schemaValidation` option (default true) | server/schema.ts | missing | |
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
| `ctx.auth.getUserIdentity()` returns `UserIdentity \| null` in queries, mutations, actions and HTTP actions | server/authentication.ts | missing | `@bunvex/auth` is empty. |
| `UserIdentity` fields (tokenIdentifier, subject, issuer, name, email, emailVerified, …, custom claims) | server/authentication.ts | missing | |
| `auth.config.ts` providers: OIDC `{ domain, applicationID }` and `customJwt` `{ issuer, jwks, algorithm RS256/ES256 }` | server/authentication.ts (`AuthConfig`) | missing | |
| Query cache and subscriptions scoped by identity | crates/application | missing | |

### 13. File storage (`ctx.storage`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `storage.getUrl(id)` (queries, mutations, actions) | server/storage.ts | missing | `@bunvex/file-storage` is empty. |
| `storage.getMetadata(id)` (deprecated in favour of `db.system.get("_storage", id)`) | server/storage.ts | missing | |
| `storage.generateUploadUrl()` (mutations, actions) + HTTP POST upload returning `{ storageId }` | server/storage.ts | missing | |
| `storage.delete(id)` (mutations, actions) | server/storage.ts | missing | |
| `storage.store(blob, { sha256 })` (actions; the mutation variant is internal/unreleased) | server/storage.ts; async_syscall.rs | missing | |
| `storage.get(id)` returns `Blob` (actions only) | server/storage.ts | missing | |
| `_storage` system table `{ sha256, size, contentType? }` | server/schema.ts (`_systemSchema`) | missing | |
| Per-transaction file limits: 10 files / 16 MiB written, 10 files / 16 MiB read | knobs.rs | missing | |

### 14. Scheduler (`ctx.scheduler`)

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `scheduler.runAfter(ms, fnRef, args)` returns `Id<"_scheduled_functions">` | server/scheduler.ts | missing | "M". |
| `scheduler.runAt(timestamp \| Date, fnRef, args)` | server/scheduler.ts | missing | |
| `scheduler.cancel(id)` | server/scheduler.ts | missing | |
| Scheduling from a mutation is transactional (only if the mutation commits); from an action it isn't | docs; crates/model scheduled_jobs | missing | |
| Scheduled mutations run exactly once, scheduled actions at most once | crates/application scheduled_jobs | missing | |
| `_scheduled_functions` system table (name, args, scheduledTime, completedTime, state pending/inProgress/success/failed/canceled) | server/schema.ts | missing | |
| Limits: 1000 scheduled per transaction, 16 MiB total args, 4 MiB per job's args; retention 7 days | knobs.rs | missing | |
| Only mutations and actions (public or internal) can be scheduled | server/scheduler.ts | missing | |

### 15. Crons

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `cronJobs()` + `export default crons` in `crons.ts` | server/cron.ts | missing | |
| `crons.interval(id, { seconds \| minutes \| hours }, fn, args)` | server/cron.ts | missing | |
| `crons.hourly(id, { minuteUTC }?, fn, args)` | server/cron.ts | missing | |
| `crons.daily(id, { hourUTC, minuteUTC }?, …)` | server/cron.ts | missing | |
| `crons.weekly(id, { dayOfWeek, hourUTC, minuteUTC }, …)` | server/cron.ts | missing | |
| `crons.monthly(id, { day, hourUTC, minuteUTC }, …)` | server/cron.ts | missing | |
| `crons.cron(id, "unix cron string", …)` | server/cron.ts | missing | |
| Unique cron identifiers; input validation (ranges for minute, hour and day) | server/cron.ts | missing | |

### 16. HTTP actions and router

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| `httpAction(async (ctx, request) => Response)` with an ActionCtx | impl/registration_impl.ts (`httpActionGeneric`) | missing | "M" (custom routes). |
| `httpRouter()` + `http.route({ path, method, handler })` in `http.ts` | server/router.ts | missing | |
| `http.route({ pathPrefix: "/x/", … })` prefix routes, longest prefix wins | server/router.ts | missing | |
| Methods GET / POST / PUT / DELETE / OPTIONS / PATCH; HEAD maps to GET | server/router.ts (`normalizeMethod`) | missing | |
| Route validation: leading `/`, prefix ends with `/`, `/.files` reserved, duplicate detection | server/router.ts | missing | |
| `getRoutes()` / `lookup(path, method)` | server/router.ts | missing | |
| Served on the separate HTTP-actions origin/port (`/.site`-style), with `defineApp({ httpPrefix })` | components/index.ts; crates/local_backend | missing | |

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
| `throw new ConvexError(data)`, where the client receives `data` intact | values/errors.ts; impl/registration_impl.ts | missing | |
| Non-ConvexError errors redacted in production ("Server Error") | crates/application | missing | Raw messages are returned. |
| Typed error codes for limits (e.g. `ValueTooLargeError`, `TooManyWrites`) | crates/common/src/document.rs, database | missing | |
| `unique()` error when there are multiple results; errors for misuse of closed/chained queries | impl/query_impl.ts | missing | |

### 19. Limits

| Feature | Convex source (file) | bunvex status | Notes |
|---|---|---|---|
| Document size ≤ 1 MiB (`MAX_USER_SIZE`, including system fields) | crates/common/src/document.rs | missing | |
| Document nesting ≤ 16 levels (`MAX_DOCUMENT_NESTING`) | crates/common/src/document.rs | missing | |
| Generic value (args/results) size ≤ 32 MiB and nesting ≤ 64 | crates/value/src/size.rs | missing | |
| Array length ≤ 8192 | crates/value/src/array.rs | missing | |
| Object fields ≤ 1024 | crates/value/src/object.rs | missing | |
| Field name ≤ 1024 chars; identifiers (tables, indexes) ≤ 64 | sync_types/identifier.rs | partial | Identifiers are in flight. There is no field-name check. |
| Function args ≤ 16 MiB; function result ≤ 16 MiB | knobs.rs (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`) | missing | The WS frame cap of 8 MiB is incidental. |
| Reads per transaction ≤ 32,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_READ_SIZE_ROWS/BYTES`) | missing | `collect()` silently truncates at 8192 instead. |
| Read-set intervals (database queries) ≤ 4096 per transaction | knobs.rs (`TRANSACTION_MAX_READ_SET_INTERVALS`) | missing | |
| Writes per transaction ≤ 16,000 docs and ≤ 16 MiB | knobs.rs (`TRANSACTION_MAX_NUM_USER_WRITES`, `…WRITE_SIZE_BYTES`) | missing | |
| Query/mutation user execution time ≤ 1 s (`DATABASE_UDF_USER_TIMEOUT`) | knobs.rs | missing | No timeout at all. |
| Action timeout (V8 1800 s knob default here; Node 600 s; Convex cloud documents 10 min) | knobs.rs (`V8_ACTION_USER_TIMEOUT`, `NODE_ACTION_USER_TIMEOUT`) | missing | |
| Isolate heap ≤ 64 MiB; ArrayBuffers ≤ 64 MiB | knobs.rs | missing | |
| Log lines ≤ 256 per execution, ≤ 32 KiB each | isolate/src/environment/helpers/mod.rs | missing | |
| Scheduling: 1000 per transaction, 4 MiB per job, 16 MiB total | knobs.rs | missing | |
| Files per transaction: 10 read / 10 written, 16 MiB each way | knobs.rs | missing | |
| Search: 16 terms, ≤1024 results; vector: ≤256 results, 2–4096 dimensions, ≤64 filter length | crates/search/src/constants.rs; crates/vector/src/lib.rs | missing | |
| `runQuery` / `runMutation` call depth ≤ 8 | knobs.rs (`MAX_REACTOR_CALL_DEPTH`) | missing | |
| OCC retries for mutations (4 by default) | knobs.rs | partial | 30 in bunvex. The behaviour is equivalent, but the budget differs. |

---

### Summary counts

| Status | Count |
|---|---|
| done | 21 |
| partial | 39 |
| missing | 176 |
| **total** | **236** |

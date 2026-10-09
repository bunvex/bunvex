# @bunvex/values

## 0.1.0-alpha.1

### Minor Changes

- f280986: Function arguments are checked against Convex's value limits before the call (DV-439): an array over 8192 elements
  or an object over 1024 fields fails with Convex's message ("Invalid arguments for <path>: Array length is too long
  (…)"; a nested call's "Invalid argument `args` for `runUdf`: …"; the scheduler's; a system function's "Uncaught
  Error: Invalid arguments: …") instead of running. `measureRawValue` reports the first such container as `tooBig`.
- 1a4930f: Subscriptions and invalidation inspector (STUDY-131 AD-25, a bunvex addition). These admin endpoints need ViewMetrics:

  - `GET /api/debug/subscriptions` lists every live query per sync session: function, args digest, ts, whether the result was cached, documents and bytes read, and the read set as index ranges with their bounds decoded to values. It also shows the last invalidations: commit ts, write source, table, the written key decoded, and the delay until the new result was sent. A rerun with no invalidation shows its reason.
  - `GET /api/debug/query_cache` shows the query cache's counters, with misses by reason (new, evicted, invalidated, expired, snapshot), and its biggest entries with their read sets.
  - `GET /api/debug/invalidations` follows new invalidations as a long poll.

  The history ring holds 8 entries per execution by default. Set it with `SUBSCRIPTION_INVALIDATION_HISTORY` or the server option `invalidationHistory`; 0 turns recording off. `@bunvex/values` gains `keyToValues`, the inverse of `valuesToKey`. `@bunvex/core` gains `describeBound`, `boundText` and `keyValueText`.

- 899b394: The system tables and their documents match Convex's (STUDY-133 PR 8, §12), so the two binaries open each other's stores:
  - the summary checkpoint has an entry for every table;
  - `_index_worker_metadata` keys an index by its internal id;
  - a Convex zip package is read;
  - the four system tables bunvex lacked are created empty;
  - a push leaves the root component's rows;
  - job and cron argument bytes are serde_json's text (`jsonText` in `@bunvex/values`);
  - push audit rows carry `udfConfigDiff` and `_creationTime` in index fields;
  - an empty table gets no schema validation attempt;
  - an id's shape is a literal first.
  - functions' `Blob` and `File` (and an HTTP action's `request.blob()`) give the File API's type, so a stored file keeps the type the app gave (`text/plain`, not Bun's `text/plain;charset=utf-8`).
- dc97491: Values nest at most 64 levels, as Convex's (`MAX_NESTING`): a function's arguments 63 (Convex parses `[args]`), its result 64, a written value 64 (a patch: each field). Past it the call fails with Convex's message, `Invalid arguments for m.js:fn: Value is too nested (nested 65 levels deep > maximum nesting 64)`, `Function m.js:fn return value invalid: …` or `` Invalid argument `value` for `db.insert`: … ``, in Convex's order (nesting, then size, then validator; a written value before its table and document). A value of any depth fails with the message instead of overflowing the stack (DV-363). `@bunvex/values` exports `MAX_VALUE_NESTING`, `TOO_NESTED_MESSAGE` and `measureRawValue` (size and nesting in one walk); `fromJsonValue` and `copyValue` refuse a value past the limit (STUDY-109).

### Patch Changes

- f55e37c: Validation messages show a bigint literal validator as Convex does, `v.literal(<bigint>)`, and a NaN or infinite one as `v.literal(<number>)`.
- 4fb5d5e: Matches Convex at `precompiled-2026-10-07-d8bdde0` (STUDY-137):

  - A failed nested call reads `Uncaught Error:` once, however deep.
  - Messages: the concurrency limit names the kind in the plural; a `_system/` function refused without an admin reads "You don't have permission to perform this operation."; a skipped cron run names the job; an auth config typo fixed.
  - Write throughput can be limited by rows: each commit's document and index rows, `MAX_ROWS_WRITTEN_PER_SECOND` (off by default). Both `TooManyWrites` messages say "per second". `formatWindow` is no longer exported from `@bunvex/core`.
  - HTTP action responses go up to 100 MiB. Past that, the rest of the body is dropped with one error line and no size warning.
  - Module path errors read `Invalid module path '<p>': <reason>`.
  - A function or a symbol in an unsupported-value error prints as `"[Function]"` or its description.
  - Creating or updating an S3 export also needs ViewData.
  - `bunvex deployment usage-limits` accepts `--metric aiGatewayCostDollars` ("AI Gateway").
  - A commit published while `max_repeatable_ts` is being written gets its own bump after the commit delay.

- f2e3c4b: Floats in messages print as Convex prints them (Rust's `{:?}`): `1e16`, `5e-5`, `1.5e-7`, and an exact tie between two shortest candidates resolved upwards. The export's lossless JSON writes a positive exponent with a `+` (`1e+21`), as Convex's serde_json 1.0.151 does. Both are checked against Rust itself.
- f1cf707: Ids are built and checked without allocating, and a written document's size is measured once per write. The output is the same.
- 039d52d: A string with a lone surrogate (`"\ud800"`) is refused where Convex refuses it (STUDY-135). Writes, queries, nested calls and the scheduler fail with "Received invalid json: …", with serde's column. A function's result with one fails the function, and a client's arguments with one are "Invalid arguments provided". Log lines and error messages show U+FFFD in its place, and an application error whose data holds one has no data.
- f166aa2: The validator builders check their arguments as Convex's do, in its order and words. `v.object`, `v.array`, `v.record` and `v.union` given `undefined` (usually a circular import) throw "A validator is undefined … This is often caused by circular imports." when called. `v.literal` takes only a string, number, bigint or boolean, and `v.id` only a string table name. The non-validator messages are Convex's.
- 3cc30f0: Security: an error about a value that is not a supported value type no longer serialises class instances. Returning, writing or passing a query object, `ctx.db`, `ctx` or any class instance used to put its JSON in the message — for the engine's objects, the transaction with the catalog, the store's state and recent writes — and that message reaches the client. A class instance, `Map`, `Set`, `Date` or function context now prints as `Name {…}` (no field read, no `toJSON` or getter run), a cycle as `"[Circular]"`, and the walk stops at the message's 16 KiB limit. Plain data prints exactly as before. Validator messages (`displayValue`) follow the same rule.
- a177c47: The HTTP API and index writes are faster, with the same output:
  - object keys are ordered by UTF-8 bytes without encoding them;
  - floats between 1e-5 and 1e16 skip the general layout;
  - the latest value-format rewrites are kept, so a cached query's callers share one;
  - index keys write ASCII strings without encoding them;
  - a request body whose declared length is within the cap is read as is.

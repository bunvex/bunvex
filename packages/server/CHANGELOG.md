# @bunvex/server

## 0.1.0-alpha.2

### Minor Changes

- aba2963: What a route checks first, as Convex's backend does (checked against its binary):

  - The app metrics routes (`/api/app_metrics/*`) read their query arguments, and parse the window, `k` and the function path, before checking ViewMetrics. So bad arguments without a key are a 400, not a 403.
  - The log streams read their query string before checking ViewLogs.
  - A query-string error reads "Failed to deserialize query string: …".
  - A path that does not parse is the same internal error Convex gives.
  - The push routes (`/api/get_config_hashes`, `/api/deploy2/*`) take the admin key from the JSON body's `adminKey` only. The body is read first, with each route's request struct and serde's errors, so a body without `adminKey` is a 400 `BadJsonBody`. The `Authorization` header is not read. `bunvex deploy` and `bunvex dev` already send the key in the body.

- fe0972c: The function sandbox knob (AD-44): `BUNVEX_FUNCTION_SANDBOX` (and `--function-sandbox` on `bunvex-local-backend`,
  which wins over it) chooses where functions run, `vm` (the default, as before) or `process`, and
  `BUNVEX_FUNCTION_SANDBOX_ISOLATION` (`auto`, `namespaces`, `landlock`, `none`) its layers. `process` is not available
  yet: a start that asks for it fails with a message saying so. A value outside the lists fails at start too. Every
  load of pushed code now goes through one executor factory.
- fb0c977: `node.externalPackages` (STUDY-148): `bunvex deploy` leaves the listed packages (or every dependency, with `"*"`) as imports in the `"use node"` bundle, as Convex's CLI does, and names them and their installed versions in the push. The deployment installs them with `bun install` (running every install script), records Convex's `_external_deps_packages` row and blob, reuses one of the last ten installs with the same packages, counts them in the package size limit, and answers a failed install with Convex's 400 `InvalidExternalModules`. Node actions import and `require` them from a per-process directory (file modes kept), and they read the deployment's variables first.
- 5600a35: The admin routes read their query string and JSON body as Convex's extractors do, before checking the
  caller's operation (checked against Convex's binary):

  - Query-string errors read "Failed to deserialize query string: …", with serde_urlencoded's reasons.
  - Body errors carry axum's prefixes and serde's messages and positions, for every field type.
  - A body needs `Content-Type: application/json`.
  - A field given twice is refused.

  Also:

  - `list_audit_log_events` answers 400 `InvalidCursor` for a cursor that does not parse.
  - Streaming export's selection arguments fall back to everything, as Convex's untagged `SelectionArg` does.
  - `set_expiration` reads its nanoseconds exactly.

- 3556fd2: `bunvex.json` reads Convex's remaining keys (STUDY-145): `node` and `bundler` are checked with Convex's messages, in its schema's key order. `node.nodeVersion` is sent with the push; the deployment takes "20", "22" and "24", refuses "18" and anything else with Convex's 400 `InvalidConfig` messages, stores it in `_source_packages.nodeVersion`, answers it from `get_config_hashes` and diffs it in the audit log's `node_version_diff` (Node actions still run in Bun). `bundler.includeSourcesContent` keeps the original sources in the pushed source maps; by default they are left out, as Convex's esbuild does. The push sends `functions` as configured.
- f2be031: Streaming import's first routes (STUDY-141 PR 1), as Convex's `/api/streaming_import/*`, with ImportBackups:

  - `PUT clear_tables {tableNames}`: the tables are emptied in one commit, keeping their numbers and indexes. A missing table is created. One `clear_tables` audit event is recorded.
  - `GET get_schema`: the active schema's JSON, or `null`.
  - `POST replace_tables`: always `OverwriteNotSupported`.

  Names are made valid as Convex makes them (`source_` and a slug, transliterated as the `unidecode` crate does). The other streaming import routes are not built yet.

- deab272: `GET /api/debug/topology` (an admin key with ViewMetrics) reports the deployment's topology for the dashboard's
  Topology screen: this process as the leader alone, with its connections, subscriptions, query cache, commits per
  second, CPU and memory and a minute of samples, and the store with its driver and lease, read from counters the
  server already keeps. Each persistence driver names itself (`driver`), and the engine keeps its lease's holder and
  last renewal round trip (`leaseState`).

### Patch Changes

- eadda52: A failed `fetch` in an action is Convex's `TypeError`: reqwest's cause (connection refused, DNS, a closed connection) or `fetch to <url> failed: error decoding response body`, with the URL's query string, fragment and credentials dropped; an abort is Convex's `AbortError`. Redirects follow Convex's loop (20 hops, its errors and rules). Requests carry `User-Agent: Bunvex/1.0` by default (OIDC discovery and JWKS too) and no idle timeout; a redirect that sends the body again is metered per hop. bunvex's address screen reports a target it cannot reach as that failure, closes when a target closes early, and tries every address of a name.
- fbadec1: The audit log records log stream changes with Convex's configuration snapshots. `create_integration` and `delete_integration` carry `config`; `update_integration` (a webhook's secret rotation included) carries `previous`, `current` and `credential_changes`. The snapshots keep an allowlist of fields, cut every URL to its origin, and leave every credential out. A completed export's ZIP download is recorded as `download_export`, by the admin key's member, or by the member who asked for the download token.
- b050aef: `bunvex-local-backend` reports a mistaken command line as Convex's binary does (clap's messages): value names such as `<FUNCTION_SANDBOX>` and `<DENY_ADDRESSES>` (not `<FUNCTION-SANDBOX>`), the possible values, the tips, the usage lines and "For more information, try '--help'." instead of the whole help. `--port` and `--site-proxy-port` are checked as Rust's `u16` (an empty `--port=` is refused, not port 0) and `--interface` as an IPv4 address; a flag given twice is refused; `-p4000`, `--` and `help` / `keygen help` work. What is refused after the flags parse (the instance secret, the origins) is `Error: …` with exit 1, as Convex's; a secret that is not hex is "Couldn't hexdecode key".
- 2247a22: `BadDeployKey` (403, no admin key where an admin is required) now reads "The provided deploy key was invalid for this deployment. …" on every route, as Convex's backend words it. It used to name the deployment (STUDY-34).
- 0ea0a8d: Require Bun 1.4.4 or newer. CI, the Docker images and every package's `engines.bun` move off 1.4.2.

  A proxy that does not open an `https:` CONNECT fails with Convex's tunnel message: `proxy authorization required` for a 407, `unsuccessful` for any other status (before, the proxy's own 403 or 502 reached the app as a response). Bun 1.4.4 throws that refusal instead of answering it. An `https:` target that bunvex's address screen cannot reach still fails as it would without the screen. After an external package is installed, assigning `process.env` still writes the server's own environment.

- 3f01dcf: A client's queries and mutations run through the function call boundary (STUDY-194, STUDY-190 PR 2a): still in the main thread: the request and its outcome (the result, the read set, the writes) cross as the same objects, and as text in #878's format under the tests (STUDY-194 Q7; `Engine`'s `callCodec` option). A client's mutation takes its permit before its transaction begins, so its snapshot has what committed while it waited, as Convex's d328f85 (STUDY-186 A11); a session's request already committed is answered even without a permit; scheduled and cron mutations keep the old order. `@bunvex/core` exports the boundary (`Call`, `CallRunner`, the codec) and renames the request metadata type `CallRequest` to `RequestMetadata`.
- 73835d5: A component's function counts its start reads as Convex's backend does (STUDY-161 §16.7): its own modules (with the chunk Convex's library would be in) and one more read, and a component's write no longer counts its mounted check against the read limit.
- ddd0d0d: Matches Convex at `precompiled-2026-10-26-04d2f3b` (STUDY-193): every change STUDY-186 found after `precompiled-2026-10-10-72ce13c` that an app can observe is in, each with its own entry. These include log line limits by kind, no zipped package limit, Node 20 refused, `.staged()` field deltas, `paginate()` in component queries, the import and data sync limits, the mutation permit before the transaction, and `function.runtime` on log stream events. Four new Convex features keep their own studies: storage in mutations, `ctx.auth.signJwt`, the CLI's staged-schema output and `v.function()`.
- f7a2f41: A CSV import drops an empty cell in a field the active schema has optional at the top level (in any member of a union, `v.optional(v.string())` included), as Convex's. A required field, and a table outside the schema, keep `""`. Before, a CSV with a blank optional number failed schema validation.
- 4ece712: `/stats` is behind the API's CORS layer, so the dashboard on its own origin (its image, `bunvex dashboard serve`) can read it: its preflight is answered before the admin check, and its answers carry the origin. The health and CLI routes' answers carry the `vary` list twice, as Convex's. The dashboard reads the version from `/instance_version` (the meta `/version` stays outside the layer, as Convex's), so its header shows the deployment instead of "Deployment unavailable".
- 571c5b3: The dashboard's Data screen writes, as Convex's system functions: `_system/frontend/addDocument`,
  `patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage` and `createTable` (admin keys with
  `WriteData`), with Convex's arguments, answers, limits (4 096 documents per insert or delete, 4 000 per clear page)
  and refusals, each recording Convex's deployment audit event (`add_documents`, `update_documents`,
  `delete_documents`, `create_table`) with the documents' ids.
- e669eef: The dashboard's Functions and Settings system queries, as Convex's: `_system/frontend/modules:listForAllComponents`,
  `modules:list` and `modules:argsValidator` (the deployed modules, their analyzed functions with lines, HTTP routes
  and crons, and a function's arguments validator), `components:list`, `getVersion`, `cloudUrl` and `siteUrl`
  (Convex's `convexCloudUrl` and `convexSiteUrl`, renamed: DV-474), `listEnvironmentVariables`, `latestExport` and
  `snapshotImport:list`, each under Convex's permission.

  A snapshot import records the admin key's member that started it (`_snapshot_imports.member_id`), as Convex's
  backend does, instead of none.

- 497900c: `_system/frontend/indexes` and `GET /api/get_indexes` report a search or vector index's real state (backfilling, backfilled when staged and built, done), as Convex's, instead of "backfilling" for good: bunvex keeps those indexes' `_index` rows backfilling (DV-415), so the state comes from the engine, and a finished build writes the index's `_index_backfills` row so a subscription to the list hears it. The dashboard's index list shows search, vector and staged indexes as Convex's.
- 6e651a5: The dashboard's schedule and file system calls answer as Convex's backend: `POST /api/cancel_job` with an id that
  is not a scheduled job's is a 400 `InvalidId` ("Invalid ID for table \_scheduled_jobs") instead of a 500;
  `_system/frontend/fileStorageV2:getFile` answers null for an id that is not a storage id (a malformed one or a user
  table's), as Convex's masked `db.system.get`; `_system/frontend/paginatedScheduledJobs` matches `udfPath` exactly
  (the canonical `module.js:name` the dashboard sends) instead of also accepting `module:name`.

  The app metrics' subscription invalidations (`/api/app_metrics/subscription_invalidations_top_k`, the dashboard's
  Health) also count what Convex's scheduler and cron executor subscriptions count: `<mutation>:_scheduled_jobs` for a
  commit that schedules before the next future run, twice for a scheduled mutation's run, `<function>:_cron_next_run`
  for a cron run; the scheduler's own commits carry Convex's write-source names.

- 2a00ff2: Data sync follows Convex's latest. A hidden table (an import being written) is no longer synced; once active, it is truncated and walked as a new table. A by-id page that falls out of the index retention window walks the log instead of failing. Pages hold 20 000 rows by default (`DATA_SYNC_PAGE_SIZE_LIMIT`).
- 61a9ab5: The stored data is at Convex's `DATABASE_VERSION` 134 (STUDY-193 A14): a store gets Convex's `_s3_export_state` table (number 556, indexed `by_config_id`), and a store Convex's binary wrote at 134 opens without the "newer" warning. A store at 133 is refused, as any older version is (DV-418): move it with an export, then an import (docs/upgrading.md). The dashboard's `listConfiguredSinks` returns an S3 export's `exportProgress` when the store has its `_s3_export_state` row, as Convex's.
- 77e560f: No frame or path of the server reaches what an app sees of an error. In pushed code, `error.stack` is formatted as Convex's: in V8 the app's frames alone, mapped to its sources; in a `"use node"` action `Error: <message>` and those frames. An error the engine throws (`db.*`, the scheduler, storage, nested calls) carries the app's frames where it awaited the call (`at async …`), in the client's message, in `error.stack` and in logged lines. A pushed module's `BunvexError` is a class of its own realm, still `instanceof`-compatible with the engine's.
- 3d41523: Error messages as Convex's (checked against Convex's binary):

  - A cursor that does not open fails with the keybroker's message alone: "Failed to parse cursor",
    "Key is invalid for instance …", "Missing position field" (no `InvalidCursor: ` prefix). An empty cursor
    or end cursor is a cursor too, and fails to parse.
  - `paginate`'s options are checked where Convex checks them: no options is a `TypeError`; only a negative
    number or a non-number is "must be a positive number"; `numItems: 0` is "Must request at least 1 document
    while paginating"; a fractional, `NaN` or infinite size, a misfit `maximumRowsRead` / `maximumBytesRead`
    (a fraction, a negative number, a string…) and a cursor that is not a string fail with serde's message
    ("Invalid arguments for `queryPage`: …"), in Convex's field order. A null limit is no limit (it read nothing
    before), and a fractional size is refused instead of rounded down.
  - A float in a `limit` or `queryPage` argument error is worded as serde_json's (`1e-7`, `1e+21`).
  - A system function's argument error is `Uncaught Error: <check>`, as Convex's system functions check their
    own arguments, instead of `ArgumentValidationError: <check>`.

- f7c6187: `bunvex/server` exports the `FunctionHandle_future` type, as Convex 1.48.0's: a function handle typed as a `FunctionReference_future`.
- b735691: `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`, the scheduler and crons accept a `FunctionReference_future`, as `convex` 1.48 does. `FunctionArgs`, `FunctionReturnType`, `OptionalRestArgs` and `ArgsAndOptions` read its `_fn`. `FunctionReference` carries Convex's `_fn` too, so a reference whose arguments do not take the caller's is not a `FunctionReference_future`. `FunctionReference_future` now lives in `@bunvex/protocol` and is re-exported from `bunvex/server`.
- 8700316: `BUNVEX_FUNCTION_SANDBOX=process` (with `BUNVEX_FUNCTION_SANDBOX_ISOLATION=none`, no OS isolation yet) runs pushed queries and mutations in a separate process, each `ctx` operation on the server's transaction (STUDY-171 §8); actions, HTTP actions, components and rooms say they are not available there yet.
- 6ea0bb2: The push evaluates its auth config and schema through the function executor (`evaluateDefault`), with no change in behaviour, and `@bunvex/server/executor` exports the executor seam for the function sandbox's child runtime (STUDY-171 §7).
- 4677584: An HTTP action's streamed body that fails after the head ends the response cleanly (the client keeps what was sent), with Convex's `error:httpAction` line (`Uncaught <error>` and its frames); one that fails in the handler's turn fails the run, answered with the 500, as Convex's.
- fc479ca: The error for an HTTP action's streamed body chunk that is not bytes is now worded as bunvex's own (DV-529): `HTTP action response body chunks must be an ArrayBuffer or a view of one, got <type>`, and `HTTP action response body chunks must not be a resizable ArrayBuffer or a view of one`. When it fails, and what the client and the log see, are unchanged.
- 1095634: An HTTP action's 500 `code` carries the error's message whole, as Convex's: every line of a multi-line message, a trailing newline, and a nested call's frames that are part of its message (`Server Error: Uncaught Error: line one\nline two`). It used to keep the first line only.
- d94ae3d: An HTTP action's response gets the headers Convex gives it: a string body's `text/plain;charset=UTF-8`, a Blob's own type (not Bun's MIME table's), `Response.json`'s `application/json` (over an explicit type too), each in the function's `response.headers` as soon as it is built, and the `content-length` of any body that is not a stream (a HEAD request included). Untyped bytes past Bun's first chunk still go chunked (DV-483, accepted).
- 112f669: An HTTP action is logged as Convex logs it: its Completion, `function_execution` event and app metrics by the route that matched (`GET /files/*` for a prefix route) once it ran to the end, its lines by the request (`GET /files/abc`, HEAD as GET). A failed run, a client that left, or a request no route matches keeps the request's name and is not measured; a request no route matches is now logged with its 404.
- 8b023c3: An HTTP action whose handler returns something other than a Response is logged as failed, with Convex's error (`Uncaught Error: HTTP actions must return a Response`), not as a success; it is still answered with the 500.
- 0a54a2e: An HTTP action's streamed body whose chunk is not bytes (a string, a number, an object, a shared or resizable buffer) fails as Convex's: in the handler's turn the run fails with the 500, after the head the response ends cleanly with an `error:httpAction` line, both with `Uncaught Error: serde_v8 error: invalid type; expected: buffer, got: <type>`. A string chunk is no longer sent as text. A null or undefined chunk is skipped, as Convex, instead of ending the body with an error line.
- 32c0219: An HTTP action's 500 keeps the newline at the end of its `trace`, as Convex's: after the last frame, or after the message when the error has none (`"Uncaught a string\n"`).
- 65d1737: Imports are bounded as Convex's. An upload part past 64 MiB is a 400 `ImportPartTooLarge` (`MAX_IMPORT_UPLOAD_PART_BYTES`). A JSON Lines line, or a CSV record, past 16 MiB with its line ending fails the import with `JsonLineTooLarge` / `CsvRecordTooLarge` (`SNAPSHOT_IMPORT_MAX_LINE_SIZE_BYTES`). A JSON Lines line that is not UTF-8 is reported in Rust's words. A failed import's message is no longer prefixed "Hit an error while importing:" when the error is one of Convex's own import errors (a bad row, a missing CSV field, a BOM, an existing table), as on Convex.
- 823507c: An instance secret written with a `0x` or `0X` prefix is accepted, as Convex accepts it (`--instance-secret`, `INSTANCE_SECRET`, `keygen admin-key`, `bunvex admin-key`), and is the same secret as its bare spelling: the same admin keys, cursors and storage, export and import tokens. A hex secret in uppercase now derives the same keys as in lowercase too. `0x0x…` and `0x` alone are still refused with Convex's messages.
- 4cbbb65: `bunvex-local-backend` and its `keygen admin-key` read the instance secret from `INSTANCE_SECRET` when
  `--instance-secret` is absent (the flag still wins), and `bunvex dev` and the Docker image pass it there instead
  of on the command line, which every user of the machine can read (DV-525, STUDY-170).
- d2b717a: `bunvex-local-backend` (and the Docker image) reads the database variables Convex's binary reads: `POSTGRES_TIMEOUT_SECONDS`, `MYSQL_TIMEOUT_SECONDS` (and `MONGODB_TIMEOUT_SECONDS`) bound one database call, and `PG_CA_FILE` / `MYSQL_CA_FILE` add a trusted CA. They were read only by a server embedded with `persistenceConfigFromEnv`; the executable always used the defaults. The image's entry script also turns S3 on when only `S3_STORAGE_SEARCH_BUCKET` or `S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET` is set (STUDY-38 §7).
- d4946a1: Log stream events name a function as Convex's do: `function.path` is the stripped path (`messages:send`, a default export's module alone), no longer `messages.js:send`, in `console`, `function_execution` and exception events and in the Sentry and PostHog payloads built from them. A nested call's console line keeps its canonical path, as on Convex. `function.cached` is `false` on an action's streamed console lines, as on Convex, where it was `null`.
- 7f1b03e: Log stream `console` and `function_execution` events carry `function.runtime`, as Convex's do now: `"bunvex"` for a function that runs in bunvex's isolate runtime (Convex says `"convex"`), `"node"` for a `"use node"` action, and `null` for an action that failed before it ran (no such function, or arguments its validator refused).
- b534664: Log line limits by kind, as Convex's: an action (V8, HTTP or `"use node"`) keeps 1024 lines and a query or mutation 256, the last of them the overflow notice ("Log overflow (maximum N). Remaining log lines omitted."). An action's streamed lines stop at its limit too. The limits are Convex's knobs: `MAX_LOG_LINES_V8_ACTIONS`, `MAX_LOG_LINES_NODE_ACTIONS` and `MAX_LOG_LINES_DATABASE_UDFS`.
- 0572b42: Nested calls count their reads as Convex's backend does (STUDY-161 §16.7): only the first nested call in a transaction reads its callee's start (two reads, one more from a component, one more into another namespace, and the callee's modules), later ones nothing; resolving a component reference is not counted.
- 2012ca8: `require` works in `"use node"` modules (STUDY-148): Bun's bundle turns `require(…)` of a builtin (also inside bundled CommonJS dependencies) into `import.meta.require(…)`, which the server's modules lacked, so such an action failed with "`__require` is not a function". Each Node module's `import.meta.require` is now a `require` from the module's place, as Convex's executor sets `require` to `createRequire(<module path>)`; builtins resolve, other packages do not (no `node_modules` beside the modules yet).
- 326e98b: In functions, `new Response(body, { status })` with a body and a null body status (204, 205 or 304) throws a `TypeError` "Response with null body status cannot have body", as Convex's runtime does. `Response.json` and an empty string count as bodies.
- 87fde6b: An OCC conflict on a component's table names that table in its message, and the function log's `occInfo.componentPath` is the component's path (null at the root), as Convex's. Before, the message said "some table" and the path was always null.
- 60aae8d: PBKDF2 in queries, mutations and V8 actions is bounded as in Convex's runtime: `crypto.subtle.deriveBits` and `deriveKey` reject with an `OperationError` "too many iterations" when the iterations times the output's bytes (64 at least) pass 150 000 000, and "cannot generate more than 524288 bits" past 64 KiB. A `"use node"` action has no bound, as Node's.
- 3b82fa1: `bunvex/server` and `bunvex/values` export every name Convex 1.46.0's `convex/server` and `convex/values` export, with Convex's shapes (STUDY-180), but the rule-5 renames and the five deprecated ones (DV-543). `ctx.storage` is typed by `StorageReader`, `StorageWriter` and `StorageActionWriter`: a query's or a mutation's has no `store`, and ids are `Id<"_storage">`. `ctx.vectorSearch` is typed by the table's vector indexes and a filter by the index's filter fields. `SchemaDefinition` has `doc()` / `id()`; `FieldTypeFromFieldPath` goes over each member of a union; `SearchFilter` is a class the search filter builder's objects extend; `asObjectValidator`, `NumericValue` and `VOptional` are in `bunvex/values`, and `v.optional` returns a `VOptional`. `DefaultFunctionArgs` is `Record<string, unknown>`.
- bc36f50: `start_push` (and `evaluate_push`) answer each module's analysis as Convex's: the crons as
  `[{identifier, spec}]` in identifier order, each spec's arguments the bytes of their JSON text, and
  `sourceMapped: null`. A cron with an int64 argument no longer makes the push fail with a 500. `_modules` rows
  keep their crons in identifier order too, as Convex's.
- c366b9d: A pushed module reads the deployment's variables at import (`const key = process.env.KEY` at the top of a file) from the push that installs it, as Convex's analysis gives modules its environment variables. Before, the version a push installed had read none at import (they appeared only after a restart).
- c279803: A query runs the function its arguments were checked against. Code that landed while the query waited for its permit no longer ran the new handler on arguments only the old validator had accepted.
- d1543b1: Reads count toward the 4 096-read limit as Convex's backend counts them (STUDY-161 §16): per index, the merged intervals a function read (a document read again or patched after a get, adjacent or overlapping ranges add nothing), not the engine's own reads (table and index metadata, a new document's id, a search's terms), plus Convex's reads at a function's start, a table's creation and a first nested call. What subscriptions and OCC record is unchanged.
- 607fd19: A push with `node.nodeVersion` "20" is refused, as on Convex now that Node 20 is end-of-life: a 400 `InvalidConfig` "Node 20 is no longer supported. Upgrade to a newer Node version." on `start_push`, `evaluate_push` and `evaluate_schema`, like "18". "22" and "24" are accepted. Code pushed with "20" before keeps running.
- f6745eb: `schema.tables` is Convex's record of table definitions (`schema.tables.messages.validator`, `docValidator("messages", schema.tables.messages)`), the schema's own fields are Convex's (`tables`, `strictTableNameTypes`, `schemaValidation`), and a table definition has Convex's experimental `" indexes"()`. The engine reads `declaredTables(schema)`.
- ad46d5f: Only the scoped `@bunvex/*` packages exist (npm refuses the name `bunvex`): a pushed module's `@bunvex/server` and `@bunvex/values` are linked to the server's own, and `bunvex/server` or `bunvex/values` no longer are; `bunvex codegen` always writes `@bunvex/*` imports.
- 6d4fc1f: A `Set` or `Map` where a value goes now fails with Convex's text, its entries included (`Set[1] is not a supported
value type.`), also from a pushed function, whose `Set` is its own context's and printed as `Set {…}`. A result is
  converted before its size, nesting and `returns` checks, and scheduled and nested-call arguments (which must be an object) before anything
  else, so their messages are Convex's. `scheduler.runAt` takes a pushed function's own `Date`. An object that only
  claims the `ArrayBuffer` tag is an object, not empty bytes (STUDY-18 §9).
- dac285e: A push error located through the definition's source map shows the original line only when the mapped column is within it, as Convex's: past the line's end, the error names the generated position and nothing more. The line's length is its UTF-8 bytes, as in Convex, which also sets how many `~` mark it.
- df255f4: `GET /stats` reports `subscriptions`, the queries subscribed across every session now: the dashboard's `subscriptions` counter (UI-01 §5.2, STUDY-149).
- 8d28fb4: `ctx.storage.getUrl`, `getMetadata`, `delete` and an action's `get` refuse another table's id with Convex's
  message alone ("Invalid storage ID. Storage ID cannot be an ID on any table other than '\_storage'."), no longer
  wrapped as an argument error. An id that does not parse keeps the wrapper, and its text is now Convex's to the
  character, including the line break and indentation in Convex's source string (checked against Convex's binary). A legacy UUID that names no file is shown lower-cased in
  `delete`'s "storage id … not found", as Convex parses it.
- 0ec64a4: A subscription's query looks in the query cache the HTTP API uses, as Convex's sync worker does. A Next.js page's `preloadQuery` and its client's subscription run the query once, and a page reload with no commit in between is a cache hit ("(cached)" in Logs), not a run.
- b4880bd: `_system/debug/systemTables` marks `_file_storage` and `_scheduled_jobs` as `appVisible` (apps read them through `db.system` as `_storage` and `_scheduled_functions`); every system table read as private before, so `bunvex data --system` printed them `private`. The dashboard's Data screen now lists and opens the system tables on a deployment (STUDY-131 AD-24).
- 057fd69: The unawaited-operations warning lists what Convex's does: `ctx.meta`'s calls, `createFunctionHandle`, `log.audit` and an HTTP action's multipart `formData()` count too, and a call left unawaited is listed even when it answered at once (its answer is handed over in the next turn of the event loop, as Convex's tasks are).
- 06c53d7: Pushed functions match Convex in three places (STUDY-171 §9): `process.env` no longer reads `Object.prototype` names (`process.env.constructor` is unset unless set); `db.vars.commitTs` inside a pushed function's objects is refused in scheduled arguments and resolved in a mutation's result; and a cached query result expires after 17 s only when the query read the time (the server's app metrics no longer read the deterministic clock inside every query).
- c2ac7a5: `db.insert`, `db.patch`, `db.replace` and `db.count` word their argument errors as Convex's backend (STUDY-161 §1, §2): a table name that is not an identifier gives the identifier's own message under `` Invalid argument `table` for `db.insert`:  ``; a value that is not an object is "Value must be an Object" under the value's prefix; a missing value is `Must provide arg 2 …`. A deployed function's value nested past the limit keeps the argument prefix, and a `db.vars.commitTs` inside one of its objects resolves.
- 166c25d: A push is no longer refused for its zipped size, as on Convex since it dropped that limit: the 90 000 000-byte zipped check and its `MAX_ZIPPED_PACKAGES_SIZE` knob are gone. The 230 000 000-byte unzipped limit stays.
- Updated dependencies [eadda52]
- Updated dependencies [2088702]
- Updated dependencies [0ea0a8d]
- Updated dependencies [7af9a1f]
- Updated dependencies [3f01dcf]
- Updated dependencies [a11b239]
- Updated dependencies [017ef5b]
- Updated dependencies [73835d5]
- Updated dependencies [497900c]
- Updated dependencies [61a9ab5]
- Updated dependencies [3d41523]
- Updated dependencies [beca1af]
- Updated dependencies [b735691]
- Updated dependencies [8700316]
- Updated dependencies [823507c]
- Updated dependencies [7d97595]
- Updated dependencies [0572b42]
- Updated dependencies [fb0c977]
- Updated dependencies [67bb45e]
- Updated dependencies [87fde6b]
- Updated dependencies [3b82fa1]
- Updated dependencies [e84cf7a]
- Updated dependencies [d1543b1]
- Updated dependencies [c3b026b]
- Updated dependencies [d4ef462]
- Updated dependencies [77572e8]
- Updated dependencies [f6745eb]
- Updated dependencies [6d4fc1f]
- Updated dependencies [1408599]
- Updated dependencies [88d2e14]
- Updated dependencies [0ec64a4]
- Updated dependencies [5cb27ae]
- Updated dependencies [07ad661]
- Updated dependencies [deab272]
- Updated dependencies [d2207bc]
- Updated dependencies [7b1ef5f]
- Updated dependencies [06c53d7]
- Updated dependencies [c2ac7a5]
  - @bunvex/core@0.1.0-alpha.2
  - @bunvex/values@0.1.0-alpha.2
  - @bunvex/protocol@0.1.0-alpha.2
  - @bunvex/auth@0.1.0-alpha.2
  - @bunvex/file-storage@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- 866197d: Actions time out, as Convex's: 1800 s (`V8_ACTION_USER_TIMEOUT_SECS`), 600 s for a `"use node"` action (`NODE_ACTION_USER_TIMEOUT_SECS`), counted from when the action holds its permit, awaited calls included. Past it the action fails with Convex's message (`Function execution timed out (maximum duration: 1800s)`, or `` Action `name` execution timed out (maximum duration 600s) ``), a user error for its caller, the function log, a scheduled job (`failed`) and an HTTP action (500); its permit is freed. The cut-off handler can no longer call `ctx` (database, scheduler, storage, vector search, other functions) or `fetch`, and its fetches in flight are aborted (STUDY-77).
- 9e4de66: The deployed auth providers are stored in `_auth`, as Convex's (STUDY-129): one document per provider, put in a push's commit and when a variable or canonical URL change re-evaluates `auth.config`. A start checks tokens against them instead of evaluating `auth.config` again. `finish_push` answers the put's `authDiff` (it was always empty), the audit event carries the same diff, and `_system/frontend/listAuthProviders` lists the documents.
- de1140c: The client announces its own package version (0.x) instead of the Convex client version it followed (1.46.0).
  The server no longer applies Convex's client deprecation thresholds (bunvex sets none of its own yet; a version
  that does not parse is still a 400), and it splits big transitions into chunks for every client
  (STUDY-139 P1–P3, DV-442).
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

- 3bbb247: Postgres and MySQL connections now require TLS by default and verify the server's certificate (chain and host name), as Convex does; `DO_NOT_REQUIRE_SSL` (any non-empty value) turns the requirement off, and `PG_CA_FILE` / `MYSQL_CA_FILE` add a trusted CA. Postgres sessions must be read-write (`target_session_attrs=read-write`). Convex's `POSTGRES_URL`, `MYSQL_URL` and `DATABASE_URL` are accepted as aliases of `PERSISTENCE` / `PERSISTENCE_URL`; the URL must name the database. **Breaking for local databases without TLS:** set `DO_NOT_REQUIRE_SSL=1`.
- 618386b: `POST /api/delete_scheduled_functions_table`, as Convex's (STUDY-113): with WriteData, the scheduled functions' table is replaced with an empty one in one commit, whatever it holds, with a `delete_scheduled_jobs_table` audit event; a job running meanwhile finds its document gone and records nothing. `Engine.replaceWithEmptyTables` is bunvex's `replace_with_empty_table`.
- ef876d1: Without `--http-proxy`, bunvex screens actions' `fetch`, auth discovery and log streams itself (beyond Convex; DV-325): `--deny-addresses metadata` (the default: link-local and cloud metadata addresses), `private` (also loopback and private networks) or `none` (Convex's behaviour). `createServer({ denyAddresses })` / `BUNVEX_DENY_ADDRESSES` for embedded servers.
- f280986: Function arguments are checked against Convex's value limits before the call (DV-439): an array over 8192 elements
  or an object over 1024 fields fails with Convex's message ("Invalid arguments for <path>: Array length is too long
  (…)"; a nested call's "Invalid argument `args` for `runUdf`: …"; the scheduler's; a system function's "Uncaught
  Error: Invalid arguments: …") instead of running. `measureRawValue` reports the first such container as `tooBig`.
- da1ea24: Function errors and log lines as Convex returns them: `BunvexError` data as `errorData`, `[Request ID: …] Server Error` messages with redaction (`REDACT_LOGS_TO_CLIENT`), HTTP 200 for function errors and `{code, message}` for request errors, and `console.*` lines returned as `logLines`.
- 0c2945f: The health routes, as Convex's (STUDY-112): `GET /instance_version` and `GET /version` (also on the site port) answer `@bunvex/server`'s version instead of `bunvex`; `GET /` answers that the deployment is running; `POST /echo` streams the body back, up to `MAX_ECHO_BYTES` (default 128 MiB; 413 past it). No auth, CORS as the API's; another method is a 405 with `allow`.
- b799cdb: The SSRF proxy, as Convex's `--convex-http-proxy`: `bunvex-local-backend --http-proxy <url>` (or `createServer({ httpProxy })` / `BUNVEX_HTTP_PROXY`) sends actions' `fetch`, auth providers' discovery and JWKS, and the webhook, Datadog, Axiom and PostHog log streams through a screening proxy, each request named by the instance (`Proxy-Authorization`). A 407 refuses a request with Convex's `Request to <url> forbidden`. Without a proxy the backend warns at start, as Convex's.
- 1a4930f: Subscriptions and invalidation inspector (STUDY-131 AD-25, a bunvex addition). These admin endpoints need ViewMetrics:

  - `GET /api/debug/subscriptions` lists every live query per sync session: function, args digest, ts, whether the result was cached, documents and bytes read, and the read set as index ranges with their bounds decoded to values. It also shows the last invalidations: commit ts, write source, table, the written key decoded, and the delay until the new result was sent. A rerun with no invalidation shows its reason.
  - `GET /api/debug/query_cache` shows the query cache's counters, with misses by reason (new, evicted, invalidated, expired, snapshot), and its biggest entries with their read sets.
  - `GET /api/debug/invalidations` follows new invalidations as a long poll.

  The history ring holds 8 entries per execution by default. Set it with `SUBSCRIPTION_INVALIDATION_HISTORY` or the server option `invalidationHistory`; 0 turns recording off. `@bunvex/values` gains `keyToValues`, the inverse of `valuesToKey`. `@bunvex/core` gains `describeBound`, `boundText` and `keyValueText`.

- 1d0ef4d: The `log` export, as Convex's: `log.audit(body)` in a query or mutation adds an audit log line (keys may not start with "$"; nested calls' lines join their caller's), resolved when the function ends with `log.vars` (`requestId`, `ip`, `userAgent`, `now`, and `bunvexActor`, Convex's `convexActor`, null on a self-hosted deployment) and sent to the log streams as `custom_audit` events; Convex's limits (500 lines, 100 KB a line, 4 MB in all, 4 MB held) answer HTTP 400 with their code; actions refuse it. A sink subscribed to every topic leaves `custom_audit` out (STUDY-82).
- 83aab58: The deployment serves its OpenAPI 3.1 documents, as Convex: the platform API at `GET /api/v1/openapi.json`, the dashboard routes at `/api/dashboard_openapi.json` and the function API at `/api/public_openapi.json`, as pretty JSON with no auth. They document the routes bunvex has, with Convex's paths, operation ids and schemas; the platform API's security scheme is the admin key, `Authorization: Bunvex <key>` (STUDY-115). Any other `/api/v1/` path is 404.
- 40a120c: Traces over OpenTelemetry (STUDY-131 AD-26, beyond Convex): with `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, the server exports spans over OTLP/HTTP JSON to Jaeger, Tempo, Honeycomb or any OTLP receiver. One trace per HTTP request or WebSocket message: the function run (path, kind, cache hit, documents and bytes read), its index reads (one span per index), its commit (wait, validate, write), the sync transition and the queries it re-ran; scheduled jobs and cron runs are traces of their own. A `traceparent` header continues the caller's trace. Configured by the OpenTelemetry SDK's variables (`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_BSP_*`), or the `tracing` server option. Off by default, at no measurable cost; `/stats` reports the spans exported, dropped and failed.
- 96c97c6: A Prometheus `/metrics` endpoint on the API and site ports, as Convex's: no auth, on by default, 404 `MetricsDisabled` with `DISABLE_METRICS_ENDPOINT=true`. It serves bunvex's own `bunvex_*` series (functions by kind, the committer, sync with the argument-size histograms, the scheduler, search indexes, the process) with standard `le` histograms (DV-377, DV-378).
- 0e6004b: The HTTP server serves at most 128 requests at once, the API's and the site's together, as self-hosted Convex (`ConvexHttpService`); past it a request waits its turn, first come first served, with no error. A request holds its permit until its response head (a streamed body does not count), the wait does not count toward the 300 s timeout, and WebSocket upgrades and `/version` are exempt. `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` sets the limit (DV-364); `createServer` takes `maxConcurrentRequests` (STUDY-110).
- 66a1bc5: `bunvex run --inline-query '<js>'` evaluates a readonly query on the deployment, as Convex's: an expression is returned, statements are kept, a module whose default export is a query is sent as is (its builders from `bunvex:/_system/repl/wrappers.js`). The server gains Convex's function tester, `POST /api/run_test_function`: the module analyzed alone, its default query run once, uncached, logged with the `Tester` caller (STUDY-119).
- 20c1b83: While search and vector indexes are rebuilt after a start, searches get Convex's bootstrapping answer instead of `IndexBackfillingError`: `SearchIndexesUnavailable` ("Search indexes bootstrapping and not yet available for use") or `VectorIndexesUnavailable`, a system error a query or mutation cannot catch (HTTP 503 with its code), a plain `Error` in an action. Over the sync protocol a query that hits it is skipped and run again after `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY` (3 s); a mutation closes the session with 1013 and the code; a scheduled mutation runs later. An empty search string finds nothing in every index state. A new index a push adds still answers `IndexBackfillingError` (STUDY-79).
- 4ac2aa2: Search and vector index segments are read from disk, memory-mapped, instead of held in memory, as Convex's: a local store's segment files are mapped in place, and an S3 store's go through a local cache (`<local storage>/search_cache`; the engine's `searchCacheDir` option). `LocalBlobStore.filePath` names a blob's file (STUDY-111).
- 3509dc9: Deleting a file removes its `_storage` row only, as Convex (STUDY-130): the blob stays in the store, so an export or a download that read the file at an earlier snapshot still finds it. bunvex's own `_storage_deletions` table, the post-commit blob removal and the hourly orphan sweep are gone (`STORAGE_DELETIONS_TABLE`, `FileStorage.sweepDeleted`, `sweepOrphans` and `startFileSweeps` removed). Disk use is no longer reclaimed (DV-150 reversed).
- f4b35bf: System tables can be browsed (STUDY-131 AD-24, a bunvex addition). The system queries `_system/debug/systemTables` and `_system/debug/systemTable` list every system table the catalog has, private ones included, with a one-line description each, and page through one's documents as stored. They are read-only, need an admin key with ViewData, and function code cannot call them. `bunvex data --system` lists the tables, and `bunvex data --system <table>` prints one's documents. `SYSTEM_TABLE_DESCRIPTIONS` sits next to `SYSTEM_TABLE_NUMBERS` in `@bunvex/core`.
- dc97491: Values nest at most 64 levels, as Convex's (`MAX_NESTING`): a function's arguments 63 (Convex parses `[args]`), its result 64, a written value 64 (a patch: each field). Past it the call fails with Convex's message, `Invalid arguments for m.js:fn: Value is too nested (nested 65 levels deep > maximum nesting 64)`, `Function m.js:fn return value invalid: …` or `` Invalid argument `value` for `db.insert`: … ``, in Convex's order (nesting, then size, then validator; a written value before its table and document). A value of any depth fails with the message instead of overflowing the stack (DV-363). `@bunvex/values` exports `MAX_VALUE_NESTING`, `TOO_NESTED_MESSAGE` and `measureRawValue` (size and nesting in one walk); `fromJsonValue` and `copyValue` refuse a value past the limit (STUDY-109).
- 95a77e9: The write throughput limit, as Convex's: every commit's bytes count in a 1 s window per deployment (`MAX_BYTES_WRITTEN_PER_SECOND`, 4 MiB; `WRITE_THROUGHPUT_WINDOW`, 1000 ms; Engine option `writeThroughput`). Each attempt of a mutation run by the function runner checks it first and is retried within the OCC budget, then fails with `TooManyWrites` (HTTP 429; the sync protocol closes with 1013 `TooManyWrites`). Scheduled mutations and crons wait instead of failing, and imports wait before each batch (STUDY-78).
- 6e57741: A WebSocket connection's mutations run one at a time, in the order they were sent, as in Convex; more than 1000 pending mutations close the connection with 1013 `TooManyConcurrentMutations`.
- 144d575: A deployed code package is stored as Convex's zip (`modules/<path>`, `modules/<path>.map`, `metadata.json`) instead
  of one gzip JSON blob (DV-166 resolved to match). A package an earlier version wrote is not read: the server logs it
  and starts without code, and the next `bunvex deploy` replaces it.

### Patch Changes

- 419640e: An action's `fetch` takes `http:` and `https:` only, as Convex: another scheme (`file:`, `data:`, `s3:`, …) is Convex's `TypeError`, and Bun's own options (`unix`, `proxy`, `tls`, `s3`) are ignored. A `"use node"` action's `fetch` fails as Node's on what Node's refuses.
- c501d15: The push analysis gives each function and HTTP route its source position (`pos: { path, start_lineno, start_col }`), read from the module's source map as Convex reads it, and lists them in source order; HTTP routes take Convex's `{ route: { path, method }, pos }` shape. The CLI's source maps now match the pushed modules: the `// @bun` line dropped from each module is dropped from its map too (every mapping was one line off).
- b4a51b3: A store failure in a background worker no longer ends the process. The startup cron registration (`createServer({ crons })`) retries a failed diff with the cron executor's backoff (500 ms to 15 s), logging each failure, and starts the executor once it commits; `cronsReady` resolves then (or with `undefined` if the server stops first) and never rejects. Before, a read error during it was an unhandled rejection and the process exited with code 1 and no message. The cron executor's loop now backs off as Convex's does instead of waiting a fixed second. The export and import workers retry a failed read of their queue (they used to wait for the next request) and no longer let a store error escape while recording a failed export or dropping a failed import's tables.
- 5d0a395: Value formats and the isolate compute metric carry bunvex's names (DV-307, DV-308). `format` (HTTP function API and streaming export) accepts `json` or `clean_json`, `encoded_json` and `export_json`; Convex's `convex_encoded_json`, `convex_clean_json` and `convex_json` are now a 400 `BadFormat`. `BunvexHttpClient` and the CLI ask for `encoded_json`, so a client and a server from before this change do not mix. The usage-limit metric `actionComputeConvexGbHours` is now `actionComputeIsolateGbHours`.
- 1b56759: A commit listener that throws still stops the committer (fail-stop), but is no longer reported as a persistence failure: the `CommitterStoppedError` reads "the committer stopped after an internal error in commit listener "<name>": …", its cause is a new `CommitListenerError` naming the listener (`onCommit(fn, name)`; the server's are named) with the original error as its cause, and `persistenceFailure` is false. The commits of the batch being published, which are durable and visible, are acknowledged instead of left hanging; later ones are refused.
- a365529: Security: `console.log(ctx.db)`, `console.log(ctx)`, a query object or `ctx.db.system` no longer prints the engine's state into the log lines sent to the caller, the function log and the log streams (the catalog, the store, other transactions' writes, ~32 KB a line). Engine objects now print as their name, `Tx {…}`, under object-inspect, `util.inspect` and `Bun.inspect`; app values print as before (DV-321).
- f2fe91b: The cron executor checks a cron before looking up its function, as Convex. A cron that a push deleted together with its function, after the executor had picked it, used to be retried as a system error forever: an error logged every few seconds, and the cron's slot never freed. It is now dropped, as Convex drops it.
- 09edbb5: The database globals in `_db`, as Convex's (STUDY-126): `{version, awsPrefixSecret, storageType}`, written at the store's first start. `bunvex-local-backend` pins its storage there at every start: a store started with a local directory refuses `--s3-storage` (and back) with Convex's message, a moved directory is recorded, and the S3 key prefix is `<instance name>-<uuid>/`, refused for another instance. `_instance` keeps the instance secret and name only; `Engine.instanceSetting` is replaced by `Engine.initializeStorage`.
- ab11407: Arguments nested thousands of levels deep are refused with the nesting message at once, instead of after the ~1.6 s
  a stack-overflowing `JSON.stringify` takes in Bun (STUDY-109).
- a7d2e6c: `defineTable` no longer refuses a validator a table cannot have when it is called, as Convex's. A push refuses it: one that is not an object, a union of objects or `v.any()` gives `InvalidTopLevelTypeInSchemaError` with Convex's message, and one whose JSON is not an object gives `InvalidSchemaExport`.
- b4e70f9: `bunvex dev` waits on the table a schema validation failed on, as Convex's: once that table changes (a fixed document), it pushes again with no file change. The failure prints Convex's `✖ Schema validation failed.` and the error. The server gains Convex's `_system/cli/queryTable` (STUDY-120).
- dff094d: `/api/update_environment_variables` accepts a batch that names a variable more than once, as Convex: removals are applied first, then sets by name and value. Removing a variable and setting it again in one batch (a dashboard rename onto a deleted name, or swapping two names) used to fail with `EnvVarNameNotUnique`. The audit log records the batch in the order it is applied.
- eacb804: Changing an environment variable re-evaluates `auth.config` with the canonical URLs applied, as a push, a restart and a canonical-URL change already did. Before, an auth provider whose `domain` is `process.env.BUNVEX_SITE_URL` fell back to the raw site origin after any variable changed, and tokens from the canonical issuer were refused until the next push or restart.
- 6c0f49b: `evaluate_schema` reports staged validators as Convex's: each table's staged validation state and progress (`staged`), whether the active schema's staged validation, once valid, would spare the push the table's walk (`canSkipAfterStagedValidation`), and the pending or valid staged validations the push would throw away (`discardedStagedValidators`, `replaced` when it stages another validator). The dashboard's `getSchemas:stagedSchemaValidationProgress` lists the active schema's staged validations (DV-438, STUDY-106 §7).
- a703235: Registered functions have Convex's `exportArgs()` / `exportReturns()` (own properties, internal): their validators' JSON, `{"type":"any"}` without `args` and `"null"` without `returns`. The push's analysis and `apiSpec` read them, with Convex's errors for a broken export, and `apiSpec` (so `bunvex function-spec`) reports `returns: null` for a function without a `returns` validator, as Convex. A function whose `args` is a validator other than an object or `v.any()` now fails the push, as on Convex, and an export's validator JSON is parsed fully as Convex's backend parses it (its checks and messages; the stored JSON is the one Convex serializes back).
- 4189cdd: An HTTP action whose client went away before the response head could be sent is logged as Convex logs it: the execution fails with "Client disconnected" in the function log (and log streams), instead of a success. The handler still runs to the end and what it wrote stays, as before.
- a990ad0: An HTTP action whose client leaves while its body streams ends its log lines with `[INFO] Client disconnected` (system code `info:httpActionClientDisconnect`), as Convex: the line is sent as its own progress entry and the run is logged with the response's status. A HEAD request or a body read to its end gets no such line. The run no longer gets a spurious `Controller is already closed` error line when the client leaves while a chunk is being read.
- c95bac7: An import's hidden table copies the enabled indexes of the table it replaces as Convex's `create_empty_table` does: each copy starts `Backfilling`, the table is backfilled and the copies enabled before the import writes into it. Staged indexes are not copied, and a table still backfilling an index cannot be replaced (Convex's `InvalidImport`).
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
- 039d52d: A string with a lone surrogate (`"\ud800"`) is refused where Convex refuses it (STUDY-135). Writes, queries, nested calls and the scheduler fail with "Received invalid json: …", with serde's column. A function's result with one fails the function, and a client's arguments with one are "Invalid arguments provided". Log lines and error messages show U+FFFD in its place, and an application error whose data holds one has no data.
- 313cbbc: `bunvex mcp start`: a Model Context Protocol server for AI tools, as Convex's `npx convex mcp start`, over stdio with the official MCP SDK. Tools: `status`, `data`, `tables`, `functionSpec`, `run`, `envList`, `envGet`, `envSet`, `envRemove`, `runOneoffQuery`, `logs`. A self-hosted deployment is production for its guards (`--cautiously-allow-production-pii`, `--dangerously-enable-production-deployments`). The server gains `_system/frontend/getSchemas` (STUDY-121).
- e0e3f06: A push with more than 4096 function files fails with Convex's message, "Too many function files (N > maximum 4096) in "bunvex/".". Files under `_deps/` still do not count, but a push may hold at most 8192 modules in all, as in Convex. A push that fails unexpectedly now answers 500 `InternalServerError`, as Convex's, and logs the cause.
- dcdbd13: A mutation whose result is not a value (`undefined` inside an array, a function, a symbol, a class instance such as a `Date`) now fails as a whole, as in Convex: the result is converted inside the run, so none of its writes commit. Before, the writes committed and only the response failed. A nested `ctx.runMutation` that fails this way rolls back its own writes; the caller may catch the error and go on. Found by the differential tests (STUDY-122).
- 1bdc51e: A nested call's arguments (`runQuery`, `runMutation` and `runAction` from a query, a mutation or an action) reach the callee as Convex's do: a copy with each object's fields sorted and no `undefined` field. The callee got the caller's own object, so changing it changed the caller's, and its fields kept their order.
- 2983a19: A nested call's result (`ctx.runQuery`, `ctx.runMutation`, `ctx.runAction`) crosses a JSON boundary, as in Convex: the caller gets `null` where the callee returned `undefined`, a copy of the value (changing it changes nothing in the callee), no `undefined` fields, and object fields in sorted order. A result that is not a value (a `Date`, say) fails the call.
- d67c23e: A caught error from a nested call reads as Convex's. A `BunvexError` from a nested query or mutation now has the callee's uncaught message ("Uncaught BunvexError: …" and its frames) with its data, where it had the data's text alone. An action that catches a failed `runQuery`, `runMutation` or `runAction` now gets the callee's uncaught message (with `BunvexError` data), where it got the callee's own error. Refusals before the callee runs are unchanged.
- 275e274: A deployed code package bunvex cannot read (such as the zip in a store Convex deployed to) is no longer read by a
  zip reader: it is ignored with a log line, the server starts with no code, `get_config_hashes` declares no module,
  and the next deploy replaces it. Before, such a package failed every deploy (STUDY-139 P4).
- 5e704cb: Convex's OCC retry budget and error: 4 retries with full-jitter backoff from 100 ms to 2 s, a wait for the conflicting write before retrying, and `OccError` (`OptimisticConcurrencyControlFailure`) with Convex's message; HTTP mutations that exhaust it answer 503. Also fixes a lost wake-up in the committer.
- 8d72c7e: An OCC conflict caused by one of bunvex's own writers describes it by what was done, as Convex's (DV-435): "An edit in the dashboard", "A Fivetran sync", "An Airbyte sync", "A data import" or "A system operation"; a call to the app's function still reads `A call to "<path>"`. Every system write source is now under `_system/`.
- a3e3923: A push's package is size-checked as Convex's, first in `start_push`: 90 000 000 bytes zipped (the
  `MAX_ZIPPED_PACKAGES_SIZE` knob), then 230 000 000 unzipped (was 230 MiB), each refused at the limit with a 400
  `ModulesTooLarge` and Convex's message in binary units (was a plain error at `finish_push`).
- 4d6aa4e: A push answers its index changes as Convex's: `start_push`'s `schemaChange.indexDiffs` (a dry run's too) and `finish_push`'s `indexDiff` list each added, removed, enabled and re-staged index with its definition, not just its name. `bunvex deploy` prints them as Convex's CLI does: "Added table indexes:", "Added staged table indexes:", "Deleted table indexes:", "These indexes are now enabled:", "These indexes are now staged:", or "Would …" on a dry run, each index as `table.index   fields`.
- 6d45f93: Functions in the isolate no longer see the deprecated RegExp statics (`RegExp.$1`, `lastMatch`, `input`, …), which held the last match across calls; Convex's runtime deletes them (DV-436). `"use node"` modules keep them.
- d635000: The scheduled job a function runs under now reaches the mutations and actions a scheduled action calls (`ctx.runMutation`, `ctx.runAction`), as Convex propagates `parent_scheduled_job` down the call tree. Canceling a running scheduled action now also cancels what those functions schedule (they are born canceled), so an "action → mutation → schedule the next step" loop stops on cancel; and a mutation it calls cannot cancel that job ("A mutation cannot cancel itself").
- 6368cbe: The scheduled job executor counts a system error (`stats.systemErrors`) once the failed attempt is recorded on the
  job, as it counts a failed job once it is stored.
- 1f5849b: A schema file whose default export is not a schema fails the push (and `evaluate_schema`) with Convex's `InvalidSchemaExport`, and one with no default export (or `null` / `undefined`) with Convex's `MissingSchemaExportError`, instead of `InvalidSchema`.
- 9e453ce: A pending schema's validation is persisted as Convex's (STUDY-127): `_schema_validations` holds one attempt per walked table (`pending` → `valid`), and `_schema_validation_progress` its counters, flushed every 5 % of the table or 500 documents. A failed, overwritten or activated schema's attempts are deleted. A start deletes every attempt and walks a still-pending schema again (before, it stayed `pending`). The dashboard's `_system/frontend/getSchemas:schemaValidationProgress` reads them.
- 382f4b9: Writes are refused while a ready search or vector index has 100 MiB unflushed (`SEARCH_INDEX_SIZE_HARD_LIMIT`, `VECTOR_INDEX_SIZE_HARD_LIMIT`), as Convex's overloaded `TextIndexTooLarge` / `VectorIndexTooLarge`: HTTP 503 with the code, the sync session closed with 1013, a scheduled job retried, a plain `Error` in an action. The refusal wakes the flusher (STUDY-111, DV-228 resolved).
- 587a148: Search and vector indexes are persisted as segments in the `search` blob store (STUDY-111): a memory part over its soft limit (`SEARCH_INDEX_SIZE_SOFT_LIMIT`, 10 MiB; `VECTOR_INDEX_SIZE_SOFT_LIMIT`, 30 MiB) is flushed into a new segment, a new index is stored as a segment before it is ready, and a clean shutdown flushes every index. A start loads the segments and replays only the writes since, crash or not, instead of reading the tables; a state it cannot trust (another definition, outside retention, a missing blob) is not used. No search blob is ever deleted, as Convex's. The clean-shutdown snapshot (STUDY-96) is no longer written; one already written is still read for an index with no segments.
- 81c7621: Every search and vector index has its `_index` row, as Convex's: `config` in Convex's serialized shape (`type`, the spec's fields, `onDiskState` `backfilling` / `backfilling2` / `snapshotted` with the segment list), staged indexes included (STUDY-111). The segments' state lives there instead of a persistence global. The clean-shutdown snapshot (STUDY-96) is removed; the engine's `searchSnapshots` option is now `searchStorage`.
- f3c1a64: Text and vector indexes are segments plus a memory part (STUDY-111): `SegmentedTextIndex` and `SegmentedVectorIndex` search their segments and memory part together with the statistics of the whole index, so their answers are the single in-memory index's, scores bit for bit; they flush the memory part into a segment and compact segments. The engine keeps every index in its memory part until the flusher arrives. Vector results with NaN scores are now ordered by internal id among themselves, as Convex's, rather than by how the index was built.
- 2b760fe: Search index workers as Convex's (STUDY-111): every `DATABASE_WORKERS_POLL_INTERVAL`, a memory part older than `SEARCH_WORKERS_MAX_CHECKPOINT_AGE` is flushed and idle indexes are fast-forwarded in the new `_index_worker_metadata` system table, so a start replays nothing older and document retention never overtakes an idle index.
- 6ee62d3: A staged validator its validation proved now stands in for the walk, as Convex's: pushing an enforced validator that accepts everything a `valid` staged validator of the active schema accepts needs no walk (`supersetOfStagedValidated` in `evaluate_schema`), and passes the `StagedSchemaWithEnforcedValidatorChanges` check. Deleting or replacing a table a staged validator points to with `v.id` fails that staged validation ("Table … is referenced by the staged validator for … but was deleted or replaced; redeploy to revalidate …") (DV-438, STUDY-106 §7.4).
- 1749e82: Staged validators get their `_schema_validations` rows, as Convex's: one per table with a `.staged()` validator, with its `validatorHash` (the sha256 of the validator's text, equal to Convex's), made by the push, carried over from the outgoing schemas when it can be reused, kept when the schema becomes active, and retried by a push of the same schema; at a start the active schema's staged rows start over as `pending`. A push that stages a validator on a table whose enforced validator change needs its documents walked is refused with Convex's 400 `StagedSchemaWithEnforcedValidatorChanges` (`start_push`, dry run too, and `evaluate_push`) (DV-438, STUDY-106 §7).
- 0295b08: `defineTable(...).staged(validator)`, as Convex's: the table's next document validator (an object of fields or a validator), serialized as `stagedDocumentType` and stored with the schema, so a change to it alone is a new schema version. A second call throws; a staged validator that is not an object, a union of objects or `v.any()` fails the push with `InvalidTopLevelTypeInSchemaError`. As on Convex, nothing checks documents against it, and the document type is unchanged. `TableDefinition`'s list of staged index names is now `stagedIndexes`.
- ec3c770: A file download's egress is the bytes actually sent, as Convex: `dataEgressGb` grows as the body streams (a download the client cuts short counts what went out, a range counts the range), and once it ends one `storage_api_bandwidth` log stream event carries the file's id and those bytes. A HEAD request sends a 0-byte event. In Bun the metered body goes out chunked: a GET download no longer sends `content-length` (HEAD still does; DV-324).
- b3940ff: A pushed module that does not compile or link reports `Uncaught SyntaxError: <message>` alone, as Convex's isolate does, without the server's own frames (STUDY-95 §6).
- e46ace6: Cron and `_udf_config` rows as Convex stores them (STUDY-134): `_cron_jobs.cronSpec` with int64 schedule numbers
  (an absent `minuteUTC` null) and the arguments as the bytes of their JSON, `_cron_next_run.nextTs` / `prevTs` and
  `_cron_job_logs.ts` as int64 nanoseconds, an in-progress state's `request_id` / `execution_id`, a logged result's
  value as its JSON text, `_modules.analyzeResult.cronSpecs` as `[{identifier, spec}]`, and
  `_udf_config.importPhaseUnixTimestamp` as int64 nanoseconds. `bunvex deploy` sends its package version as
  `udfServerVersion`, stored as `_udf_config.serverVersion`.
- 03f5b8a: `_modules` and `_source_packages` rows have Convex's shapes (STUDY-134): a module's `sha256` in base64, its analysis with `sourceMapped` and int64 positions, a package's `sha256` as bytes, `packageSize` as int64 zipped and unzipped sizes, `externalPackageId` and `nodeVersion` null. The pushed `schema.js` and `auth.config.js` are stored as modules, as Convex's.
- 3e2bcf3: `_schemas` rows as Convex writes them (STUDY-134, DV-423): `state` is an object (`{ state: "active" }`, `{ state: "failed", error, table_name }`, …), and `schema` is the text of Convex's `DatabaseSchemaJson` — tables and indexes by name, `_creationTime` at the end of each index's fields, every index list present, `vectorIndexes`' legacy `dimension: null`, `stagedDocumentType: null` without one, object fields by name, a table's top-level system fields left out and float literals as serde_json writes them. The deployment audit log's `schemaDiff` and the push's `evaluate_schema` answer carry the same JSON.
- 509eaaa: `_system/` functions now behave as in Convex's local backend, checked entry point by entry point. Before this, function code could call any `_system/` query or mutation.

  Only an admin or the system acting as itself reaches them. Everyone else, an admin acting as a user included, is refused before the function is looked up:

  - `/api/query`, `/api/mutation` and sync: the function's error, "Operation query|mutation not permitted".
  - `/api/action`: 403 `SystemIdentityRequired`.
  - `/api/run/_system/…` and scheduling: "Operation get_module not permitted".
  - A nested `ctx.runQuery` / `ctx.runMutation`: "Could not find public function".

  For an admin:

  - A missing system function gets Convex's module messages.
  - `/api/run` and `/api/function` answer "Could not find function".
  - `/api/action` answers 500.
  - A nested call runs.

  An action's `runQuery` / `runMutation` / `runAction` never resolves a system function, whoever runs the action: "Couldn't resolve api.\_system.…".

- 975b496: Every write bunvex makes on its own now carries a source under `_system/` (35 labels missed by DV-435: crons, log
  streams, usage limits, environment variables, the scheduler's system errors, the index and schema workers, pushes,
  snapshot imports), so an OCC conflict they cause reads "A system operation" (or "A data import" for an import's
  index step), as Convex's, instead of `A call to "<internal label>"`.
- 6142d0a: `/api/run_test_function` reads the deployment's import seed and time without writing them: before any push it uses a fresh seed, as Convex's uncommitted transaction does, and commits nothing (STUDY-119 §7).
- e5851ce: A `Runtime` for the engine's clock and timers (`runtime` option of `Engine`, `realRuntime` by default), and a `TestRuntime` with virtual time (`@bunvex/core/test-runtime`) for tests. The user-time budget of functions and the concurrency limiters' wait timeout read it. Nothing changes in production.
- a177c47: The HTTP API and index writes are faster, with the same output:
  - object keys are ordered by UTF-8 bytes without encoding them;
  - floats between 1e-5 and 1e16 skip the general layout;
  - the latest value-format rewrites are kept, so a cached query's callers share one;
  - index keys write ASCII strings without encoding them;
  - a request body whose declared length is within the cap is read as is.
- e572862: Convex's system table layout: files are stored in `_file_storage`, scheduled jobs in `_scheduled_jobs` with their arguments in `_scheduled_job_args`, in Convex's document shapes. `_storage` and `_scheduled_functions` are virtual tables over them, read through `db.system` with the same ids; filters on them see the virtual fields, and `db.system.get` / `db.get` refuse the other kind of table as Convex does. Data stored by earlier versions is not read.
- 4411174: The sync socket's heartbeat is Convex's: a WebSocket ping every 5 s, and a client that sent nothing (no message, pong or ping) for 120 s is closed with 1000 `ClientDisconnected`. Close frames follow Convex's mapping: 1000 with the short code for `NotFound`, `PaginationLimit`, `Forbidden` and `ClientDisconnect` (a `FatalError` first for `Forbidden`), and a close without a code arrives as 1005, as Convex's. `createServer({ wsHeartbeat })` shortens the timings for tests.
- Updated dependencies [419640e]
- Updated dependencies [866197d]
- Updated dependencies [9e4de66]
- Updated dependencies [659e400]
- Updated dependencies [f55e37c]
- Updated dependencies [8518f1b]
- Updated dependencies [1b56759]
- Updated dependencies [a365529]
- Updated dependencies [4fb5d5e]
- Updated dependencies [4894096]
- Updated dependencies [09edbb5]
- Updated dependencies [a7d2e6c]
- Updated dependencies [618386b]
- Updated dependencies [f280986]
- Updated dependencies [bcf7066]
- Updated dependencies [dff094d]
- Updated dependencies [6c0f49b]
- Updated dependencies [f2e3c4b]
- Updated dependencies [25c9dc9]
- Updated dependencies [da1ea24]
- Updated dependencies [f1cf707]
- Updated dependencies [c95bac7]
- Updated dependencies [fe9c7e6]
- Updated dependencies [92007b0]
- Updated dependencies [1a4930f]
- Updated dependencies [899b394]
- Updated dependencies [039d52d]
- Updated dependencies [a293cd6]
- Updated dependencies [749ad53]
- Updated dependencies [5e704cb]
- Updated dependencies [8d72c7e]
- Updated dependencies [40a120c]
- Updated dependencies [cc06646]
- Updated dependencies [9702a35]
- Updated dependencies [0fbd9b6]
- Updated dependencies [96c97c6]
- Updated dependencies [1936703]
- Updated dependencies [4495763]
- Updated dependencies [3751b64]
- Updated dependencies [e8d876e]
- Updated dependencies [4798f6d]
- Updated dependencies [9e453ce]
- Updated dependencies [20c1b83]
- Updated dependencies [2f5dc44]
- Updated dependencies [90cef9b]
- Updated dependencies [4a23a44]
- Updated dependencies [382f4b9]
- Updated dependencies [a19b158]
- Updated dependencies [4ac2aa2]
- Updated dependencies [587a148]
- Updated dependencies [81c7621]
- Updated dependencies [f3c1a64]
- Updated dependencies [2b760fe]
- Updated dependencies [9ebaaed]
- Updated dependencies [6ee62d3]
- Updated dependencies [1749e82]
- Updated dependencies [c515f8d]
- Updated dependencies [88c9ac8]
- Updated dependencies [0295b08]
- Updated dependencies [3509dc9]
- Updated dependencies [7747b60]
- Updated dependencies [841b66c]
- Updated dependencies [3e2bcf3]
- Updated dependencies [416b14b]
- Updated dependencies [509eaaa]
- Updated dependencies [b408ccd]
- Updated dependencies [f4b35bf]
- Updated dependencies [975b496]
- Updated dependencies [8bcf6de]
- Updated dependencies [e5851ce]
- Updated dependencies [1c2e062]
- Updated dependencies [f166aa2]
- Updated dependencies [3cc30f0]
- Updated dependencies [1401f94]
- Updated dependencies [a177c47]
- Updated dependencies [dc97491]
- Updated dependencies [e572862]
- Updated dependencies [f857400]
- Updated dependencies [95a77e9]
  - @bunvex/core@0.1.0-alpha.1
  - @bunvex/values@0.1.0-alpha.1
  - @bunvex/auth@0.1.0-alpha.1
  - @bunvex/protocol@0.1.0-alpha.1
  - @bunvex/file-storage@0.1.0-alpha.1

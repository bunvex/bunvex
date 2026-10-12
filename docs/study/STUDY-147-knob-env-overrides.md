# STUDY-147 — Knob environment overrides

- **Status:** PR 1 implemented (the shared reader, every knob whose mechanism exists); PR 3a implemented (five
  defaults matched, §3.2); PR 3b implemented (`HTTP_SERVER_TIMEOUT_SECONDS` on every route, §3.3); PR 2 in parts (one PR each, §3.4):
  retention and the index backfill switch implemented, the rest planned
- **Convex source read:** commit `d8bdde0` of get-convex/convex-backend (`crates/common/src/knobs.rs`,
  `crates/cmd_util/src/env.rs`, `self-hosted/advanced/knobs.md`)
- **Related:** [platform.md](../parity/platform.md) "Knob env overrides"; STUDY-25 (store timeouts), STUDY-33
  (retention), STUDY-68 (concurrency), STUDY-78 (write throughput), STUDY-110 (request limit), STUDY-136
  (index cache); DV-112, DV-145, DV-364, DV-433

## 1. How Convex does it

`crates/common/src/knobs.rs` declares 315 tuning parameters (at `d8bdde0`), each a
`LazyLock<T> = LazyLock::new(|| env_config("NAME", default))`, read the first time the knob is used. About twenty
more live next to their crate (`POSTGRES_TIMEOUT_SECONDS` in `postgres/src/connection.rs`,
`USAGE_TRACKING_PERIOD_SECS` in `usage_gauges_tracking_worker`, the Searchlight knobs, …).

`env_config` (`cmd_util/src/env.rs:23-48`):

- an unset variable gives the default, silently;
- a value that parses as `T` (Rust's `FromStr`) is used, and when it differs from the default
  `tracing::info!("Overriding {name} to {v:?} from environment")`;
- a value that does not parse (or is not Unicode) gives the default with
  `tracing::warn!("Invalid value {s} for {name}, falling back to {default:?}: {e:?}")`. Never an error: a bad
  knob cannot keep the backend from starting.

What parses is the type's `FromStr`: `usize`/`u32`/`u64` digits with an optional `+` (no sign, no decimals, no
spaces, an empty string fails); `NonZeroU32` the same but not 0; `f64` decimals, exponents, `inf` and `NaN`;
`bool` exactly `true` or `false`. Durations are built from an integer (`Duration::from_secs(env_config(…))`,
`from_millis`), or `from_secs_f64` for a few. A handful are derived (`DATA_SYNC_MAX_ROWS_READ` is at least
`DATA_SYNC_PAGE_SIZE_LIMIT`; `MAX_ROWS_WRITTEN_PER_SECOND` of 0 means none).

`self-hosted/advanced/knobs.md` tells operators that every knob is an environment variable, set in
`docker-compose.yml`; the compose file forwards only a few (`DOCUMENT_RETENTION_DELAY`, the
`APPLICATION_MAX_CONCURRENT_*`, `HTTP_SERVER_TIMEOUT_SECONDS`, …), so others are added there.

Not every knob reaches a self-hosted backend: about 60 are declared but read by no open-source crate (Funrun, AWS
Lambda, Usher, Searchlight, Firehose, the AI gateway, Databricks seeding), and some are read but overridden
(self-hosted Convex passes a constant 128 for the request limit and never reads
`HTTP_SERVER_MAX_CONCURRENT_REQUESTS`, DV-364). `prod_override` gives four knobs another value under Nomad
(`NOMAD_ALLOC_ID`); a self-hosted backend has the local one.

Between `4577b9031` and `d8bdde0`: `MAX_ROWS_WRITTEN_PER_SECOND`, `WASM_UDF_*` and `MYSQL_MAX_FILL_CHUNK_ROWS`
were added, `MYSQL_CHUNK_SIZE` renamed `MYSQL_SMART_CHUNK_MAX_SIZE`, and `SEARCH_INDEX_WORKER_PAGES_PER_SECOND`,
`TABLE_SUMMARY_CHUNKS_PER_SECOND` and `MIGRATION_REWRITE_BATCH_SIZE` removed.

## 2. What an app can observe

- The limits an app runs into, when the operator changes them: transaction reads and writes
  (`TRANSACTION_MAX_*`), function argument and result sizes, nested call depth (`MAX_REACTOR_CALL_DEPTH`), the
  OCC retry budget, action and query timeouts, environment variable counts, module counts, scheduling limits.
- The warnings: `FUNCTION_LIMIT_WARNING_RATIO` and the limits it is a ratio of.
- That a deployment with a mistyped knob starts, with the default and a warning in its log.

The other knobs change timing and throughput only (retention, backfill, write batching, workers, pools).

## 3. How bunvex does it

`packages/core/src/knobs.ts` is the one reader, exported from `@bunvex/core` (and `@bunvex/core/knobs`, for the
isomorphic `bunvex/server` entry, which must not pull in the engine):

- `knob(name, default, kind, env)`, with `kind` `uint` (`usize`, `u32`, `u64`), `positive` (`NonZeroU32`) or
  `float` (`f64`), parsing as Rust's `FromStr` does;
- `boolKnob(name, default, env)`: exactly `true` or `false`;
- `secondsKnob(name, defaultSeconds, env)`: a `Duration::from_secs` knob, in milliseconds.

Unset gives the default; an unparsable value logs Convex's warning line and gives the default; a value other
than the default logs Convex's "Overriding" line. Each line is logged once per process, as a `LazyLock` is read
once: an engine or server built many times (tests, the CLI's local backend) does not repeat it. A constant knob
is read when its module loads; one read by a constructor (retention, index cache, scheduler options) when the
object is built, so an `Engine` or `createServer` option still wins over the environment, as before.

Before this, about twenty readers each had their own rules: some threw on a bad value
(`HTTP_SERVER_MAX_CONCURRENT_REQUESTS`, `MAX_ECHO_BYTES`, the retention delays, the scheduler's, the
concurrency limits, `INDEX_CACHE_SIZE`), some ignored it silently, some treated an empty string as unset. All go
through `knob` now (owner, 2026-10-11: as Convex). Two special cases keep Convex's effect:
`INDEX_CACHE_VERIFY_PERCENT` past 100 verifies every hit (Convex's `random_range(0..100) < percent`), and
`MYSQL_DOCUMENT_ENCODING` of a number other than 0 or 1 still refuses to open the store, as Convex fails on an
unknown encoding.

### 3.1 The knobs, classified

Every knob of `knobs.rs` at `d8bdde0`, plus those outside it, is in one of five groups. The full table, with
each knob's default and where bunvex keeps it, was checked file by file; it is summarized here.

**Read from the environment (131 after PR 1, 139 after PR 3a, 142 after PR 2's retention part, 143 after its backfill switch).** Everything bunvex has a mechanism for, under Convex's name and
default unless a decided divergence says otherwise:

| Area | Knobs |
|---|---|
| Transactions | `TRANSACTION_MAX_NUM_USER_WRITES`, `TRANSACTION_MAX_USER_WRITE_SIZE_BYTES`, `TRANSACTION_MAX_READ_SIZE_ROWS`, `TRANSACTION_MAX_READ_SIZE_BYTES`, `TRANSACTION_MAX_READ_SET_INTERVALS`, `TRANSACTION_MAX_NUM_SCHEDULED`, `TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES`, `MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES` (a warning only, as Convex), `TRANSACTION_MAX_NUM_FILES_WRITTEN`, `TRANSACTION_MAX_FILE_WRITE_SIZE_BYTES`, `TRANSACTION_MAX_NUM_FILES_READ`, `TRANSACTION_MAX_FILE_READ_SIZE_BYTES` (reported by `getTransactionMetrics`, never counted, as Convex), `MAX_TRANSACTION_WINDOW_SECONDS`, `UDF_EXECUTOR_OCC_MAX_RETRIES`, `UDF_EXECUTOR_OCC_INITIAL_BACKOFF_MS`, `UDF_EXECUTOR_OCC_MAX_BACKOFF_MS` |
| Functions | `FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`, `FUNCTION_LIMIT_WARNING_RATIO`, `MAX_REACTOR_CALL_DEPTH`, `DATABASE_UDF_USER_TIMEOUT_SECONDS`, `DATABASE_UDF_SYSTEM_TIMEOUT_SECONDS`, `V8_ACTION_USER_TIMEOUT_SECS` (also the action duration warning's limit), `NODE_ACTION_USER_TIMEOUT_SECS`, `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS`, `MAX_USER_MODULES`, `MAX_ZIPPED_PACKAGES_SIZE`, `ENV_VAR_LIMIT`, `ENV_VAR_TOTAL_SIZE_LIMIT`, `UDF_CACHE_MAX_SIZE` |
| Concurrency | `APPLICATION_MAX_CONCURRENT_QUERIES`, `_MUTATIONS`, `_V8_ACTIONS`, `_NODE_ACTIONS`, `APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT`, `APPLICATION_FUNCTION_RUNNER_ACTION_SEMAPHORE_TIMEOUT`, `HTTP_SERVER_MAX_CONCURRENT_REQUESTS` (DV-364), `HTTP_SERVER_TIMEOUT_SECONDS` (HTTP actions only until PR 3), `MAX_BYTES_WRITTEN_PER_SECOND`, `MAX_ROWS_WRITTEN_PER_SECOND`, `WRITE_THROUGHPUT_WINDOW` |
| Committer and write log | `COMMITTER_MAX_WRITE_BATCH_DOCUMENTS`, `COMMITTER_MAX_WRITE_BATCH_BYTES`, `INITIAL_PERSISTENCE_WRITES_BACKOFF_MS`, `MAX_PERSISTENCE_WRITES_BACKOFF_MS`, `MAX_REPEATABLE_TIMESTAMP_COMMIT_DELAY`, `MAX_REPEATABLE_TIMESTAMP_IDLE_FREQUENCY`, `WRITE_LOG_MIN_RETENTION_SECS`, `WRITE_LOG_MAX_RETENTION_SECS`, `WRITE_LOG_SOFT_MAX_SIZE_BYTES` |
| Caches | `INDEX_CACHE_SIZE`, `INDEX_CACHE_VERIFY_PERCENT` (DV-433) |
| Retention and cleanup | `INDEX_RETENTION_DELAY`, `DOCUMENT_RETENTION_DELAY`, `INDEX_RETENTION_DELETE_CHUNK`, `DOCUMENT_RETENTION_DELETE_CHUNK`, `DOCUMENT_RETENTION_RATE_LIMIT`, `DOCUMENT_RETENTION_BATCH_INTERVAL_SECONDS`, `RETENTION_CHECKPOINT_PERIOD_SECS`, `RETENTION_DELETE_BATCH`, `DOCUMENT_RETENTION_MAX_SCANNED_DOCUMENTS`, `RETENTION_DELETE_FREQUENCY`, `MAX_SESSION_CLEANUP_DURATION_HOURS`, `SYSTEM_TABLE_CLEANUP_FREQUENCY_SECONDS`, `SYSTEM_TABLE_CLEANUP_CHUNK_SIZE`, `SYSTEM_TABLE_CLEANUP_ROWS_PER_SECOND`, `TABLE_SUMMARY_MAX_CHECKPOINT_AGE`, `TABLE_SUMMARY_MAX_AGE_WITH_WRITES`, `TABLE_SUMMARY_AGE_JITTER_SECONDS` |
| Index backfill | `INDEX_BACKFILL_CHUNK_SIZE`, `INDEX_BACKFILL_CHUNK_RATE`, `INDEX_BACKFILL_READ_SIZE`, `INDEX_BACKFILL_PROGRESS_INTERVAL_SECONDS`, `INDEX_BACKFILL_CONCURRENCY`, `INDEX_WORKERS_INITIAL_BACKOFF`, `INDEX_WORKERS_MAX_BACKOFF` |
| Search | `SEARCH_INDEX_SIZE_SOFT_LIMIT`, `SEARCH_INDEX_SIZE_HARD_LIMIT`, `VECTOR_INDEX_SIZE_SOFT_LIMIT`, `VECTOR_INDEX_SIZE_HARD_LIMIT`, `SEGMENT_MAX_SIZE_BYTES`, `MIN_COMPACTION_SEGMENTS`, `MAX_COMPACTION_SEGMENTS`, `MAX_SEGMENT_DELETED_PERCENTAGE`, `DATABASE_WORKERS_POLL_INTERVAL`, `DATABASE_WORKERS_MIN_COMMITS`, `SEARCH_WORKERS_MAX_CHECKPOINT_AGE`, `SEARCH_INDEXES_UNAVAILABLE_RETRY_DELAY` |
| Scheduler and crons | `SCHEDULED_JOB_EXECUTION_PARALLELISM`, `SCHEDULED_JOB_RETENTION`, `SCHEDULER_OCC_INITIAL_BACKOFF_MS`, `SCHEDULER_OCC_MAX_BACKOFF_MS`, `SCHEDULED_JOB_INITIAL_BACKOFF_MS`, `SCHEDULED_JOB_MAX_BACKOFF_SECS`, `MAX_JOBS_CANCEL_BATCH`, `CRON_SPLAY_SECONDS` |
| Sync | `SYNC_MAX_SEND_TRANSITION_COUNT`, `SYNC_WORKER_QUERY_RETRY_INITIAL_BACKOFF_MS`, `SYNC_WORKER_QUERY_RETRY_MAX_BACKOFF_SECS`, `SYNC_WORKER_UPDATE_QUERIES_RETRY_INITIAL_BACKOFF_MS`, `SYNC_WORKER_UPDATE_QUERIES_RETRY_MAX_BACKOFF_SECS`, `SUBSCRIPTION_INVALIDATION_DELAY_THRESHOLD`, `SUBSCRIPTION_INVALIDATION_DELAY_MULTIPLIER` |
| Export, import, streaming | `SNAPSHOT_LIST_LIMIT`, `DOCUMENT_DELTAS_LIMIT`, `LIST_SNAPSHOT_MAX_AGE_SECS`, `DATA_SYNC_PAGE_SIZE_LIMIT`, `DATA_SYNC_PAGE_BYTES_LIMIT`, `DATA_SYNC_MAX_ROWS_READ`, `DATA_SYNC_PROGRESS_WRITE_INTERVAL_MS`, `DATA_SYNC_BY_ID_FRESHNESS_SECONDS`, `EXPORT_WORKER_PAGE_SIZE`, `EXPORT_PROGRESS_UPDATE_INTERVAL_SECS`, `MAX_EXPIRED_SNAPSHOT_AGE_DAYS`, `MAX_IMPORT_AGE_SECONDS`, `STORAGE_MAX_INTERMEDIATE_PART_SIZE` |
| Logs and metrics | `LOG_MANAGER_EVENT_RECV_BUFFER_SIZE`, `LOG_MANAGER_AGGREGATION_INTERVAL`, `AXIOM_MAX_ATTRIBUTES`, `AUDIT_LOG_MAX_LINES`, `AUDIT_LOG_MAX_LINE_SIZE_BYTES`, `AUDIT_LOG_MAX_TOTAL_SIZE_BYTES`, `AUDIT_LOG_MAX_HEAP_SIZE_BYTES`, `MAX_UDF_EXECUTION`, `UDF_METRICS_BUCKET_WIDTH_SECS`, `UDF_METRICS_MAX_BUCKETS`, `USAGE_LIMIT_EVALUATE_INTERVAL_SECS`, `USAGE_TRACKING_PERIOD_SECS`, `DISABLE_METRICS_ENDPOINT`, `MAX_ECHO_BYTES` (DV-375) |
| Stores | `POSTGRES_TIMEOUT_SECONDS`, `MYSQL_TIMEOUT_SECONDS`, `MONGODB_TIMEOUT_SECONDS` (bunvex's driver), `MYSQL_DOCUMENT_ENCODING` (DV-414), `MYSQL_MAX_CHUNK_BYTES` |

**Read after PR 2 (the mechanism changes first).** The retention knobs (done, §3.4); `INDEX_BACKFILL_ENABLE`
(done, §3.5); `MYSQL_MAX_QUERY_RETRIES` is
a fixed single retry shared with Postgres; the three `UDF_METRICS_*` histogram knobs need the histogram layout
computed from them; `UDF_404_ON_BAD_PATH` needs the 404 answer; `MYSQL_SMART_CHUNK_MAX_SIZE` (was
`MYSQL_CHUNK_SIZE`) and `MYSQL_MAX_FILL_CHUNK_ROWS` to map onto bunvex's MySQL chunking;
`POSTGRES_MAX_CONNECTIONS`, `MYSQL_MAX_CONNECTIONS` and the two `*_INACTIVE_CONNECTION_LIFETIME_SECS` beside
`POOL` (DV-112: bunvex's 16, "settings to add").

**Defaults to match Convex's, PR 3** (owner, 2026-10-11: match). Each reads its knob once it behaves as
Convex's. PR 3a did the first five (§3.2); PR 3b `HTTP_SERVER_TIMEOUT_SECONDS` (§3.3).

| Knob | Convex | bunvex before PR 3 |
|---|---|---|
| `SYSTEM_FUNCTION_MAX_RESULT_SIZE` | 24 MiB for `_system/` functions | no limit on them |
| `FINISH_PUSH_MAX_OCC_FAILURES` | 8 retries | the general budget, 4 |
| `VECTOR_INDEX_WORKER_PAGE_SIZE` | 128 documents a page, text and vector | 1000 |
| `SCHEDULED_JOB_GARBAGE_COLLECTION_*` | backoff 1 s → 30 s; batch of 100; 1 s after a batch; else until the oldest job expires | a fixed 30 s retry, a 60 s idle wait |
| `HTTP_CACHE_SIZE` | the JWKS/discovery cache bounded at 16 MiB | unbounded |
| `HTTP_SERVER_TIMEOUT_SECONDS` | 300 s on every route | HTTP actions only |

### 3.2 PR 3a: what Convex does and what bunvex does now

- **`SYSTEM_FUNCTION_MAX_RESULT_SIZE`** (`crates/isolate/src/helpers.rs` `deserialize_udf_result`): a
  `_system/` function's result is measured against 24 MiB instead of `FUNCTION_MAX_RESULT_SIZE`, with the same
  message. bunvex's system functions are its own code (`system-functions.ts`) and were not measured at all; now
  a system query's or mutation's result over the limit fails with that message
  (`Function _system/….js:default return value is too large (actual: …, limit: …)`). The 80 % warnings keep
  `FUNCTION_MAX_RESULT_SIZE`, as Convex's.
- **`FINISH_PUSH_MAX_OCC_FAILURES`** (`crates/application/src/deploy_config.rs`): `finish_push` retries 8 times,
  as it contends with the index backfills that write the `_index` rows it reads. bunvex's
  `commitSchemaPush` now takes that budget instead of `UDF_EXECUTOR_OCC_MAX_RETRIES`, with the same backoff.
- **`VECTOR_INDEX_WORKER_PAGE_SIZE`** (`crates/search_index_workers/src/search_flusher.rs`
  `incremental_table_scan_stream`): despite its name, the page of the table scan that builds any search index,
  text or vector. bunvex's three scans (the paged backfill with segments, and the in-memory text and vector
  builds) read pages of it. It is read as a non-zero integer: Convex's `usize` takes 0, which there ends the scan
  at once and leaves the index empty; here 0 keeps the default, as a value that does not parse. Measured:
  building a text and a 64-dimension vector index over 20 000 documents (memory store, with segments or in
  memory) takes 420–450 ms with pages of 128 or of 1000, three runs each: no difference to see.
- **`SCHEDULED_JOB_GARBAGE_COLLECTION_*`** (`crates/application/src/scheduled_jobs/mod.rs`
  `ScheduledJobGarbageCollector`): batches of `_BATCH_SIZE` (100) a transaction; after a batch it waits
  `_DELAY` (1 s); with nothing expired it waits until the oldest completed job leaves the retention window, or
  for a write to the table; on an error, a backoff from `_INITIAL_BACKOFF_MS` (1 s) to `_MAX_BACKOFF_SECS` (30 s)
  that a success resets. bunvex now does the same, with one difference no app sees: with no completed job at all,
  Convex waits for one to complete, bunvex waits one retention window (at least `_DELAY`), as no job completing
  meanwhile can expire sooner. Convex also halves the batch after a `PaginationLimit` error; a system
  transaction's reads and writes are not limited in bunvex (§3.1, `TRANSACTION_MAX_SYSTEM_*`), nor reached by
  Convex's batch of 100, so that path is not built.
- **`HTTP_CACHE_SIZE`** (`crates/http_client/src/lib.rs`): one process-wide moka cache of the auth discovery
  and JWKS responses, weighed as the URL's length plus the body's, at most 16 MiB. bunvex's cache is the token
  verifier's (one per auth config), now weighed the same way and bounded at the knob, the least recently used
  response evicted first; a response heavier than the bound is not kept.

**Kept out, by decision.** `MAX_PUSH_BYTES` (200 MB) and `MAX_BACKEND_PUBLIC_API_REQUEST_SIZE` (16 MiB + 2000 B):
bunvex has one request body cap, Bun's `maxRequestBodySize` (DV-145).

**No meaning in bunvex (89).** The mechanism differs:

- V8 and tokio: the isolate pools and recycling, heap caps (`ISOLATE_*`, `V8_THREADS`, `REUSE_ISOLATES`,
  `MAX_ISOLATE_WORKERS`, `RUNTIME_*`, `WASM_UDF_*`), the in-process function runner's caches (`FUNRUN_*_CACHE*`,
  `FUNRUN_MODULE_*`, `FUNRUN_CODE_CACHE_SIZE`, `FUNRUN_ISOLATE_ACTIVE_THREADS`);
- structures bunvex does not have: the CoDel queue, the committer's bounded channel and hold delay, the
  `TableIterator`, backfill markers, the source map cache, the subscription worker's channel, prefetch hints,
  Qdrant's threads and thresholds, MySQL's smart chunk sizes and Vitess fallbacks, prepared statement caches,
  HTTP/2 keepalives;
- tracing thresholds and samplers (bunvex traces with the OpenTelemetry variables, AD-26).

Two of them are differences worth knowing, not acting on here: system transactions have no write cap in
bunvex (`TRANSACTION_MAX_SYSTEM_NUM_WRITES`, `_WRITE_SIZE_BYTES`), and an action's time all counts as user time
(`V8_ACTION_SYSTEM_TIMEOUT_SECONDS`).

**Not in a self-hosted backend (65).** Declared but read by no open-source crate, or only by Convex's cloud:
Funrun, AWS Lambda, Usher, Searchlight, Firehose, the AI gateway, Databricks app-metrics seeding, the conductor's
instance loader, usage webhooks and emails, `LEASE_LOST_COOL_DOWN_SECS` (Nomad).

**Features bunvex lacks (7).** `COMPONENT_GET_USER_IDENTITY_LOG_SAMPLE_RATIO` (components, STUDY-62),
`INDEXES_LOG_LOOKAHEAD_BUCKETS` (MySQL's v6 layout), `AIRBYTE_STREAMING_IMPORT_REQUEST_SIZE_LIMIT` (STUDY-141 PRs
2–4), `ADMIN_IDENTITY_EXPIRATION_DELAY_SECS` and `_REVALIDATION_DELAY_SECS`, `SHOW_PII_IN_ERRORS` (error
reporting, parked), `TRANSACTION_WARN_READ_SET_INTERVALS` (a commit-time log of large read sets).

### 3.3 PR 3b: the request timeout on every route

**Convex.** `ConvexHttpService::new` (`crates/common/src/http/mod.rs`) wraps the whole backend router, the API's
routes and the site's (its proxy forwards into the same service), in tower's `TimeoutLayer` with
`HTTP_SERVER_TIMEOUT_DURATION` (300 s), under a `HandleErrorLayer` that answers `408 Request Timeout` with no
body; `/version` and `/metrics` are merged outside the layers. The layer sits inside the concurrency limit, so
the wait for a permit does not count. Tower's timeout races the future that yields the response, so:

- the handler's whole time to the response head counts, reading the request's body included: a storage upload,
  a one-shot import (`do_import` answers once the import is done), an `/api/action` call past 300 s answer 408;
- what is sent after the head is not timed: a download, an export, an HTTP action's streamed body;
- a WebSocket upgrade answers 101 at once and its socket runs apart;
- the handler's future is dropped at the timeout. An HTTP action runs in its isolate apart and keeps running.

**Apps observe** a 408 with an empty body on any route whose answer takes longer than 300 s, the knob changing
it.

**bunvex before.** Only HTTP actions had the 408, from their own timer, which started after auth. Every other
route ran under Bun's `idleTimeout` (120 s): a handler still working then had its connection closed with no
answer at all (an `/api/action` call of 150 s failed where Convex answers it); storage, imports and HTTP
actions turned the idle timeout off and had no limit.

**bunvex now.** `withRequestTimeout` (`packages/server/src/request-timeout.ts`) wraps both ports' handlers,
inside the request limit and outside CORS (Convex's 408 carries no CORS headers either): each request but a
WebSocket upgrade has Bun's idle timeout turned off and its handler raced against `HTTP_SERVER_TIMEOUT_SECONDS`;
past it, 408 with no body. The handler is left running, as it cannot be dropped; a response it makes later is
never sent and its body is cancelled. Uploads slower than the timeout answer 408, as Convex's (owner,
2026-10-12: match, the knob raises it). The HTTP actions' own timer is gone; `createServer`'s
`httpActionHeadTimeoutMs` option became `requestTimeoutMs`.

### 3.4 PR 2, retention: the delete caps and the backoff

**Convex** (`crates/common/src/knobs.rs`, `crates/database/src/retention.rs`,
`crates/common/src/persistence/row_index_retention.rs`): `RETENTION_DELETE_BATCH` (10 000) ends an index pass once
it has handled that many expired index entries (`row_index_retention.rs`); `DOCUMENT_RETENTION_MAX_SCANNED_DOCUMENTS`
(10 000) ends a document pass once it has scanned that many expired versions (`retention.rs`); in both, the next
pass follows at once. `RETENTION_DELETE_FREQUENCY` (Rust's `MAX_RETENTION_DELAY_SECONDS`, 60 s; its comment also
names a start delay that no code applies) caps the backoff after an error of the index deleter; the document
deleter's backoff is capped at `DOCUMENT_RETENTION_BATCH_INTERVAL_SECONDS` instead.

**bunvex before.** One option, `maxPerPass`, capped both passes, and none of the three was read from the
environment; one 60 s cap applied to every loop's backoff.

**bunvex now.** `indexMaxPerPass` (`RETENTION_DELETE_BATCH`) and `documentMaxScanned`
(`DOCUMENT_RETENTION_MAX_SCANNED_DOCUMENTS`) are apart; `maxBackoffMs` is `RETENTION_DELETE_FREQUENCY` for the
window advance and the index deleter, and the document deleter backs off up to `documentEveryMs`, as Convex's.
The caps are checked where they were (before each page of the log, so a pass may go one page past), not after
each deleted chunk as Convex's: where a pass stops differs by at most a page, which no app sees. With the
defaults nothing changes.

### 3.5 PR 2, `INDEX_BACKFILL_ENABLE`

**Convex** (`crates/common/src/knobs.rs`, read once in `crates/application/src/lib.rs` `Application::new`): `true` by
default; `false` ("likely only disabled if index backfill is breaking an instance") does not spawn the database
`IndexWorker`. The text and vector workers, the fast-forward worker and the schema worker still start. A new
database index then stays `Backfilling`: a query on it fails with `IndexBackfillingError`, `wait_for_schema`
answers in progress at each deadline so a push adding one never completes (a new table's too, backfilled by the
same worker), and an import of a table with indexes waits in `backfill_and_enable_indexes_on_table`.

**bunvex now** (owner, 2026-10-12: as Convex). `INDEX_BACKFILL_DEFAULTS.enabled` reads the knob; off, the three
places a database index backfill starts do nothing: the background worker (`startIndexWorker`), the immediate
backfill of a new table's indexes (`backfillNewTables`, so a push creating a table with indexes waits too, as
Convex's) and an import's hidden table (`createHiddenTable` waits, until the engine closes). Text and vector
indexes still build. Switched back on, the next start backfills from the `_index_backfills` checkpoints.

## 4. Divergences

None new. The reader matches `env_config`; the knobs whose defaults or scope differ are already decided:
DV-112 (pools of 16), DV-145 (one body cap), DV-364 (`HTTP_SERVER_MAX_CONCURRENT_REQUESTS` read, default 128),
DV-375 (`MAX_ECHO_BYTES` enforced), DV-414 (`MYSQL_DOCUMENT_ENCODING` default 0), DV-433
(`INDEX_CACHE_VERIFY_PERCENT` default 0). The defaults PR 3 changes are bugs to fix, not divergences (owner,
2026-10-11).

| # | Divergence | Why | Decision |
|---|---|---|---|
| K1 | A bad knob value: Convex warns and falls back; bunvex threw for some knobs and ignored others | — | owner, 2026-10-11: as Convex (resolved in PR 1) |
| K2 | Defaults that differ from Convex's with no decision (§3.1, PR 3) | — | owner, 2026-10-11: match Convex |

## 5. Tests

- `packages/core/test/knobs.test.ts`: the parsing of each kind against Rust's `FromStr` (digits and `+`, no
  signs, decimals, spaces or empty; `NonZeroU32` refusing 0; `f64` exponents, `inf`, `NaN`; `bool` exactly
  `true`/`false`), seconds to milliseconds, and each log line once.
- `packages/core/test/knobs-env.test.ts` and `packages/server/test/knobs-env.test.ts`: a process with every knob
  set to a value other than its default reads each one; a process with every knob set to text keeps every
  default, logs the warning and starts. Sabotage: a knob turned back into its literal fails the first; a reader
  that throws on a bad value fails the second.
- PR 3a: `function-size-limits` (a `_system/` result over its limit, the user limit not applied to it),
  `schema-push` (a push conflicting 8 times commits, 9 times fails), `search-backfill` (300 documents read in
  pages of 128 by each index, with segments or in memory), `scheduler` (the collector wakes when the oldest
  job expires; batches `gcDelayMs` apart; the defaults), `auth/verify` (the cache's bound, eviction of the
  oldest). Sabotage: each change reverted fails its test.
- PR 2, retention: `retention` (the index cap and the document cap apart, each stopping its own pass; the
  three knobs from the environment). Sabotage: either pass checking the other's cap fails a test.
- PR 2, backfill switch: `index-backfill-switch` (off, a push adding indexes on an existing and a new table stays
  in progress; on again, the next start completes it; the knob read as a bool). Sabotage: the worker and the
  new-table backfill left ungated fails it. The import path's wait is not tested on its own.
- PR 3b: `request-timeout` (an `/api/action` call past the timeout answers 408 with no body and the action
  finishes; a body streamed past it is not cut; a slow upload answers 408; a WebSocket stays open), and
  `request-limit` (the wait for a permit does not count). Sabotage: the API port unwrapped fails the first;
  the timeout put outside the limit fails the second.
- The readers' own tests now expect the default and a warning where they expected an error
  (`request-limit`, `health-routes`, `session-cleanup`, `splay`, `retention`, `index-cache-knobs`,
  `persistence-config`, `prometheus-metrics`, `mysql-documents`).

## 6. Open questions

None. PR 2 follows the plan in §3.1.

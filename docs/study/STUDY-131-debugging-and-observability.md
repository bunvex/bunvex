# STUDY-131 — Seeing inside a deployment: system tables, subscriptions, traces

- **Status:** accepted (owner, 2026-10-05): AD-24 to AD-27, AD-26 with an in-house exporter, and T1 module by module. AD-26 built (§9); AD-27 built (§10).
- **Convex source read:** `main` of get-convex/convex-backend (4577b9031), 2026-10-05
- **Related:** [STUDY-08](STUDY-08-cache-and-subscriptions.md) (read sets, invalidation), [STUDY-12](STUDY-12-dashboard.md)
  (dashboard), [STUDY-58](STUDY-58-app-metrics.md) (app metrics), STUDY-114 (Prometheus `/metrics`), STUDY-125–130
  (system tables like Convex's)

The owner asked how Convex's developers check that a deployment does what it should. How do they see what is
in the system tables, what is cached, what invalidated a query, and whether a query ran only when it had to?
And can bunvex make that visible? This study answers what Convex has, and proposes additions where it has
nothing.

## 1. How Convex does it

**Tests.** Most correctness checks live in Rust tests:

- **Simulated runtime.** A test runtime makes time, randomness and scheduling deterministic. The database,
  committer, subscription manager and sync worker run in one test and can assert, for example, that a write
  invalidates exactly one subscription. See `crates/common/src/runtime`, its testing module, and the tests in
  `crates/database`, `crates/sync` and `crates/isolate`.
- **Property tests** (proptest) cover values, ordering and key encoding.
- **Scenario and load tooling:** `crates/load_generator`, `crates/backend_harness`,
  `npm-packages/scenario-runner` and `npm-packages/demo_browser_tests`.

**Instrumentation.**

- **Spans.** About 25 crates create `fastrace` spans around requests, function runs, index reads, commits and
  sync. The open-source backend installs no reporter, so a self-hosted deployment drops the spans. Only
  Convex's cloud collects them.
- **Metrics.** About 800 Prometheus series are served at `/metrics` (STUDY-114). They include query cache hits
  and misses, invalidations, transition sizes, OCC conflicts, and documents and bytes read.
- **Logs.** Structured logs through `tracing`, controlled by `RUST_LOG`.

**The dashboard** is the main GUI, for users and for Convex alike:

- Data browses and edits the app's tables.
- Logs mark each run `cached` and show its documents and bytes read.
- Health shows the cache hit rate, failures and latency.
- Insights, in the cloud only, shows heavy reads and OCC conflicts.

**System tables are not browsable.**

- `db.system.query` of a private system table (`_tables`, `_index`, `_schemas`, `_db`, …) reads nothing,
  because its index is hidden from functions.
- The dashboard and `npx convex data` see the app's tables and the two virtual ones, `_storage` (the Files
  screen) and `_scheduled_functions` (Schedules).
- Convex's developers inspect the rest in the persistence database itself, where each document is a JSON row
  in SQLite or Postgres, or through tests.

**Invalidation is not browsable either.**

- Convex has no screen or endpoint that says "this query re-ran because commit T wrote key K in the range of
  index I that it had read".
- The subscription manager (`crates/database/src/subscription.rs`) holds every read set and finds the
  invalidated ones on each commit, but nothing exposes them.
- A developer reasons from the logs (cached or not), the metrics and the tests.

## 2. What an app can observe

Nothing in this study changes what an app observes. Every proposal is opt-in, admin-only, and off unless
used.

## 3. bunvex today

**Tests.**

- About 355 test files.
- Property tests with fast-check (15 files).
- Oracle tests that run the same scenario against the official `convex` npm packages.
- Jepsen (`packages/jepsen`).
- Persistence conformance on SQLite, Postgres, MySQL and MongoDB.
- Benches (`bench/`: invalidation, OCC, backfill, retention, …).
- Missing: Convex's simulated runtime. Only some modules take an injected clock (`retention.ts`,
  `write-throughput.ts`, `query-cache.ts`, `determinism.ts`). Timing tests use real time and `sleep`, which is
  where most flaky failures under load come from.

**Instrumentation.**

- `/stats`: JSON, needs ViewMetrics (DV-162).
- Prometheus `/metrics` with 31 series (STUDY-114, #432).
- Function logs that mark cache hits, and log streams.
- No tracing at all.

**System tables.** As in Convex, the private ones read nothing through `db.system` (since #420, an empty read
instead of an error). `bunvex data` shows the app's tables and the virtual ones. The rest is visible only by
opening the store.

**Invalidation.** All the information exists in memory:

- `ReadSetIndex` (`packages/core/src/read-set-index.ts`) holds every registered read set: cached queries,
  subscriptions and sync executions, as index intervals.
- `SyncHub` / `SyncSession` (`packages/server/src/sync.ts`) know each session's queries. They already count
  each invalidation against the first write that overlaps its reads (`InvalidationEvent`, for the app metrics,
  STUDY-58).
- `QueryCache` (`packages/core/src/query-cache.ts`) knows each cached result: its key, read set, size and
  last use.

Nothing exposes these per query.

## 4. Additions (beyond Convex)

### AD-24 — System tables in the Data screen and in `bunvex data`

- **What.** An admin-only, read-only "Show system tables" switch on the Data screen, and a `--system` flag
  for `bunvex data`. Both list every system table, private ones included, and page through its documents with
  their fields decoded (index fields, table states, schema JSON).
- **How.** A new system query `_system/debug/systemTable` reads a private table past the hidden index. It is
  allowed only for an admin with `ViewData`, never for function code, and is read-only. The dashboard and the
  CLI call it. The table names come from `SYSTEM_TABLE_NUMBERS` (after STUDY-125–130 they are Convex's), with
  a short description of each, kept next to that list.
- **Cost.** Small to medium: one system query, a toggle and a list in the Data screen, and a CLI flag. Nothing
  on any hot path.
- **A Convex app notices?** No.

### AD-25 — Subscriptions and invalidation inspector

- **What.** A Subscriptions screen, with an admin endpoint behind it, that answers three questions:
  - **Which queries are live?** Per session: the function, an args digest, the ts it is at, and whether its
    result came from the cache.
  - **What did each one read?** Its read set: each interval with the index's name (`messages.by_author`) and
    its bounds decoded back to values (`["ana"] … ["ana", +∞)`), plus the number of documents and bytes read.
  - **Why did it run again?** The last N invalidations (a bounded ring per query), each with the commit's ts,
    write source (the mutation's path), table, the written key decoded, and how long until the new result was
    sent. A query that re-ran with no invalidation, such as a new subscriber or a cache eviction, shows that
    reason instead.

  The same screen shows the query cache: entries, hits, misses, evictions, the biggest entries, and each one's
  read set.
- **How.**
  - `GET /api/debug/subscriptions`, plus `/api/debug/query_cache`, requiring ViewMetrics and the admin key.
    These are not system queries, since the data lives in memory.
  - `SyncHub` already finds the first overlapping write per invalidation. Keeping the last few per query costs
    a small, fixed amount of memory (a ring of 8 by default; a knob sets it, and 0 turns it off).
  - Decoding intervals uses the key encoding the engine already has (`keyenc.ts`).
  - A filter by function path, and a "follow" mode that streams new invalidations while the screen is open.
- **Cost.** Medium. One write path is touched: the invalidation step records a small entry per invalidated
  query (measure it; it is off with the knob at 0). Reads happen only when the screen asks.
- **A Convex app notices?** No.

### AD-26 — Traces over OpenTelemetry

- **What.** Spans for each HTTP request and WebSocket message, function execution, index read, commit and
  sync transition, plus scheduler and cron runs. They are exported over OTLP to Jaeger, Grafana Tempo,
  Honeycomb or similar. A request's whole path becomes one trace.
  - **Function execution:** path, kind, cache hit, documents and bytes read.
  - **Index reads:** batched per index, with the number of intervals and rows.
  - **Commit:** wait, validation and persistence write.
  - **Sync transition:** queries re-run and bytes sent.
  - **Scheduler and cron runs.**
- **How.**
  - The standard OpenTelemetry environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
    `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SERVICE_NAME`).
  - It is off unless an endpoint is set, so there is no cost by default.
  - A `traceparent` header from a client continues its trace.
  - The OTLP/HTTP JSON exporter can be written in-house, as small as the Prometheus encoder of STUDY-114, or
    use the `@opentelemetry/*` packages. That is a choice for the owner (§6).
- **Convex.** Convex has the spans but exports none in the open-source backend. This makes bunvex's
  self-hosted deployment more observable than Convex's.
- **Cost.** Medium. The span calls sit on hot paths, so the disabled path must cost nothing measurable, and
  sampling must keep the enabled cost small. Both get measured.
- **A Convex app notices?** No.

### AD-27 — A "why did this run" link from Logs

- **What.** Each query execution in the Logs screen links to its entry in AD-25 (the invalidation that caused
  it) and to its trace (AD-26) when tracing is on.
- **Cost.** Small, once AD-25 and AD-26 exist.
- **A Convex app notices?** No.

## 5. Test infrastructure (not an addition)

**T1 — A deterministic runtime for tests.** An injectable clock and timer scheduler threaded through the
engine, committer, scheduler, crons, sync hub (splay, heartbeat) and server timeouts, with a test runtime
that advances virtual time.

- Timing tests (heartbeat, splay, scheduler lag, execution limits, retention) stop sleeping and stop
  flaking under load. Convex's runtime does the same.
- Production keeps the real clock, so nothing observable changes.
- Size large; it touches every module that reads `Date.now()`, `performance.now()` or sets timers. It can be
  done module by module, starting with the ones whose tests flake: execution limits, http-actions,
  client-auth, index-backfill.

## 6. Decisions

Decided by the owner on 2026-10-05: all four additions accepted; AD-26's OTLP exporter written in-house (no dependency); T1 accepted, module by module, starting with the flaky tests. The order below stands.

The questions, as asked:

1. **Which additions to accept:**
   - AD-24, system tables: recommended.
   - AD-25, the invalidation inspector: recommended. It is the one that answers "what affected this query
     and did it run only when needed".
   - AD-26, traces: recommended.
   - AD-27, links from Logs: after AD-25 and AD-26.
2. **AD-26's exporter:** in-house OTLP/HTTP JSON (no dependency, a small subset of OpenTelemetry), or the
   official `@opentelemetry/*` packages (complete, but several dependencies in `@bunvex/server`).
   Recommendation: in-house, as with `/metrics`. The official packages can be adopted later if needed.
3. **T1:** accept the deterministic test runtime as a roadmap item. Recommendation: yes, module by module,
   starting with the flaky tests.
4. **Order:** AD-24 (small, and it pairs with STUDY-125–130), then AD-25, then AD-26, then AD-27 and T1.

## 7. Implementation: AD-24, system tables (built 2026-10-05)

**Server** (`packages/server/src/system-functions.ts`).

- `_system/debug/systemTables` lists every system table the catalog has, by name. Each entry has a one-line
  `description`, `appVisible` (apps read it through `db.system`: `_storage`, `_scheduled_functions`) and a
  `documentCount` (null while the table summaries are still loading after a start).
  - The names come from the engine's catalog (`Tx.systemTableNames()`), so `_tables` and `_index` (fixed, no
    `_tables` row) are included. A table that STUDY-125–130 add, rename or make virtual shows up, or goes,
    with no list to edit here.
  - The descriptions are `SYSTEM_TABLE_DESCRIPTIONS`, next to `SYSTEM_TABLE_NUMBERS` in
    `packages/core/src/catalog.ts`. A test checks that every numbered table has one. A catalog table without
    a line is listed with an empty description.
- `_system/debug/systemTable` pages through one system table, `{ table, order?, paginationOpts }`, as
  `_system/cli/tableData` pages a user table. It reads past the hidden index (`asSystem`), so it returns
  documents as stored, with every field (`_storage`'s hidden ones too). A name without `_` is refused
  (`"notes" is not a system table.`); a system table the deployment does not have reads empty.
- Both are queries (read-only by construction) and need ViewData. They are marked `adminCallOnly`: only an
  admin's own call reaches them (the HTTP API, a sync session, the server in process). Function code never
  does: an action's `runQuery` gets "Could not find public function", even when an admin ran the action.
- The stored documents are already plain values (index fields, table states, schema JSON), so nothing needs
  decoding on the way out.

**CLI** (`packages/cli/src/data.ts`).

- `bunvex data --system` prints one line per table: name, size, `public` / `private`, description.
- `bunvex data --system <table>` prints the documents through `_system/debug/systemTable`, with `--limit`,
  `--order` and `--format` as for any table.

**Dashboard** (`packages/dashboard`, on the mock).

- Contract: `data-source-system-tables.ts` adds the optional `listSystemTables` and `listSystemDocuments`
  (`viewData`). Its part of the contract suite is `contract-system-tables.ts`:
  - `_` names only, sorted, none of them a user table;
  - pages that walk a table once in either order;
  - a user table's name refused (`invalid_request`), and `unauthorized` without `viewData`.
- Mock: `mock/system-tables.ts` builds the system tables from the mock's state when asked: `_tables`, `_index`,
  `_schemas`, `_environment_variables`, `_cron_jobs`, `_backend_state`, `_instance`, and empty `_storage` and
  `_scheduled_functions`. They follow its tables, variables, crons and pause.
- Data screen:
  - A "Show system tables" checkbox in the tables column, shown only when the source offers them and the
    credential has `viewData`. It is a per-browser preference.
  - It lists the system tables under the user tables, with their sizes and descriptions. An open system
    table keeps the list shown.
  - `/database/_name` opens a read-only view: the description, private or app-visible, the size, every field,
    oldest or newest first. There is no editing, selection, filter or side panel.
- A server-backed data source would map the two methods to the two system queries. Until the dashboard talks
  to a server, the screen runs on the mock.

**Tests.**

- Server (`packages/server/test/system-tables-browser.test.ts`):
  - every numbered table has a description;
  - the listing equals the catalog's system tables, with sizes and `appVisible`;
  - `_index` is refused through `_system/cli/tableData` and readable through the debug query;
  - cursors walk `_tables` once, and `desc` reverses `asc`;
  - a user table is refused, and a missing system table reads empty;
  - refused with no key, without ViewData, and from an action's `runQuery` run by an admin.
- CLI (`packages/cli/test/data.test.ts`): the listing, `_index` as JSON lines, `_index` without `--system`
  still hidden, a user table refused, the pretty table and the limit warning.
- Dashboard (`packages/dashboard/test/system-tables.test.tsx`, and the contract part in `mock.test.ts`):
  - the checkbox shows and hides the list (with an axe check);
  - `_tables` read-only, with its description and fields;
  - newest first on demand;
  - no checkbox and no documents without `viewData`;
  - the mock follows a new table.

**Sabotage** (each restored, `git diff` clean afterwards):

| Break | Caught by |
|---|---|
| The function-code guard lets a function's call through (`adminCallOnly && inProcess`) | server: "refused … from function code" |
| The name check lets a user table through | server: "a user table is not a system table"; CLI `--system` test |
| The catalog listing drops `_index` | server: "the listing comes from the catalog"; CLI `--system` test |
| `--system <table>` reads through `_system/cli/tableData` | CLI `--system` test |
| The dashboard gates on `viewLogs` instead of `viewData` | dashboard: "a credential that may not view data …" |
| The mock ignores `order: "desc"` | the contract's "pages walk a table once, either order" (4 mock variants) |

**Not on a hot path.** Nothing runs unless an admin asks, so there is no measurement.

**Found while building (not changed here).** Any action can already call any other `_system/*` query through
`ctx.runQuery`. The non-client path (`fromClient = false`) skips the access check. Convex refuses a system
function to a non-admin identity (`application_function_runner/mod.rs`, `path.is_system() &&
!(identity.is_admin() || identity.is_system())`). AD-24's queries are closed to function code
(`adminCallOnly`); the general gap is left for the owner.

## 8. Implementation: AD-25, subscriptions and invalidation inspector (built 2026-10-05)

§7 is AD-24's implementation (#460).

**Recording** (`packages/server/src/sync-inspector.ts`, hooked into `SyncHub` in `sync.ts`).

- **Invalidations.** When a commit invalidates an execution key, `onCommit` finds the first write that overlaps the
  key's reads, once per key. It records the commit's ts, its write source, that write's index and key bytes,
  and the time. This lookup is shared with the app metrics' `InvalidationEvent` attribution, which before ran
  it once per session and key.
- **Delay until sent.** When a transition sends the key's new result, each invalidation not yet sent gets
  `sentAfterMs`.
- **Reruns with no invalidation.** A run that no invalidation caused records its reason: `newSubscriber` (the
  key's first run), `identityChange`, `codeChange` (a push changed the module) or `retry` (an index was still
  rebuilding, STUDY-79).
  - A session that reuses another's run is `cached` and records nothing.
  - Sync keeps a key's result as long as anyone watches it, so a sync query has no eviction. The HTTP query
    cache's evictions are counted as a miss reason instead (below).
- **The ring.** Each execution key keeps the last N records, `SUBSCRIPTION_INVALIDATION_HISTORY` or the server
  option `invalidationHistory` (default 8). 0 records nothing: the hook is one boolean test.
  - A follow feed keeps the last 1024 invalidations in a circular buffer.
  - The ring is forgotten when nobody watches the key.
- **Reads.** Executions now carry the documents and bytes they read (`queryTracked` returns them).
- **Query cache** (`query-cache.ts`, `engine.ts`).
  - Misses are counted by reason: `new`, `evicted` (the cache remembers the last 1024 evicted keys),
    `invalidated`, `expired` (it read the clock) or `snapshot` (only a newer result was there).
  - `inspect()` lists the entries.

**Decoding, only when asked.**

- `keyToValues` in `@bunvex/values` (`sorting.ts`) is the inverse of `valuesToKey`. A property test checks the
  round trip for any tuple of values.
- `describeBound` in `@bunvex/core` (`keyenc.ts`) reads an interval bound back:
  - `-∞` / `+∞`;
  - the values of an exact key;
  - `after` for `afterValues` (an eq prefix or an inclusive end), or for `prefixEnd` (a scan cut after a
    document);
  - raw hex when no whole value is left.
- `boundText` prints a range as `[["ana"], ["ana", …])`.
- Index ids map to `table.index` and its key fields (`…, _creationTime, _id`).

**Endpoints** (`packages/server/src/debug-routes.ts`). All need an admin key with ViewMetrics, and all accept
`?path=` (substring).

- `GET /api/debug/subscriptions` returns, per session (id, identity kind) and per live query:
  - the path and a 12-hex sha256 digest of the canonical args;
  - `ts`, `cached`, the result kind, documents and bytes read;
  - `readSet` (index, fields, bounds as values and text);
  - `history`, newest first.
- `GET /api/debug/query_cache?limit=` returns entries, bytes, hits, misses, `missReasons`, waits and evictions,
  and the biggest entries with their read sets.
- `GET /api/debug/invalidations?cursor=&timeoutMs=` is the follow stream: the log streams' long poll (up to
  60 s), entries after `cursor` and `newCursor`.

**Dashboard** (`packages/dashboard`, on the mock).

- Contract: `data-source-subscriptions.ts`, with the optional `getSubscriptions`, `getQueryCache` and
  `watchInvalidations` (`viewMetrics`), and its part of the contract suite (`contract-subscriptions.ts`).
- Mock: `mock/subscriptions.ts`, with sessions over the fixture's functions and invalidations that land on a
  timer.
- Screen: Observe → Subscriptions (`/subscriptions?path=&tab=cache&query=&entry=`).
  - The Live queries table opens a panel with the read set and "Why it ran".
  - The Query cache tab shows the counters and the biggest entries.
  - "Follow invalidations" lists new ones while the screen is open.
  - Without `viewMetrics` it shows nothing.

**Measurement** (`packages/server/bench/sync-invalidation-history.ts`). The sync hub's commit handler is timed
per commit, in µs. One in-process session holds 1000 queries; each configuration ran twice, 150 commits each.

| Shape | Ring 0 (p50, mean) | Ring 8 (p50, mean) |
|---|---|---|
| narrow: one key invalidated per commit | 555 / 738, 480 / 510 | 528 / 626, 534 / 560 |
| wide: all 1000 keys invalidated per commit | 1265 / 1473, 1502 / 1740 | 1520 / 1700, 1660 / 1884 |

- **Narrow.** The difference is within the run-to-run noise.
- **Wide.** About +0.15–0.25 µs per invalidated key (+10–20% of the handler, which also schedules 1000
  transitions).
- **History of the measurement.**
  - A first version kept the feed in an array trimmed with `shift()` and measured about +0.6 µs per key. The
    feed is now a circular buffer.
  - Sharing the first-write lookup with the metrics removed a lookup per session and key, so with metrics on
    the handler does less than before when a key has several watchers.

**Tests.**

- `packages/server/test/invalidation-inspector.test.ts`:
  - a live query's read set decoded: `messages.by_author` `[["ana"], ["ana", …])`, documents and bytes read,
    rerun `newSubscriber`;
  - a mutation's invalidation: its commit ts, source `m:send`, table, index, the key decoded (author,
    `_creationTime`, id), and `sentAfterMs`; a write outside the range records nothing;
  - the follow feed and its cursor; a waiting follow request returns when an invalidation lands; the path
    filter;
  - the ring keeps the last 3 with the knob at 3, newest first; the knob at 0 records nothing (history and
    feed), while the read set is still shown;
  - a second subscriber is `cached` and adds no rerun;
  - the query cache: hits, misses by reason (`new`, `invalidated`), the biggest entry's read set; a miss after
    an eviction counts as `evicted`;
  - refused with no key (403); a read-only key passes; a key without ViewMetrics is refused.
- `packages/values/test/sorting-decode.property.test.ts`: the round trip, a cut key, each type.
- `packages/core/test/keyenc-describe.test.ts`: every bound kind, plus a property over `afterValues` and
  `prefixEnd`.
- `packages/dashboard/test/subscriptions.test.tsx`: the list (axe), the open query's read set and why it ran,
  the path filter, the cache tab, follow, no `viewMetrics`. The contract part also runs for the mock variants
  in `mock.test.ts`.

**Sabotage** (each restored, `git diff` clean afterwards):

| Break | Caught by |
|---|---|
| The ring keeps one more than its size | server "the ring keeps the last N; 0 records nothing" |
| The knob at 0 still records (`enabled` always true) | the same test (history and feed must be empty) |
| The write source is dropped | server "a mutation's invalidation …" |
| The wrong commit ts is recorded | server "a mutation's invalidation …", "the ring keeps the last N …" |
| The float decoder does not flip a positive's sign bit back | values "round trip", "examples: each type" |
| `afterValues` bounds read back as exact keys | core "an eq prefix …", core property, server "a live query's read set …" |
| The endpoints ask for ViewData instead of ViewMetrics | server "refused without an admin key and without ViewMetrics" |
| The cache forgets the keys it evicted | server "a miss after an eviction says so" |
| A sent transition no longer marks the delay | server "a mutation's invalidation …" (`sentAfterMs` stays null) |
| The mock ignores the path filter | dashboard "a path filter in the URL …", and the contract's filter test (4 mock variants) |

## 9. AD-26 built: traces over OpenTelemetry

### 9.1 What Convex does, in detail

- **Spans.** `fastrace` spans are opened all over the backend. The roots matter for the shape of a trace:
  - `stats_middleware` (`crates/common/src/http/mod.rs`, around line 755) wraps every HTTP request in a root
    span named after the matched route, with `span.kind = server`. It continues a W3C `traceparent` header
    (`ExtractTraceparent`, around line 1129) when `PROPAGATE_UPSTREAM_TRACES` is on (its default), and
    otherwise opens a no-op span: sampling "should be done upstream".
  - The sync worker (`crates/sync/src/worker.rs`) opens its own sampled roots: `sync-worker/mutation` (line
    681) and `sync-worker/action` (line 791), with `udf_type` and `udf_path`, and `sync-worker/update-queries`
    for a transition (`begin_update_queries`, line 940).
  - `get_sampled_span` (`crates/common/src/fastrace_helpers/mod.rs`) samples each root by
    `REQUEST_TRACE_SAMPLE_CONFIG` (`knobs.rs` line 1786): a default fraction plus regex overrides per route and
    per instance. The open-source default is an empty config, a fraction of 0.
  - `EncodedSpan` carries a span to another process (an isolate, a Node action) as a `traceparent` string.
- **Export.** Nothing in the open-source crates calls `fastrace::set_reporter`, so every span is dropped.
- **WebSocket.** The sync protocol's client messages (`crates/convex/sync_types/src/types/mod.rs`) carry no trace
  context, and a browser's `WebSocket` cannot set headers on its upgrade, so a client cannot continue its trace
  over the socket. bunvex does the same: a WebSocket message is always the root of its trace.

### 9.2 What an app observes

Nothing. Tracing is off unless an OTLP endpoint is configured, and on it changes no response, timing contract or
error. The collector sees the spans; `/stats` (ViewMetrics) gains a `tracing` object, `null` when off.

### 9.3 How bunvex does it

**Where the code lives.**

- `packages/core/src/tracing.ts`: the `Span`, the `Tracer`, W3C `traceparent` parsing, the samplers, span
  and trace ids, and the two aggregates the engine reports (`IndexReadSpans`, `CommitSpans`). Core has no HTTP,
  so it only hands finished spans to a `SpanSink`.
- `packages/server/src/otlp.ts`: the configuration from the environment and the exporter (the `SpanSink`).
- `packages/server/src/request-tracing.ts`: the root span of each HTTP request, on both ports.
- Hooks: `engine.ts`, `tx.ts` and `committer.ts` in core; `functions.ts` (`logged`), `sync.ts`,
  `scheduler.ts`, `cron-executor.ts` and `server.ts` in the server.

**The trace of a request.** Names follow Convex's where it has one.

| Span | Kind | Parent | Attributes |
|---|---|---|---|
| `<METHOD> <route>`, e.g. `POST /api/mutation` | server | the `traceparent` caller, else none | `http.request.method`, `http.route`, `url.path`, `url.scheme`, `server.port`, `user_agent.original`, `bunvex.client`, `http.response.status_code`; failed on a 5xx |
| `sync-worker/<message>`: `connect`, `modify-query-set`, `mutation`, `action`, `authenticate`, `event` | server | none | `bunvex.sync.message_bytes`, `bunvex.sync.session_id`; for a mutation or action `bunvex.function.path`, `bunvex.sync.request_id`. A mutation's span lasts until its response, its time in the session's queue included |
| `sync-worker/update-queries` | internal | the message that asked for it (a query set, an identity, a mutation's or action's response), else none (a commit invalidated it) | `bunvex.sync.queries`, `bunvex.sync.queries_rerun`, `bunvex.sync.modifications`, `bunvex.sync.bytes` (the transition's UTF-8 bytes), `bunvex.sync.ts` |
| `scheduler/run`, `cron/run` | consumer | none | `bunvex.scheduler.job_id` or `bunvex.cron.name`; `bunvex.function.path` |
| `<kind> <path>`, e.g. `query messages:list` | internal | the current span | `bunvex.function.path`, `.kind`, `.environment`, `.cached`, `.documents_read`, `.bytes_read`, `bunvex.request_id`; failed when the function failed |
| `index <table>.<index>` | internal | the function's | `bunvex.index`, `bunvex.index.intervals` (store reads of the index), `bunvex.index.rows`, `bunvex.index.read_us` (time inside those reads) |
| `commit` → `commit.wait`, `commit.validate`, `commit.write` | internal | the function's | `bunvex.commit.documents`, `.index_entries`, `.ts`; the write span `bunvex.commit.batch_commits`, `.batch_documents`; failed when refused (a conflict) |

- **Index reads are batched per index.** A transaction keeps one aggregate per index it reads: the number of
  store reads, the rows they returned and the time spent in them. Each index becomes one span when the
  transaction ends, from its first read to the end of its last. A query that pages through 10 000 rows makes one
  span, not 10 000 (or 40 for its pages). A run-state check that reads `_backend_state` from the store shows up
  too; one answered from its cache does not.
- **The commit** is timed at the committer's steps: queued behind the group being written (`wait`), checked
  against the commits since its snapshot (`validate`), applied and flushed with its write batch (`write`, shared
  by the batch's commits). A mutation retried after a conflict shows each attempt's commit under the same
  function span.
- **An HTTP request's span** ends when its handler returns the response; a streamed body may still be sending.
- **A transition caused by a commit** is a trace of its own, as Convex's `sync-worker/update-queries` is a root:
  one commit can invalidate many sessions' queries. Linking it to the commit's trace is AD-27's subject, with
  AD-25's invalidation record.

**Propagation: AsyncLocalStorage, measured.** The current span travels in an `AsyncLocalStorage`, as the
function log's and determinism's state already do. Explicit passing would thread a parameter through `Engine`,
`Tx`, `Committer`, `Functions` and the sync hub. A micro-benchmark modeled a request with a function and five
awaited reads, each looking up its parent, with two other `AsyncLocalStorage` instances active as in bunvex.
Three rounds of 10⁶ requests each, Bun 1.4.2, on a loaded machine:

| Per request | Round 1 | Round 2 | Round 3 |
|---|--:|--:|--:|
| no tracing | 593 ns | 580 ns | 759 ns |
| explicit passing, traced | 687 ns | 512 ns | 805 ns |
| AsyncLocalStorage, no span stored (tracing off) | 653 ns | 557 ns | 825 ns |
| AsyncLocalStorage, a run per root and child (traced) | 800 ns | 670 ns | 1129 ns |

AsyncLocalStorage costs about 100–300 ns more per traced request than explicit passing, and nothing measurable
when no span is stored. Both are well under 1 % of a request (tens of µs). AsyncLocalStorage was chosen for its
much smaller change.

Where work crosses a queue, the parent is captured explicitly instead:

- a commit takes its parent when it is queued (`CommitSpans`);
- a transition takes the message that asked for it;
- a sync message's handling runs `within` its own span, not the context of whatever ran the inbox before.

The committer drains its group from a `setImmediate` set in the context of the group's first commit. Traced,
the drain is `detached` (the AsyncLocalStorage exited): otherwise the commit listeners, and the queries or
transitions they start, would join that one request's trace. A root the sampler leaves out still runs `within`
a "not sampled" marker, so nothing under it opens a span or inherits one.

**Off costs nothing.** With no endpoint, the engine's tracer is `NO_TRACER`. Every hook checks `tracer.on` and
does nothing else: no span object, no clock read, no AsyncLocalStorage run, no extra promise.

- The wrappers on hot paths (`Functions.logged`, `Tx.storeRange`, `SyncSession.transition`) are not `async`.
  Untraced, they return the inner promise as is. An `async` wrapper first cost two microtask turns per call, and
  `sync-retry`'s "a rerun after a commit is retried the same way" test caught the reordering.
- `withRequestTracing` returns the server's options unchanged.

**Sampling.** The OpenTelemetry SDK's samplers:

- `always_on`, `always_off`, `traceidratio`, and their `parentbased_` forms. The default is
  `parentbased_always_on`, and `OTEL_TRACES_SAMPLER_ARG` is the ratio (default 1.0).
- A ratio decides from the trace id's last 7 bytes, against `ratio × 2⁵⁶`, so every service that sees a trace
  decides the same way.
- Parent-based follows a `traceparent`'s sampled flag: a caller that did not sample its trace gets no spans from
  bunvex.
- A sampled trace is whole: children never re-sample.
- The decision comes first. An unsampled HTTP request costs a header read, an id and the marker run, not a URL
  parse or a span.

**`traceparent`.** It is parsed as W3C Trace Context §3.2 specifies:

- lowercase hex fields;
- version `ff` and all-zero ids are invalid;
- version `00` has exactly four fields, and a later version is read by its first four;
- a `tracestate` is kept on the spans.

An invalid header starts a new trace.

**Configuration**, read once when the server starts. The OpenTelemetry SDK's variables:

| Variable | Use |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | the traces URL, used as is |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the base URL; `/v1/traces` is appended. Tracing is off when neither is set |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `k=v,k2=v2`, values percent-decoded; the traces list overrides key by key |
| `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | one export's timeout, ms (10 000) |
| `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | only `http/json` is spoken; another value is reported and JSON is sent all the same |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | above; an unknown sampler or a bad ratio is reported, and the default used |
| `OTEL_SERVICE_NAME` | `service.name` (default `bunvex`); it wins over one in `OTEL_RESOURCE_ATTRIBUTES` |
| `OTEL_RESOURCE_ATTRIBUTES` | more resource attributes; bunvex adds `bunvex.instance_name` |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT` | the batch processor's knobs (2048, 512, 5000 ms, 30 000 ms); a batch is never bigger than the queue |
| `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none` | off |

`createServer({ tracing })` takes the same settings directly (tests), and `tracing: null` turns tracing off
whatever the environment says.

**The exporter** behaves as the SDK's BatchSpanProcessor with an OTLP/HTTP exporter, written in-house (the
owner's decision: no `@opentelemetry/*` dependency):

- **Batching.** Finished spans go to a bounded queue. A batch is sent once it is full, or after the delay since
  the first span waiting. One export runs at a time; the queue is taken on when it ends.
- **A full queue drops the span** and counts it. The counts are in `/stats` as
  `tracing: { exported, dropped, failed, queued }`. The Prometheus `/metrics` endpoint (#432) is not merged;
  these counters can join it once it is.
- **Retries.** A retryable answer (429, 502, 503, 504, as OTLP/HTTP lists them) or a network error is retried
  with full-jitter backoff (1 s doubling to 30 s, 5 retries), honoring `Retry-After`. Another status fails the
  batch at once.
- **Partial success.** `partialSuccess.rejectedSpans` counts as failed.
- **Warnings** about failures are printed at most once a minute.
- **Close.** `stop()` and `shutdown()` close the exporter. It stops taking spans, cuts a backoff short (one last
  attempt), and sends what is queued, for at most `OTEL_BSP_EXPORT_TIMEOUT`. `shutdown()` closes the engine
  first, so the last commits' spans go too.
- **Requests** use the real `fetch` (not an action's metered one, nor the operator's SSRF proxy), and its
  timers are `unref`'d.

**The JSON** follows the OTLP specification's JSON encoding of `ExportTraceServiceRequest`
(opentelemetry-proto, `opentelemetry/proto/collector/trace/v1/trace_service.proto` and
`trace/v1/trace.proto`):

- one `resourceSpans` entry with the resource's attributes, and one `scopeSpans` entry with scope `bunvex`;
- `traceId` and `spanId` as lowercase hex, the one exception to protobuf's base64 JSON mapping of `bytes`;
  `parentSpanId` is omitted on a root;
- `kind` and `status.code` as integers;
- `startTimeUnixNano` and `endTimeUnixNano` (fixed64) as decimal strings. Span times are monotonic
  `performance.now()` readings, converted with `performance.timeOrigin` in exact BigInt nanoseconds;
- attributes as `KeyValue`s. A string is `stringValue`, a boolean `boolValue`, a safe integer `intValue` (int64,
  a decimal string), any other number `doubleValue`, and a non-finite double `"NaN"`/`"Infinity"`, as protobuf's
  JSON mapping writes them.

Ids are drawn from 4 KiB blocks of `crypto.getRandomValues`, outside any deterministic execution, and are
never all zero. Trace ids are fully random, so the W3C level-2 random flag holds, but bunvex does not set it.

### 9.4 Divergences and additions

None beyond AD-26 itself. Span names follow Convex's where it has them: the route for an HTTP root,
`sync-worker/mutation`, `sync-worker/action` and `sync-worker/update-queries`. The others, and every attribute,
are bunvex's, with OpenTelemetry's semantic conventions for HTTP.

### 9.5 Tests

- `packages/core/test/tracing.test.ts` (16 tests):
  - `traceparent` validity cases;
  - the samplers and their parsing; the ratio decided from the id, and about 10 % of 10 000 roots at 0.1;
  - ids; nanosecond times;
  - `within` and an unsampled root hiding the caller's span; a remote parent;
  - index reads, one span per index: 303 rows in 4 reads make one span, plus one each for `by_creation_time`
    and `by_id`;
  - untraced work reports nothing;
  - the commit's three steps, inside the commit span, in the request's trace; a refused commit fails;
  - work a commit listener starts joins no trace.
- `packages/server/test/otlp-traces.test.ts` (18 tests), with an in-process OTLP collector (`Bun.serve`) that
  keeps every request:
  - **JSON shape.** Every export is checked field by field against the proto: allowed keys only, hex ids, integer
    kinds, 19-digit nanosecond strings, end ≥ start, typed `AnyValue`s. Also the configured headers and
    `content-type`, and the resource (`service.name`, `OTEL_RESOURCE_ATTRIBUTES`, `bunvex.instance_name`).
  - **A mutation over HTTP is one trace:**
    `POST /api/mutation` → `mutation m:send` → {`index _backend_state.by_creation_time`,
    `index messages.by_author`, `commit` → {wait, validate, write}}, all in one trace.
  - **A query:** documents and bytes read and its index span; a cache hit is marked `cached` and has nothing
    under it.
  - **`traceparent`:** a sampled one is continued (trace id, parent span id, `tracestate`); an unsampled one
    records nothing; an invalid one starts a new trace.
  - **Sync:**
    - the query set's message → its transition → the query → its index read;
    - the socket mutation's trace, down to the commit;
    - exactly one transition re-runs the query after the commit (`queries_rerun` 1, bytes > 50), with the query
      and its index read under it;
    - no transition joins the mutation's trace other than the one its response asks for.
  - **Scheduler and crons:** a scheduled function's `scheduler/run` root with `mutation m:job` under it; a
    1-second cron's `cron/run` root with its mutation.
  - **Sampling:** `always_off` exports nothing; `traceidratio` 0.3 keeps 15–45 % of 300 requests, each kept
    trace whole.
  - **Exporter:**
    - a full queue drops and counts (20 spans, a queue of 5: 15 dropped, 5 sent), also seen in `/stats`;
    - a batch goes when full or after the delay;
    - 503 twice then 200 is retried, exported once; 400 fails at once; retries spent fail; a partial success
      counts its rejected spans;
    - `close()` sends a queued batch that was due in an hour, then drops later spans; it cuts a 60-second
      backoff short with one last attempt;
    - `shutdown()` flushes the request's and commit's spans;
    - exotic values: NaN, ±Infinity, negative ints, an error status.
  - **Environment:** off without an endpoint, with `OTEL_SDK_DISABLED` or `OTEL_TRACES_EXPORTER=none`, or with a
    bad URL; the endpoint rules; headers, timeout, sampler, service name, resource attributes and batch knobs
    (with a malformed entry reported); another protocol reported; off, `engine.tracer` is `NO_TRACER` and no
    exporter exists.
- **Not run: a real collector.** A test against Jaeger or Tempo needs Docker, and the Docker daemon was not
  running on the machine this was built on (the shared VPS is not used for this). The shape test checks the
  proto's JSON mapping instead.

**Sabotage.** Each change below was made, the two test files run, and the code restored (`git diff` clean).
Every one was caught.

| Sabotage | Caught by |
|---|---|
| span ids base64, not hex | JSON shape (mutation, query, sync) |
| times in µs, not ns | nanosecond time test; JSON shape |
| integer attributes as doubles | exotic values |
| `within` does not make the span current | tracer children; index spans; commit spans |
| an unsampled root lets the caller's span through | tracer children |
| parent-based ignores the caller's flag | samplers; remote parent; `traceparent` |
| ratio compared the wrong way | samplers; sampling |
| `traceparent`'s span not the root's parent | remote parent; `traceparent` |
| index reads not batched per index | index spans; `IndexReadSpans` |
| the commit is not under the mutation | untraced work; commit spans; the mutation's tree |
| commit listeners not detached | commit listener test |
| the transition is not under its message | sync |
| queue bound off | full queue |
| close does not send the queue | close; shutdown flush |
| 503 not retried | retries; close |
| base endpoint without `/v1/traces` | endpoint rules |
| `OTEL_SERVICE_NAME` not preferred | configuration |
| function span without its cache flag | query test |
| transition bytes wrong | sync |

### 9.6 Measurements

Bun 1.4.2, Apple Silicon (8 cores), memory store, while other sessions loaded the machine (load average
7–12). The runs are interleaved, so the medians and bests compare.

**HTTP, in process.** 64 concurrent clients in the same process as the server, 8 rounds of 3 s per
configuration:

- *query*: a cache miss every time, one index range of 10 rows;
- *mutation*: an index read and an insert, one commit each.

Spans go to a collector in another process.

| Configuration | Query/s median (best) | Mutation/s median (best) |
|---|--:|--:|
| main | 10 205 (10 949) | 10 454 (10 466) |
| this branch, tracing off | 10 554 (11 004) | 10 455 (10 465) |
| this branch, 10 % sampled | 9 655 (10 599) | 10 420 (10 468) |
| this branch, 100 % sampled | 8 459 (8 926) | 9 667 (10 381) |

- **Off** is main's throughput, within the noise.
- **At 10 %**, queries cost about 3–5 %: the unsampled requests' header read, id and context run. Commits are
  unchanged.
- **At 100 %**, the trivial query costs about 17 %. It is a sub-millisecond request that produces 3–4 spans,
  each encoded to JSON and sent. Commits cost up to 7 %: about 8 spans per mutation, and a committer that paces
  the commits more than the CPU does. A real request does more work per span, so the share is smaller. The
  sampler is the knob for production.

**Engine only.** The disabled path without HTTP: sequential uncached queries (two index reads) and mutations
(a read and an insert), 10 runs per side in alternating order.

| | Query/s median (best) | Mutation/s median (best) |
|---|--:|--:|
| main | 52 618 (56 167) | 29 574 (33 118) |
| this branch, tracing off | 53 655 (56 112) | 29 861 (32 587) |

The same, within the noise.

## 10. AD-27 built: "why did this run" links from Logs

### 10.1 What Convex does

- **The function log.** `FunctionExecution` (`crates/application/src/function_log.rs`) keeps, per run, its path,
  caller, timing, usage, `cachedResult`, OCC info and request and execution ids. It records why a sync query ran
  only coarsely: `query_invocation` becomes the log streams' `run_reason` (`FunctionRunReason`,
  `crates/common/src/log_streaming.rs`, the V2 `function_execution` event; V1 drops it). That says "a data change",
  never which commit, mutation or key.
- **Endpoints.** `stream_function_logs` and `stream_udf_execution` (`crates/local_backend/src/logs.rs`) send
  `FunctionExecutionJson` with nothing about the cause.
- **Clients.** The CLI's `logs` (`npm-packages/convex/src/cli/lib/logs.ts`) casts the JSON to
  `FunctionExecution`; `--jsonl` prints each entry as it came. Its dashboard (`dashboard-common/src/lib/appMetrics.ts`,
  `streamFunctionLogs`, header `dashboard-0.0.0`) casts it the same way and copies named fields into its own log
  rows (`useLogs.ts`). Neither validates, so an extra field is ignored.
- **Traces.** Convex exports none (§9.1), so nothing links a log line to a trace.

### 10.2 What an app observes

Nothing. Function code, the client protocol and every Convex-format output are unchanged (§10.4).

### 10.3 How bunvex does it

**What a Completion carries.** `Completion.links` (`function-log.ts`, `ExecutionLinks`):

- `subscription`, on a sync query's run (the first run and a cache hit served to another session too):
  - `argsDigest`: the inspector's 12-hex digest of the canonical arguments, computed once per subscription;
  - `reason`: `invalidation`, `newSubscriber`, `identityChange`, `codeChange` or `retry`, the inspector's words;
  - `invalidation`: `{ seq, commitTs }` of the invalidation the run answers, or null.
- `trace`: `{ traceId, spanId }` of the run's span, when the run was traced (AD-26).

**Which invalidation.** The inspector's records now carry `seq`, their number in the follow feed, and
`/api/debug/subscriptions` returns it in `history`. When the sync hub runs a key for a data change, it asks the
inspector for the newest invalidation of that key whose new result has not been sent yet (`SyncInspector.pending`).
Two commits before one run: the run reads at the newer one, so that one is linked. With the ring off (size 0),
nothing is recorded and `invalidation` is null; the digest and reason still are given.

**Who gets it.** Only `GET /api/stream_function_logs` from a client whose `bunvex-client` header starts with
`dashboard-` (`isDashboardClient`). Admin key with ViewLogs, as the endpoint already requires. The data is
ids and a digest, nothing from the documents.

**The dashboard** (`packages/dashboard`, on the mock).

- Contract: `LogEntry.execution.links` (`ExecutionLinks`, `ExecutionRunReason` in `data-source.ts`); a server
  source maps them from the Completion's `links`. The invalidation history entry gains an optional `seq`. The
  contract suite checks links where given (`expectExecutionLinks`): a query's run, a 12-hex digest, a known
  reason, an invalidation only for the reason `invalidation`, W3C-shaped non-zero ids.
- Logs details: a "Why it ran" section. The cause in words (with the commit ts), a link "Open the invalidation"
  (or "Open in Subscriptions" without one) to `/subscriptions?path=&args=&seq=`, and the trace id with a copy
  button.
- Trace link: the `traceUrl` prop of `<Dashboard>` (the dev host reads `VITE_BUNVEX_TRACE_URL`), unset by default.
  `{traceId}` and `{spanId}` are replaced; a template without `{traceId}` (a base URL such as Jaeger's
  `…/trace/`) gets the id appended. Unset, the id is shown with no link.
- Subscriptions: `args` opens the live query with that path and digest (the session that ran it, before those
  that reused its run); `seq` marks that invalidation in "Why it ran" (`aria-current`). If the ring has moved past
  it, the panel says so.
- Mock: `invalidateSomething()` lands an invalidation (as `watchInvalidations`' tick did) and logs the re-run of
  the query it invalidated, with its links and a trace id, from a random stream of its own so the rest of the
  mock's data stays as it was. The follow tick and every fourth log tick call it.

**Not done.** The transition a commit causes is still a trace of its own (§9.3), with no OpenTelemetry span link
to the commit's trace. The log entry names the invalidation (commit ts, mutation) instead; a span link can be
added if wanted.

### 10.4 Divergences and additions

None beyond AD-27. Convex's formats are unchanged:

- the CLI (`npm-cli-*`) and a client with no header get Convex's `FunctionExecutionJson` from
  `stream_function_logs`, so `logs --jsonl` prints what it printed;
- `stream_udf_execution` never carries `links`;
- the log sinks' events (`function_execution` and the rest) are untouched.

Convex's own dashboard names itself in `Convex-Client: dashboard-0.0.0`, a header bunvex does not read (it reads
`bunvex-client`), so it gets Convex's entries too. Were it sent `links`, it would ignore them: it reads the JSON
without validation and copies named fields (§10.1).

### 10.5 Tests

- `packages/server/test/log-links.test.ts`:
  - a re-run query's Completion names the invalidation the inspector shows (same digest, `seq` and commit ts; the
    follow feed has the same `seq`); its first run is `newSubscriber` with none;
  - its trace and span ids match the `query m:byAuthor` span an in-process collector received; a mutation sent
    over HTTP has a trace and no subscription link;
  - the CLI and a client with no header get no `links`; `stream_udf_execution` neither, even for the dashboard;
  - without tracing, the subscription link alone; an HTTP query has none;
  - with the ring at 0, a re-run still says `invalidation`, with null;
  - `SyncInspector.pending`: the newest unsent of two, null once sent, none from a rerun record.
- `packages/dashboard/test/log-links.test.tsx`:
  - the mock's re-run names a live query whose newest history entry has that `seq` and commit ts, and is the newest
    log line;
  - `traceHref`: placeholders, a base URL, unset; the Subscriptions screen's `args` and `seq` parameters;
  - the details: the cause and commit ts, the link's path, digest and `seq`, the trace id, no trace link by
    default (axe); with a template, the trace link (`_blank`, `noopener`); a line without links has no section;
  - following the link opens Subscriptions on that query with exactly that invalidation marked (axe); a `seq` no
    longer in the history says so.

**Sabotage.** Each change below was made, the matching test file run, and the code restored (`git diff` clean).
Every one was caught.

| Sabotage | Caught by |
|---|---|
| `pending` never finds the invalidation | server "a re-run query's log entry …", "the invalidation a run answers …" |
| `pending` returns the oldest unsent, not the newest | server "the invalidation a run answers …" |
| `links` sent to every client | server "the CLI and an unnamed client …" |
| `links` sent on `stream_udf_execution` too | server "the CLI and an unnamed client …" |
| the run's span not recorded | server "a re-run query's log entry …" |
| a first run called an invalidation | server "a re-run query's log entry …" |
| `seq` missing from the inspector's history | server "a re-run query's log entry …" |
| the trace URL template ignored | dashboard "the trace URL template …", "with a trace URL template …" |
| Subscriptions ignores `args` | dashboard "following the link …", "an invalidation no longer in …" |
| the invalidation not marked | dashboard "following the link …" |
| the mock links the wrong invalidation | dashboard "the mock's re-runs …", "following the link …" |
| the details drop the link's `seq` | dashboard "say why the query ran …", "following the link …" |

### 10.6 Measurement

The re-run path gains a lookup in the key's ring (at most 8 records), a digest computed once per subscription,
and a small object per Completion. `packages/server/bench/sync-rerun-links.ts`: one in-process session with 1000
queries that each read the whole table, so every commit re-runs all 1000. Timed from the mutation's call until the
transition is sent; 60 commits per run, tracing off, the ring at 8. Main's server sources and this branch's ran
interleaved, 12 runs each, Bun 1.4.2, Apple Silicon, load average 8–11 from other sessions.

| | p50 per commit, median of runs (best) | mean per commit, median of runs |
|---|--:|--:|
| main | 57.0 ms (52.5) | 57.4 ms |
| this branch | 54.7 ms (52.2) | 55.3 ms |

About 55 µs per re-run on both: the difference is within the run-to-run noise.

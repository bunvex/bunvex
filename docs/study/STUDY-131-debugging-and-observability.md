# STUDY-131 — Seeing inside a deployment: system tables, subscriptions, traces

- **Status:** accepted (owner, 2026-10-05): AD-24 to AD-27, AD-26 with an in-house exporter, and T1 module by module
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

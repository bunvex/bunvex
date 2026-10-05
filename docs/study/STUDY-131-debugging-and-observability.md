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

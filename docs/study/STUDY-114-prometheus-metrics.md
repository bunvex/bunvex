# STUDY-114 — Prometheus `/metrics`

- **Status:** implemented; DV-377 and DV-378 decided by the owner (2026-10-05)
- **Convex source read:** commit `4577b903` of get-convex/convex-backend
- **Related:** DV-162 (`/stats`), [STUDY-58](STUDY-58-app-metrics.md) (the dashboard's app metrics),
  [STUDY-38](STUDY-38-docker.md) (docker-compose)

## 1. How Convex does it

**The route.** `/metrics` is one of the two *meta routes* of every `ConvexHttpService`, with `/version`
(`crates/common/src/http/mod.rs:568-573`):

- `serve` merges them into the service's router (`:575-591`); `serve_with_middleware` puts them in front, the
  service as their fallback (`:615-631`). They are on unless `set_meta_routes_enabled(false)`, which the
  local backend never calls.
- The local backend runs two services (`crates/local_backend/src/main.rs:174-189`): the API (`backend`, port
  3210) and the dev site proxy (`backend_http_proxy`, port 3211, `crates/local_backend/src/proxy.rs:59-66`),
  whose router forwards every path to `/http/…` of the API as a *fallback*. So **both ports answer
  `/metrics` themselves**, from the one process's registry, and on the site port it shadows an app's HTTP
  action at `/metrics`.
- It is an axum `get` route: GET and HEAD; another method is a 405.

**The handler** (`metrics`, `crates/common/src/http/mod.rs:1366-1386`):

- If `DISABLE_METRICS_ENDPOINT` is set, it fails with `ErrorMetadata::not_found("MetricsDisabled",
  "/metrics endpoint disabled")`: a 404 with the JSON body `{"code":"MetricsDisabled","message":"/metrics
  endpoint disabled"}`.
- Otherwise it gathers `CONVEX_METRICS_REGISTRY` and returns the Prometheus `TextEncoder` output as a
  `String`: 200, `text/plain; charset=utf-8` (axum's type for a string; no `version=0.0.4`). No auth.
- The first scrape also starts the sweeper of stale label sets (`spawn_sweep_task`).

**The knob** (`crates/common/src/knobs.rs:2020-2021`): `env_config("DISABLE_METRICS_ENDPOINT", false)`, a
`bool` parsed with Rust's `FromStr` (`crates/cmd_util/src/env.rs:23-48`): only `true` and `false` parse;
any other value logs a warning and falls back to the default, `false`. The self-hosted
`docker-compose.yml:31` sets `DISABLE_METRICS_ENDPOINT=${DISABLE_METRICS_ENDPOINT:-true}`: off unless the
operator turns it on.

**The registry** (`crates/metrics/src/metrics.rs:76-93`): every metric is prefixed with the executable's
name (`-` → `_`), and carries an `instance_name` label when `CONVEX_SITE` is set. Names end with a unit from
`ALLOWED_SUFFIXES` (`:38-73`: `_seconds`, `_bytes`, `_total`, `_info`, `_commits`, …). Metrics are statics
registered on first use, so a series appears once it has been recorded. About 800 series describe Convex's
internals (isolate pools, the committer's phases, the subscription worker, …), many with a
`partition_id` label. Histograms are `VMHistogram`s (`register_convex_histogram!`,
`crates/metrics/src/macros.rs:17-63`): VictoriaMetrics' `vmrange` buckets, not Prometheus's `le`.

**The argument-size metrics** (`crates/sync/src/metrics.rs:103-145`, recorded in
`crates/sync/src/worker.rs`), each with `partition_id`:

| Metric | Recorded |
|---|---|
| `sync_query_modification_args_bytes` | per `ModifyQuerySet`: the sum of `args.get().len()` (the raw JSON) of its `Add` entries (`worker.rs:648-655`), before the set is modified |
| `sync_mutation_args_bytes` | per `Mutation`: the raw JSON args' length (`:670`), before the identity is checked |
| `sync_action_args_bytes` | per `Action`: the same (`:780`) |
| `sync_transition_message_size_bytes` | every message the worker sends (`:491-492`, "Heap size of Transition messages"): `response.heap_size()`, so pings and mutation responses too; not the fatal and auth errors, which leave the loop before |

## 2. What an app can observe

Apps don't see `/metrics`; operators and their Prometheus do:

- `GET /metrics` on the API and site ports, with no auth: 200 and a text exposition, or 404
  `MetricsDisabled` with `DISABLE_METRICS_ENDPOINT=true`.
- On the site port, an HTTP action routed at `/metrics` is never reached.
- The series' names and meanings are a backend's own: a dashboard built for Convex's would need its names.

## 3. How bunvex does it

- `packages/server/src/prometheus.ts`: a small registry and the 0.0.4 text encoder (no dependency): counter
  and histogram families with labels, and counters and gauges *collected* at scrape time from counts bunvex
  already keeps (the committer's, the sync hub's, the engine's cache stats, the scheduler's), so nothing is
  counted twice. Label values and HELP text are escaped as the format says; `+Inf`, `-Inf`, `NaN` are
  written as Go writes them.
- `packages/server/src/server-metrics.ts`: bunvex's series (DV-377), and the knob `metricsEndpointDisabled`
  (Convex's bool parsing: only `true` disables, another value warns and is ignored).
- `server.ts`: `/metrics` on both ports, before anything else of the site port (as Convex's meta route);
  GET/HEAD, else 405; 404 `{"code":"MetricsDisabled","message":"/metrics endpoint disabled"}` when
  disabled; `createServer({ disableMetricsEndpoint })` overrides the environment.
- `docker/docker-compose.yml`: `DISABLE_METRICS_ENDPOINT=${DISABLE_METRICS_ENDPOINT:-true}`, as Convex's.

The series (31 families, all prefixed `bunvex_`):

| Area | Series |
|---|---|
| Version | `version_info{version}` |
| Functions | `udf_executions_total{udf_type}`, `udf_errors_total{udf_type}`, `udf_execution_seconds{udf_type}` (histogram); `udf_type` ∈ query, mutation, action, http_action; no per-function label (the app metrics have those). Recorded where the app metrics record an execution (`Functions.logCompletion`): system functions aside, an OCC-retried attempt counts as a failed one |
| Committer | `database_commits_total`, `database_commit_conflicts_total`, `database_commit_groups_total`, `database_write_batch_commits` (histogram, as Convex's), `database_commit_persistence_write_seconds` (histogram, as Convex's: one flush, retries included), `database_visible_ts_seconds`, `query_cache_hits_total`, `query_cache_misses_total` |
| Sync | `sync_sessions`, `sync_subscriptions`, `sync_subscription_invalidations_total`, `sync_transitions_total`, `sync_query_executions_total`, `sync_query_reused_total`, and Convex's four histograms: `sync_query_modification_args_bytes`, `sync_mutation_args_bytes`, `sync_action_args_bytes`, `sync_transition_message_size_bytes` |
| Scheduler | `scheduled_job_running_jobs`, `scheduled_job_backlog_seconds` (Convex's name: the age of the oldest runnable job), `scheduled_job_result_total{result}` |
| Search | `search_indexes{kind,state}` (text/vector × ready/backfilling/bootstrapping), `search_indexes_loaded_total` (from their segments at start, STUDY-111; `restored_total` before the segments replaced the snapshot) |
| Process | `process_resident_memory_bytes`, `process_heap_bytes`, `process_event_loop_lag_seconds` (an unref'd 500 ms probe; Bun's `monitorEventLoopDelay` misses blocked loops), `process_start_time_seconds` |

The argument sizes are the arguments' JSON bytes (`Buffer.byteLength(JSON.stringify(args))`), recorded when
the message is handled and before it is checked, as Convex; a client that sends `JSON.stringify` output
(every bunvex and Convex client) gives Convex's raw length. A message's size is its encoded bytes (Convex:
its heap size); a transition counts once, before it is chunked; FatalError and AuthError are not counted.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-377 | bunvex's own 31 series, prefixed `bunvex_`, where Convex exposes ~800 of its internals prefixed with its binary's name; no `partition_id` or `instance_name` labels; every series shown from the start (Convex's appear once recorded); message size in encoded bytes, not heap bytes | Convex's series describe its services (isolate pools, partitions, the committer's phases), which bunvex does not have; rule 5 forbids Convex's prefix. The same set cannot be built | owner, 2026-10-05 |
| DV-378 | Histograms are Prometheus's cumulative `le` buckets with `_sum` and `_count` | Convex's are VictoriaMetrics' `vmrange` buckets, which Prometheus's own queries (`histogram_quantile`) do not read | owner, 2026-10-05 |

Same as Convex: the route on both ports, no auth, the knob and its parsing, the 404 code and message,
the content type, the docker-compose default.

## 4b. Additions (beyond Convex)

None.

## 5. Tests

`packages/server/test/prometheus-metrics.test.ts`, with a strict parser of the 0.0.4 format (HELP/TYPE
before samples, names, label escapes, values, no duplicate series; per histogram: ascending `le`,
cumulative counts, `+Inf` = `_count`):

- the scrape parses, every family `bunvex_`-prefixed with its HELP, on both ports with no auth, ahead of an
  app's HTTP action at `/metrics`; POST is a 405;
- two mutations and a failing one: executions +3, errors +1, the duration histogram +3, commits +2, two
  write batches, two flush latencies, the visible ts;
- sync: sessions, subscriptions, invalidations, the arguments' bytes of a ModifyQuerySet (multi-byte
  characters counted as bytes), a mutation and a 5 kB action (in the right bucket), message sizes;
- `DISABLE_METRICS_ENDPOINT=true`: 404 `MetricsDisabled` on both ports; the option overrides;
- the knob: only `true` disables;
- histogram buckets cumulative, `le` inclusive, label escaping, registration errors;
- `+Inf`, `-Inf`, `NaN` and HELP escaping.

No oracle: there is no Convex backend binary to scrape here, and its series are not bunvex's (DV-377).

**Sabotage** (each restored after): buckets written non-cumulative; `le` exclusive; label quotes not
escaped; `DISABLE_METRICS_ENDPOINT=1` disabling; the knob ignored; another 404 code; argument sizes in
characters, not bytes; only the first `Add` counted; action args into the mutation histogram; commits
counted one short; errors counted on success; the site port without `/metrics`; the subscriptions gauge
reading sessions. Each made a test fail (the errors one only once the test had two successes for one
failure).

**Measurement** (the recording, in isolation; M-series laptop, Bun 1.4.2): per write batch 74 ns (two
`performance.now()` and two observations); per execution 23 ns; per sync mutation 79 ns with 100 B of
arguments, 3.7 µs with 11 kB (a `JSON.stringify` of the arguments); per sync message 22 ns (200 B), 52 µs
for a 1 MB transition (its `byteLength`, next to the milliseconds its encoding takes); a scrape encodes in
~54 µs (16 kB). End to end, A/B in one process (recording toggled), commits, sync mutations and HTTP
mutations differed by less than the run-to-run noise (medians: commit 16.2 → 20.3 µs, sync mutation
141 → 121 µs, HTTP mutation 143 → 132 µs).

## 6. Open questions

None.

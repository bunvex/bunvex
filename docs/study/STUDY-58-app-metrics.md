# STUDY-58 — App metrics (`/api/app_metrics/*`)

- **Status:** implemented; decision pending (owner): DV-302
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03; HdrHistogram_rust `main` (Convex
  pins `hdrhistogram = "7.5.4"`)
- **Related:** [STUDY-47](STUDY-47-log-streaming.md) (the function log the metrics are fed from), STUDY-12
  §12 and UI-01 §18 (the dashboard's Health page and table metrics), [STUDY-30](STUDY-30-scheduler-and-crons.md)
  (the scheduler), STUDY-31 (action permits). The owner chose Convex's model: 1-minute buckets, 1 hour, in
  memory.

## 1. How Convex does it

### 1.1 The store (`crates/udf_metrics/src/lib.rs`)

- Buckets are `[base + i·60 s, base + (i+1)·60 s)`, where `base` is the store's creation (the process
  start). Only the newest 60 buckets across all metrics are kept (`UDF_METRICS_*` knobs). A metric left
  with no bucket is dropped.
- A sample before the newest bucket (across every metric) is refused (`SamplePrecedesCutoff`). In
  `log_execution_app_metrics` the first refusal stops that execution's other samples.
- **Counters** add up in f32. **Gauges** keep the last value, or the highest with `add_gauge_max`.
- **Histograms** are HdrHistogram with a range of 1 ms – 15 min and 2 significant figures.
  - Counts are u8 (`Histogram<u8>`) and saturate at 255. `total_count` does not saturate.
  - A sample is whole milliseconds (`as_millis`), clamped to the range.
- **A query window** is `{start, end, num_buckets}`. `start` and `end` are serde `SystemTime`s
  (`{secs_since_epoch, nanos_since_epoch}`). `end < start` gives "Invalid query window", and
  `num_buckets` outside 1–10 000 gives "Invalid query num_buckets: n".
  - Each output bucket is `floor((end − start) / n)` wide.
  - A store bucket goes to the output bucket its *start* falls in (`bucket_index`, in f64 seconds).
- **Resampling**:
  - Counters are null outside the store's kept range and 0 inside it, and the buckets add up.
    `is_rate` divides by the output bucket width in seconds.
  - Gauges: the last value per output bucket, carried forward between the first and the last bucket set.
  - Histograms: an empty histogram per output bucket inside the range, then each store bucket is merged
    with HdrHistogram's `add`.
    - Into an empty histogram, `add` copies the counts *and the uncapped total*.
    - Otherwise counts saturate, and the total grows by the source's counts.
    - A percentile is `value_at_percentile` (the highest equivalent value; 0 when the target count is
      never reached), at least 1 ms for a non-empty histogram, in seconds.
    - At most 5 percentiles are allowed; the answer is ordered by percentile (a `BTreeMap`).
    - The quirk: once a sub-bucket passes 255 samples in a minute, high percentiles fall through to 0 and
      read 1 ms.

### 1.2 What is recorded (`application/src/function_log.rs`)

- **Every completion** of a non-system function is recorded at its logging time
  (`execution.unix_timestamp`). That includes a mutation's OCC retries and an HTTP action whose route
  matched.
  - `udf:<name>:invocations`, plus `udf:<name>:errors` when it failed.
  - For a query, `udf:<name>:cache_hits` or `cache_misses`.
  - `udf:<name>:execution_time` (a histogram).
  - Per table it touched, `table:<t>:rows_read` and `rows_written`. `TableStats` count one per `get`
    (found or not) and one per scanned document read; writes count one each. A rolled-back
    sub-transaction's counts stay.
- **Names**: `<name>` is the canonical path (`module.js:function`, prefixed by its component path). For
  an HTTP action it is the matched route's path (`UdfIdentifier::Http` displays `route.path`).
- **Subscription invalidations**:
  - `subscription_invalidations:<writeSource>:<tablet>` counts the subscriptions each commit
    invalidated (`subscription.rs` `advance_log`).
  - Each invalidation is attributed to the first write that overlapped the subscription, by its write
    source's display name and its tablet.
  - The routes resolve tablets to table names.
- **The scheduler**:
  - The gauge `scheduled_jobs:next_ts` is now − the next ready job's time, in seconds (−∞ when there is
    none).
  - It is logged when that time moves by 30 s or more, appears or goes, and every 30 s while it is
    overdue (`scheduled_jobs/mod.rs`). A late sample moves to the cutoff.
- **Concurrency**:
  - `outstanding_functions:<env>:<UdfType>:<running|queued>` is a max-per-bucket gauge.
  - It is reported by each function-type limiter (queries, mutations, actions, HTTP actions; isolate or
    node) whenever a permit is taken or released.

### 1.3 The routes (`local_backend/src/app_metrics.rs`, all `GET`, `ViewMetrics`)

| Route | Arguments | Answer |
|---|---|---|
| `udf_rate` | `udfPath` (or `path`), `metric`, `window`, `componentPath?`, `udfType?` | `[[time, value]]`, a rate per second; `subscriptionInvalidations` sums the function's tables |
| `cache_hit_percentage` | `udfPath`, `window`, … | hits / (hits + misses) × 100 per bucket |
| `failure_percentage_top_k` | `window`, `k?` | `[[name, series]]`: errors / invocations × 100, ranked by the whole window, highest first; only names with errors; `_rest` |
| `cache_hit_percentage_top_k` | `window`, `k?` | ranked lowest first |
| `function_call_count_top_k` | `window`, `k?` | counts; `_rest` sums the others |
| `subscription_invalidations_top_k` | `window`, `k?`, `udfPath?` | keys `mutation:table`, or `table` for one mutation |
| `table_rate` | `name`, `metric` (`rowsRead`, `rowsWritten`), `window` | rows per second |
| `latency_percentiles` | `udfPath`, `percentiles` (JSON array), `window` | `[[p, series]]`, seconds |
| `scheduled_job_lag` | `window` | gauges carried forward; a null after a value grows by the time passed; clamped at 0 |
| `function_concurrency` | `window` | `{metricName: series}` |

- `k` defaults to 5. Outside 1–25 it is a 400 `InvalidTopKParameter`, "k must be between 1 and 25, got
  k". Ties are broken by name.
- A missing argument, or a `k` that is not a number, is a 400 `BadQueryArgs` (the query extractor).
- Everything else that fails to parse is an untyped error, so a 500: the window, `metric` ("Invalid UDF
  rate"), `udfType`, the path, the table name, `percentiles`.
- Times serialize as `{secs_since_epoch, nanos_since_epoch}`; a NaN value serializes as `null`.

## 2. What an app can observe

The dashboard's Health page and a table's metrics. These are the routes' JSON for given traffic. Apps
themselves see nothing.

## 3. How bunvex does it

- **`server/src/app-metrics.ts`**:
  - `MetricStore` holds per-metric bucket maps, the newest index across metrics, Convex's refusal of late
    samples, and its pruning.
  - `Histogram` is HdrHistogram's layout for this configuration: 256 sub-buckets, 14 × 128 u8 counts.
    It saturates as HdrHistogram does, and `add` and `value_at_percentile` follow it, the copy into an
    empty histogram included.
  - `MetricsWindow` keeps nanoseconds in bigints, with Convex's width and f64 bucket index.
  - `AppMetrics` records and answers as `function_log.rs`.
- **Recording**:
  - `Functions.logged` records each completion it logs, OCC retries included, and never a system
    function, as the function log.
  - The name is the canonical path. An HTTP action uses the router's matched path (a prefix route's ends
    in `*`).
  - Per-table rows come from the transaction's new `tableStats`, counted as Convex's `TableStats`.
- **Subscription invalidations**:
  - The sync hub attributes each newly invalidated session query to the first overlapping write of the
    commit (`firstOverlap`): its write source and its index's table.
  - It hands the counts to `onInvalidations`.
  - A function source is named by its canonical path. A system source (e.g. `_system/storage`) keeps its
    name, as Convex's `WriteSource::System`.
- **The scheduler** reports the next ready time with Convex's logging rule. That time is the first due
  job left waiting for capacity, else the next job.
- **Concurrency**: see DV-302.
- **The routes** are `GET /api/app_metrics/<route>` with `ViewMetrics`, with Convex's arguments, answers
  and errors (`app-metrics-routes.ts`).
- **Cost**, measured in process (30 000 calls × 3 rounds, through the function log):
  - recording costs about +1.3 µs per query (≈ 11 µs) and +1 µs per mutation (≈ 24 µs);
  - the transaction's per-table counts are within the noise.

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-302 | `function_concurrency`: actions and HTTP actions share one permit pool (STUDY-31), reported as two gauges from that pool's counts. Queries and mutations have no limiter, so `running` is the number in flight and `queued` is always 0. There are no `node` gauges (a `"use node"` action runs in the same pool). | bunvex's limiters are not Convex's. "Ainda não fizemos": per-type limiters were never built. | pending |

Not divergences:

- A component path prefixes the name, as in Convex. bunvex has no components, so such a query reads
  nothing.
- The metrics are in memory and lost on restart, as Convex's.

## 5. Tests

`server/test/app-metrics.test.ts`:

- **The histogram**:
  - exact values below 256 ms, the highest equivalent above, clamping;
  - u8 saturation and the merge's total, so p99 falls through to 0.
- **The store**:
  - rates, zero-fill, nulls outside the range, a late sample dropped;
  - 60 buckets kept;
  - gauges carried forward, and the lag growing after the last sample;
  - the window's errors;
  - top k by total, then name, with `_rest`, and failure rates only for functions with errors.
- **Through the server**:
  - invocations, errors, cache hits (HTTP, actions' nested queries), HTTP actions by route path;
  - `cache_hit_percentage`;
  - `table_rate` read (`collect` and `get`) and written;
  - latency percentiles' order, and no system functions;
  - the routes' 400s and 500s, and access;
  - subscription invalidations by `mutation:table` and for one mutation;
  - concurrency gauges, and the scheduler lag.
- **Sabotage checks**, each failing a test:
  - the u8 cap, the merge's copy, the late-sample drop, pruning, rates, cache hits;
  - ranking, `_rest`, lag growth;
  - `get` and write row counts, the route path;
  - invalidation attribution, the permit gauges, the scheduler stats;
  - `k` and `num_buckets` validation.

## 6. Open questions

- Search and vector search reads are not counted in `rows_read`. Convex's text search counts the
  documents it fetches through `TableStats` too (not verified).
- The dashboard still reads metrics from the mock. A server-backed source can map `MetricsFeatures` onto
  these routes (`TopKSeries` ⇐ `[[name, series]]`, ms ⇐ seconds).

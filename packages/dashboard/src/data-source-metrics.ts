// The deployment's metrics in the dashboard contract (UI-01 §18, STUDY-12 §12), as Convex's
// `/api/app_metrics/*` (crates/local_backend/src/app_metrics.rs): a time window split into equal buckets,
// and per bucket a value or `null` (nothing to measure). Every method is optional — a source offers
// metrics by having them (detected with `typeof`) — and needs the `viewMetrics` operation. Re-exported by
// `data-source.ts`.
import type { CallOptions } from "./data-source.ts";

/** `[start, end)` in wall-clock ms, split into `numBuckets` equal buckets (Convex's `MetricsWindow`). */
export type MetricsWindow = { start: number; end: number; numBuckets: number };

/** A bucket's start (ms) and its value; `null` when there was nothing to measure in it. */
export type MetricBucket = { time: number; value: number | null };

/** One bucket per window bucket, oldest first. */
export type Timeseries = MetricBucket[];

/** Per function (Convex's `UdfMetric`): counts per bucket. */
export type FunctionMetric = "invocations" | "errors" | "cacheHits" | "cacheMisses";

/** Per table (Convex's `TableMetric`): rows per bucket. */
export type TableMetric = "rowsRead" | "rowsWritten";

/**
 * The top functions for a measure, each with its series; `REST` stands for all the others together, as
 * Convex's `_rest`.
 */
export type TopKSeries = { function: string; series: Timeseries }[];
export const REST = "_rest";

export type TopKMeasure = "invocations" | "failurePercentage" | "cacheHitPercentage";

export interface MetricsFeatures {
  /** A function's count per bucket (Convex's `udf_rate`). */
  functionRate?(fn: string, metric: FunctionMetric, window: MetricsWindow, opts?: CallOptions): Promise<Timeseries>;
  /** A query's cache hits as a percentage (0–100) of its calls per bucket (Convex's `cache_hit_percentage`). */
  cacheHitPercentage?(fn: string, window: MetricsWindow, opts?: CallOptions): Promise<Timeseries>;
  /**
   * A function's execution time percentiles in ms per bucket (Convex's `latency_percentiles`): one series per
   * asked percentile, in the order asked.
   */
  latencyPercentiles?(
    fn: string,
    percentiles: number[],
    window: MetricsWindow,
    opts?: CallOptions,
  ): Promise<{ percentile: number; series: Timeseries }[]>;
  /**
   * The `k` functions with the most calls, the highest failure rate or the highest cache hit rate over the
   * window, plus `REST` (Convex's `function_call_count_top_k`, `failure_percentage_top_k`,
   * `cache_hit_percentage_top_k`). Percentages are 0–100.
   */
  topFunctions?(measure: TopKMeasure, window: MetricsWindow, k: number, opts?: CallOptions): Promise<TopKSeries>;
  /** A table's rows read or written per bucket (Convex's `table_rate`). */
  tableRate?(table: string, metric: TableMetric, window: MetricsWindow, opts?: CallOptions): Promise<Timeseries>;
  /** How late scheduled runs started, in seconds, per bucket (Convex's `scheduled_job_lag`). */
  scheduledJobLag?(window: MetricsWindow, opts?: CallOptions): Promise<Timeseries>;
}

/** The start of each bucket of `w`. */
export function bucketStarts(w: MetricsWindow): number[] {
  const size = (w.end - w.start) / w.numBuckets;
  return Array.from({ length: w.numBuckets }, (_, i) => w.start + i * size);
}

/** Which bucket of `w` a time falls in, or -1 outside the window. */
export function bucketOf(w: MetricsWindow, time: number): number {
  if (time < w.start || time >= w.end) return -1;
  return Math.min(w.numBuckets - 1, Math.floor(((time - w.start) / (w.end - w.start)) * w.numBuckets));
}

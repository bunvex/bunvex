// The mock's metrics (UI-01 §18, data-source-metrics.ts), measured from its own log history, so the charts
// agree with the Logs screen: an execution's last line gives its function, outcome and duration. What the
// log does not say is derived from the execution id, so it stays the same on every call: whether a query
// hit the cache (only queries are cached, as in Convex), and how many rows a function read or wrote in the
// table its module is named after.
import {
  bucketOf,
  bucketStarts,
  type FunctionMetric,
  type LogEntry,
  type MetricsWindow,
  REST,
  type TableMetric,
  type Timeseries,
  type TopKMeasure,
  type TopKSeries,
} from "../data-source.ts";

type Execution = { fn: string; kind: string; time: number; failed: boolean; durationMs: number; id: string };

/** A stable number from an id, for what the log does not record. */
function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export const executionsOf = (logs: readonly LogEntry[]): Execution[] =>
  logs.flatMap((e) =>
    e.execution && e.function
      ? [
          {
            fn: e.function.path,
            kind: e.function.kind,
            time: e.time,
            failed: e.execution.status === "failure",
            durationMs: e.execution.durationMs,
            id: e.executionId ?? e.id,
          },
        ]
      : [],
  );

/** A query's result came from the cache: about two in three, never for a mutation or an action. */
export const cached = (x: Execution) => x.kind === "query" && !x.failed && hash(x.id) % 3 !== 0;

function counts(w: MetricsWindow, xs: Execution[], pick: (x: Execution) => number): Timeseries {
  const out = bucketStarts(w).map((time) => ({ time, value: 0 as number | null }));
  for (const x of xs) {
    const b = bucketOf(w, x.time);
    if (b >= 0) out[b]!.value = (out[b]!.value ?? 0) + pick(x);
  }
  return out;
}

/** Per bucket, `part / whole` as a percentage, or null where there was no call. */
function percentage(w: MetricsWindow, xs: Execution[], part: (x: Execution) => boolean): Timeseries {
  const whole = counts(w, xs, () => 1);
  const parts = counts(w, xs, (x) => (part(x) ? 1 : 0));
  return whole.map((b, i) => ({ time: b.time, value: b.value ? ((parts[i]!.value ?? 0) / b.value) * 100 : null }));
}

export function functionRate(logs: readonly LogEntry[], fn: string, metric: FunctionMetric, w: MetricsWindow) {
  const xs = executionsOf(logs).filter((x) => x.fn === fn);
  const pick: Record<FunctionMetric, (x: Execution) => number> = {
    invocations: () => 1,
    errors: (x) => (x.failed ? 1 : 0),
    cacheHits: (x) => (cached(x) ? 1 : 0),
    cacheMisses: (x) => (x.kind === "query" && !cached(x) ? 1 : 0),
  };
  return counts(w, xs, pick[metric]);
}

export const cacheHitPercentage = (logs: readonly LogEntry[], fn: string, w: MetricsWindow) =>
  percentage(
    w,
    executionsOf(logs).filter((x) => x.fn === fn && x.kind === "query"),
    cached,
  );

/** The `p`th percentile (nearest rank) of sorted values. */
const nearestRank = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;

export function latencyPercentiles(logs: readonly LogEntry[], fn: string, percentiles: number[], w: MetricsWindow) {
  const per = bucketStarts(w).map(() => [] as number[]);
  for (const x of executionsOf(logs)) {
    const b = x.fn === fn ? bucketOf(w, x.time) : -1;
    if (b >= 0) per[b]!.push(x.durationMs);
  }
  const sorted = per.map((d) => d.sort((a, b) => a - b));
  const starts = bucketStarts(w);
  return percentiles.map((percentile) => ({
    percentile,
    series: sorted.map((d, i) => ({ time: starts[i]!, value: d.length ? nearestRank(d, percentile) : null })),
  }));
}

export function topFunctions(logs: readonly LogEntry[], measure: TopKMeasure, w: MetricsWindow, k: number): TopKSeries {
  const xs = executionsOf(logs).filter((x) => bucketOf(w, x.time) >= 0);
  const byFn = new Map<string, Execution[]>();
  for (const x of xs) byFn.set(x.fn, [...(byFn.get(x.fn) ?? []), x]);
  const seriesOf = (group: Execution[]): Timeseries =>
    measure === "invocations"
      ? counts(w, group, () => 1)
      : measure === "failurePercentage"
        ? percentage(w, group, (x) => x.failed)
        : percentage(
            w,
            group.filter((x) => x.kind === "query"),
            cached,
          );
  // the ranking: most calls, highest failure rate, highest cache hit rate over the whole window
  const score = (group: Execution[]) => {
    if (measure === "invocations") return group.length;
    const pool = measure === "failurePercentage" ? group : group.filter((x) => x.kind === "query");
    if (pool.length === 0) return -1;
    return pool.filter(measure === "failurePercentage" ? (x) => x.failed : cached).length / pool.length;
  };
  const ranked = [...byFn.entries()]
    .filter(([, g]) => score(g) >= 0)
    .sort((a, b) => score(b[1]) - score(a[1]) || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, k);
  const rest = ranked.slice(k).flatMap(([, g]) => g);
  const out: TopKSeries = top.map(([fn, g]) => ({ function: fn, series: seriesOf(g) }));
  if (rest.length > 0) out.push({ function: REST, series: seriesOf(rest) });
  return out;
}

/** Rows a function read or wrote in the table its module is named after ("tasks:list" → tasks). */
function rows(x: Execution, metric: TableMetric): number {
  if (x.failed || x.kind === "action") return 0;
  if (metric === "rowsWritten") return x.kind === "mutation" ? 1 + (hash(x.id) % 3) : 0;
  return x.kind === "query" ? (cached(x) ? 0 : 5 + (hash(x.id) % 40)) : 1;
}

export function tableRate(logs: readonly LogEntry[], table: string, metric: TableMetric, w: MetricsWindow) {
  const xs = executionsOf(logs).filter((x) => x.fn.split(":")[0] === table);
  return counts(w, xs, (x) => rows(x, metric));
}

/** Seconds scheduled runs started late: up to 1.5 s, in the buckets where the scheduler started one. */
export function scheduledJobLag(logs: readonly LogEntry[], w: MetricsWindow): Timeseries {
  const starts = bucketStarts(w);
  const worst = starts.map(() => 0);
  for (const e of logs) {
    const b = e.execution?.identity === "system" ? bucketOf(w, e.time) : -1;
    if (b >= 0) worst[b] = Math.max(worst[b]!, (hash(e.executionId ?? e.id) % 1500) / 1000);
  }
  return starts.map((time, i) => ({ time, value: worst[i]! }));
}

// The metrics, over Convex's `/api/app_metrics/*` routes as its dashboard calls them
// (`dashboard-common/src/lib/appMetrics.ts`; STUDY-149 §1.2): `window` is a JSON `MetricsWindow` with
// `{secs_since_epoch, nanos_since_epoch}` times, a function is named by its path (`path=`), and every answer
// is `[time, value]` pairs. The contract's units are the screens': `udf_rate` is per second, as Convex's
// charts multiply it back by the bucket's width, so it becomes a count per bucket here; latencies come in
// seconds and leave in milliseconds (Convex's charts convert them the same way).
import {
  bucketStarts,
  CONCURRENCY_KINDS,
  type ConcurrencyKind,
  DataSourceError,
  type FunctionConcurrency,
  type FunctionMetric,
  type InvalidationSeries,
  type MetricsWindow,
  REST,
  type TableMetric,
  type Timeseries,
  type TopKMeasure,
  type TopKSeries,
} from "@bunvex/dashboard/data-source";
import type { AdminHttp } from "./admin-http.ts";
import { displayPath } from "./logs.ts";

type SerializedTime = { secs_since_epoch: number; nanos_since_epoch: number };
type SeriesJson = [SerializedTime, number | null][];

/** Convex's `serializeDate`. */
function serializeTime(ms: number): SerializedTime {
  const secs = Math.floor(ms / 1000);
  return { secs_since_epoch: secs, nanos_since_epoch: Math.floor((ms / 1000 - secs) * 1e9) };
}

/** The `window` parameter; a window the server would refuse is refused here, as the contract asks. */
export function windowParam(w: MetricsWindow): string {
  if (!Number.isInteger(w.numBuckets) || w.numBuckets < 1 || w.numBuckets > 10_000)
    throw new DataSourceError("invalid_request", `A window needs 1 to 10000 buckets, not ${w.numBuckets}.`);
  if (!(w.end > w.start)) throw new DataSourceError("invalid_request", "A window must end after it starts.");
  return JSON.stringify({ start: serializeTime(w.start), end: serializeTime(w.end), num_buckets: w.numBuckets });
}

/** The server's series as the contract's: one bucket per window bucket, at its start, scaled by `scale`. */
export function seriesOf(json: SeriesJson, w: MetricsWindow, scale = 1): Timeseries {
  const width = (w.end - w.start) / w.numBuckets;
  return json.map(([, v], i) => ({ time: w.start + i * width, value: v === null ? null : v * scale }));
}

const bucketSeconds = (w: MetricsWindow) => (w.end - w.start) / w.numBuckets / 1000;

const UDF_METRICS: Record<FunctionMetric, string> = {
  invocations: "invocations",
  errors: "errors",
  cacheHits: "cacheHits",
  cacheMisses: "cacheMisses",
};

/**
 * Convex's `mapFunctionTypeToDisplayName` (`appMetrics.ts`): the gauges its Health screen charts, by their
 * `outstanding_functions:<env>:<udfType>` prefix; any other is left out.
 */
const CONCURRENCY_GAUGES: Record<string, ConcurrencyKind> = {
  "isolate:Query": "query",
  "isolate:Mutation": "mutation",
  "isolate:Action": "action",
  "node:Action": "nodeAction",
  "isolate:HttpAction": "httpAction",
};

/** `function_concurrency`'s answer as the contract's: running and queued per kind, kinds in their order. */
export function concurrencyOf(json: Record<string, SeriesJson>, w: MetricsWindow): FunctionConcurrency {
  const byKind = new Map<ConcurrencyKind, { running?: Timeseries; queued?: Timeseries }>();
  for (const [name, series] of Object.entries(json)) {
    const parts = name.split(":");
    if (parts.length !== 4 || parts[0] !== "outstanding_functions") continue;
    const kind = CONCURRENCY_GAUGES[`${parts[1]}:${parts[2]}`];
    const state = parts[3];
    if (!kind || (state !== "running" && state !== "queued")) continue;
    byKind.set(kind, { ...byKind.get(kind), [state]: seriesOf(series, w) });
  }
  const empty = (): Timeseries => bucketStarts(w).map((time) => ({ time, value: null }));
  return CONCURRENCY_KINDS.flatMap((kind) => {
    const k = byKind.get(kind);
    return k ? [{ kind, running: k.running ?? empty(), queued: k.queued ?? empty() }] : [];
  });
}

/**
 * `subscription_invalidations_top_k`'s answer as the contract's. Its names are `<mutation>:<table>`, the mutation
 * by its canonical path, or the table alone when one mutation was asked for; `_rest` is the others.
 */
export function invalidationsOf(json: [string, SeriesJson][], w: MetricsWindow, fn?: string): InvalidationSeries {
  return json.map(([name, s]) => {
    const series = seriesOf(s, w);
    if (name === REST) return { function: REST, table: null, series };
    if (fn !== undefined) return { function: fn, table: name, series };
    const i = name.lastIndexOf(":");
    return i === -1
      ? { function: displayPath(name), table: null, series }
      : { function: displayPath(name.slice(0, i)), table: name.slice(i + 1), series };
  });
}

const TOP_K_ROUTES: Record<TopKMeasure, string> = {
  invocations: "function_call_count_top_k",
  failurePercentage: "failure_percentage_top_k",
  cacheHitPercentage: "cache_hit_percentage_top_k",
};

/** The metrics part of the server source. Every call needs the `viewMetrics` operation. */
export class Metrics {
  constructor(private readonly http: AdminHttp) {}

  private get<T>(route: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.http.json<T>(`/api/app_metrics/${route}?${new URLSearchParams(params)}`, { signal });
  }

  async functionRate(fn: string, metric: FunctionMetric, w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    const json = await this.get<SeriesJson>("udf_rate", { path: fn, metric: UDF_METRICS[metric], window }, signal);
    return seriesOf(json, w, bucketSeconds(w));
  }

  async cacheHitPercentage(fn: string, w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    return seriesOf(await this.get<SeriesJson>("cache_hit_percentage", { path: fn, window }, signal), w);
  }

  async latencyPercentiles(fn: string, percentiles: number[], w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    const json = await this.get<[number, SeriesJson][]>(
      "latency_percentiles",
      { path: fn, percentiles: JSON.stringify(percentiles), window },
      signal,
    );
    // The server answers each percentile once, in increasing order; the contract wants the order asked.
    const byPercentile = new Map(json.map(([p, s]) => [p, s]));
    return percentiles.map((p) => ({ percentile: p, series: seriesOf(byPercentile.get(p) ?? [], w, 1000) }));
  }

  async topFunctions(measure: TopKMeasure, w: MetricsWindow, k: number, signal?: AbortSignal): Promise<TopKSeries> {
    const window = windowParam(w);
    const json = await this.get<[string, SeriesJson][]>(TOP_K_ROUTES[measure], { window, k: String(k) }, signal);
    return json.map(([name, s]) => ({ function: name === REST ? REST : displayPath(name), series: seriesOf(s, w) }));
  }

  /** Convex's `table_rate` (`name=` the table), per second like `udf_rate`: a count per bucket here. */
  async tableRate(table: string, metric: TableMetric, w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    const json = await this.get<SeriesJson>("table_rate", { name: table, metric, window }, signal);
    return seriesOf(json, w, bucketSeconds(w));
  }

  async scheduledJobLag(w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    return seriesOf(await this.get<SeriesJson>("scheduled_job_lag", { window }, signal), w);
  }

  async functionConcurrency(w: MetricsWindow, signal?: AbortSignal) {
    const window = windowParam(w);
    return concurrencyOf(await this.get<Record<string, SeriesJson>>("function_concurrency", { window }, signal), w);
  }

  /** As Convex's `useSubscriptionInvalidationsTopK`: one mutation's by its path, `udfType` `Mutation`. */
  async subscriptionInvalidations(w: MetricsWindow, k: number, fn?: string, signal?: AbortSignal) {
    const params: Record<string, string> = { window: windowParam(w), k: String(k) };
    if (fn !== undefined) Object.assign(params, { udfPath: fn, udfType: "Mutation" });
    return invalidationsOf(
      await this.get<[string, SeriesJson][]>("subscription_invalidations_top_k", params, signal),
      w,
      fn,
    );
  }
}

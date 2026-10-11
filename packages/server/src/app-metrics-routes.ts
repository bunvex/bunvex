// Convex's `/api/app_metrics/*` metric routes (crates/local_backend/src/app_metrics.rs, STUDY-58): each a GET
// with its arguments in the query string, `window` a JSON `MetricsWindow`. A missing argument or a bad `k`
// is a 400; anything else that fails to parse (the window, a metric, a path) is an internal error, as in
// Convex, where those are untyped errors.

import {
  type AppMetrics,
  MetricsWindow,
  seriesJson,
  type TableRateMetric,
  type Timeseries,
  type UdfRateMetric,
} from "./app-metrics.ts";
import { canonicalPath } from "./function-handles.ts";
import { functionPathError } from "./function-path.ts";

/** Convex's `Query` extractor's prefix on serde_urlencoded's message (common/src/http/extract.rs). */
const QUERY_ERROR = "Failed to deserialize query string: ";

/** A 400 with Convex's code. */
export class MetricsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UDF_RATES: readonly string[] = ["invocations", "errors", "cacheHits", "cacheMisses", "subscriptionInvalidations"];

/** The routes under `/api/app_metrics/` this answers (the log streams are elsewhere). */
export const APP_METRICS_ROUTES = new Set([
  "udf_rate",
  "failure_percentage_top_k",
  "cache_hit_percentage_top_k",
  "function_call_count_top_k",
  "subscription_invalidations_top_k",
  "cache_hit_percentage",
  "table_rate",
  "latency_percentiles",
  "scheduled_job_lag",
  "function_concurrency",
]);

/**
 * Each route's query arguments, as Convex's `*QueryArgs` structs declare them (serde reports the first missing
 * one in this order). `udfPath` also reads `path` (its serde alias).
 */
const REQUIRED: Record<string, string[]> = {
  udf_rate: ["udfPath", "metric", "window"],
  failure_percentage_top_k: ["window"],
  cache_hit_percentage_top_k: ["window"],
  function_call_count_top_k: ["window"],
  subscription_invalidations_top_k: ["window"],
  cache_hit_percentage: ["udfPath", "window"],
  latency_percentiles: ["udfPath", "percentiles", "window"],
  table_rate: ["name", "metric", "window"],
  scheduled_job_lag: ["window"],
  function_concurrency: ["window"],
};
const TOP_K = new Set(["failure_percentage_top_k", "cache_hit_percentage_top_k", "function_call_count_top_k"]);

/**
 * The body of `GET /api/app_metrics/<route>`: JSON as Convex's. Throws `MetricsRequestError` or `Error`.
 * `authorize` (the ViewMetrics check) runs where Convex's handler calls `metrics_log`: after the query string is
 * read (its extractor) and after each route's own parsing of the window, `k` and the path, so bad arguments
 * are answered before a missing key; a `udf_rate` metric is parsed after it.
 */
export function appMetricsRoute(
  metrics: AppMetrics,
  route: string,
  q: URLSearchParams,
  authorize: () => void = () => {},
): unknown {
  // Convex's `Query` extractor: the struct's fields, then `k` (an `Option<usize>`).
  const value = (name: string) => q.get(name) ?? (name === "udfPath" ? q.get("path") : null);
  if (TOP_K.has(route) || route === "subscription_invalidations_top_k") topKSyntax(q);
  for (const name of REQUIRED[route] ?? [])
    if (value(name) === null) throw new MetricsRequestError("BadQueryArgs", `${QUERY_ERROR}missing field \`${name}\``);
  const need = (name: string) => value(name)!;
  const window = () => MetricsWindow.parse(need("window"));
  const series = (ts: Timeseries) => seriesJson(ts);
  const named = (rows: [string | number, Timeseries][]) => rows.map(([k, ts]) => [k, seriesJson(ts)]);
  const udf = () => udfMetricName(q.get("udfType"), q.get("componentPath"), need("udfPath"));
  if (TOP_K.has(route)) {
    const w = window();
    const k = topK(q);
    authorize();
    if (route === "failure_percentage_top_k") return named(metrics.failurePercentageTopK(w, k));
    if (route === "cache_hit_percentage_top_k") return named(metrics.cacheHitPercentageTopK(w, k));
    return named(metrics.functionCallCountTopK(w, k));
  }
  switch (route) {
    case "udf_rate": {
      const w = window();
      const name = udf();
      authorize();
      const metric = need("metric");
      if (!UDF_RATES.includes(metric)) throw new Error(`Invalid UDF rate: ${metric}`);
      return series(metrics.udfRate(name, metric as UdfRateMetric, w));
    }
    case "subscription_invalidations_top_k": {
      const w = window();
      const k = topK(q);
      const path = value("udfPath");
      const mutation = path === null ? undefined : udfMetricName(q.get("udfType"), q.get("componentPath"), path);
      authorize();
      return named(metrics.subscriptionInvalidationsTopK(w, k, mutation));
    }
    case "cache_hit_percentage": {
      const w = window();
      const name = udf();
      authorize();
      return series(metrics.cacheHitPercentage(name, w));
    }
    case "table_rate": {
      const table = need("name");
      checkTableName(table);
      const metric = need("metric");
      if (metric !== "rowsRead" && metric !== "rowsWritten") throw new Error(`Invalid table rate: ${metric}`);
      const w = window();
      authorize();
      return series(metrics.tableRate(table, metric as TableRateMetric, w));
    }
    case "latency_percentiles": {
      const name = udf();
      const percentiles = JSON.parse(need("percentiles")) as unknown;
      if (!Array.isArray(percentiles) || !percentiles.every((p) => Number.isInteger(p) && p >= 0))
        throw new Error("invalid type: expected a sequence of unsigned integers");
      const w = window();
      authorize();
      return named(metrics.latencyPercentiles(name, percentiles as number[], w));
    }
    case "scheduled_job_lag": {
      const w = window();
      authorize();
      return series(metrics.scheduledJobLag(w));
    }
    case "function_concurrency": {
      const w = window();
      authorize();
      return Object.fromEntries(metrics.functionConcurrency(w).map(([n, ts]) => [n, seriesJson(ts)]));
    }
  }
  throw new Error(`no metrics route ${route}`);
}

/** `k` as the query extractor reads it (an `Option<usize>`): digits, else its 400. */
function topKSyntax(q: URLSearchParams) {
  const raw = q.get("k");
  if (raw !== null && !/^\d+$/.test(raw))
    throw new MetricsRequestError("BadQueryArgs", `${QUERY_ERROR}k: invalid digit found in string`);
}

/** Convex's `validate_k`: default 5, from 1 to 25. */
function topK(q: URLSearchParams): number {
  const raw = q.get("k");
  if (raw === null) return 5;
  if (!/^\d+$/.test(raw))
    throw new MetricsRequestError("BadQueryArgs", `${QUERY_ERROR}k: invalid digit found in string`);
  const k = Number(raw);
  if (k < 1 || k > 25) throw new MetricsRequestError("InvalidTopKParameter", `k must be between 1 and 25, got ${k}`);
  return k;
}

/**
 * Convex's `parse_udf_identifier`, as a metric name: a function's canonical path (`module.js:function`,
 * under its component's path); an HTTP action's `METHOD /path` names its path.
 */
function udfMetricName(udfType: string | null, componentPath: string | null, identifier: string): string {
  const type = udfType === null ? "query" : udfType;
  const known: Record<string, string> = {
    Query: "f",
    query: "f",
    Mutation: "f",
    mutation: "f",
    Action: "f",
    action: "f",
    HttpEndpoint: "h",
    httpEndpoint: "h",
    HttpAction: "h",
    httpAction: "h",
    http_action: "h",
  };
  const kind = known[type];
  if (kind === undefined) throw new Error(`Expected UdfType, got ${JSON.stringify(type)}`);
  if (kind === "h") {
    const i = identifier.lastIndexOf(" ");
    if (i === -1) throw new Error("Invalid HTTP action route");
    return identifier.slice(i + 1);
  }
  // Convex's `UdfPath` parse: an untyped error, an internal error to the caller.
  const bad = functionPathError(identifier);
  if (bad !== null) throw new Error(bad);
  const path = canonicalPath(identifier);
  return componentPath ? `${componentPath}/${path}` : path;
}

function checkTableName(name: string) {
  if (!/^_?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid table name: ${name}`);
}

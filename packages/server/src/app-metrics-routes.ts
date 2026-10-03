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

/** The body of `GET /api/app_metrics/<route>`: JSON as Convex's. Throws `MetricsRequestError` or `Error`. */
export function appMetricsRoute(metrics: AppMetrics, route: string, q: URLSearchParams): unknown {
  const need = (name: string, alias?: string) => {
    const v = q.get(name) ?? (alias === undefined ? null : q.get(alias));
    if (v === null) throw new MetricsRequestError("BadQueryArgs", `missing field \`${name}\``);
    return v;
  };
  const window = () => MetricsWindow.parse(need("window"));
  const series = (ts: Timeseries) => seriesJson(ts);
  const named = (rows: [string | number, Timeseries][]) => rows.map(([k, ts]) => [k, seriesJson(ts)]);
  const udf = () => udfMetricName(q.get("udfType"), q.get("componentPath"), need("udfPath", "path"));
  switch (route) {
    case "udf_rate": {
      const name = udf();
      const metric = need("metric");
      const w = window();
      if (!UDF_RATES.includes(metric)) throw new Error(`Invalid UDF rate: ${metric}`);
      return series(metrics.udfRate(name, metric as UdfRateMetric, w));
    }
    case "failure_percentage_top_k":
      return named(metrics.failurePercentageTopK(window(), topK(q)));
    case "cache_hit_percentage_top_k":
      return named(metrics.cacheHitPercentageTopK(window(), topK(q)));
    case "function_call_count_top_k":
      return named(metrics.functionCallCountTopK(window(), topK(q)));
    case "subscription_invalidations_top_k": {
      const path = q.get("udfPath") ?? q.get("path");
      const w = window();
      const k = topK(q);
      const mutation = path === null ? undefined : udfMetricName(q.get("udfType"), q.get("componentPath"), path);
      return named(metrics.subscriptionInvalidationsTopK(w, k, mutation));
    }
    case "cache_hit_percentage": {
      const name = udf();
      return series(metrics.cacheHitPercentage(name, window()));
    }
    case "table_rate": {
      const table = need("name");
      const metric = need("metric");
      const w = window();
      checkTableName(table);
      if (metric !== "rowsRead" && metric !== "rowsWritten") throw new Error(`Invalid table rate: ${metric}`);
      return series(metrics.tableRate(table, metric as TableRateMetric, w));
    }
    case "latency_percentiles": {
      const name = udf();
      const percentiles = JSON.parse(need("percentiles")) as unknown;
      if (!Array.isArray(percentiles) || !percentiles.every((p) => Number.isInteger(p) && p >= 0))
        throw new Error("invalid type: expected a sequence of unsigned integers");
      return named(metrics.latencyPercentiles(name, percentiles as number[], window()));
    }
    case "scheduled_job_lag":
      return series(metrics.scheduledJobLag(window()));
    case "function_concurrency":
      return Object.fromEntries(metrics.functionConcurrency(window()).map(([n, ts]) => [n, seriesJson(ts)]));
  }
  throw new Error(`no metrics route ${route}`);
}

/** Convex's `validate_k`: default 5, from 1 to 25. */
function topK(q: URLSearchParams): number {
  const raw = q.get("k");
  if (raw === null) return 5;
  if (!/^\d+$/.test(raw)) throw new MetricsRequestError("BadQueryArgs", "k: invalid digit found in string");
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
  const path = canonicalPath(identifier);
  return componentPath ? `${componentPath}/${path}` : path;
}

function checkTableName(name: string) {
  if (!/^_?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`Invalid table name: ${name}`);
}

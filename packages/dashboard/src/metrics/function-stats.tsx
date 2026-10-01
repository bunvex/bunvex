// A function's Statistics tab (UI-01 §18.2, STUDY-12 §12), as Convex's `PerformanceGraphs.tsx`: over the last
// hour, its calls and errors per minute, its execution time percentiles (p50, p90, p95, p99: one blue,
// light to dark, labelled at the lines' ends) and, for a query, the share of calls served from the cache.
import { useQueryScope } from "../context.tsx";
import type { FunctionInfo } from "../data-source.ts";
import { ChartCard } from "./chart-card.tsx";
import { formatCalls, formatMs, formatPercent, NO_METRICS, useMetric, useMetricsAccess } from "./metrics.ts";

const PERCENTILES = [50, 90, 95, 99];

function Rate({
  fn,
  metric,
  title,
  description,
}: {
  fn: string;
  metric: "invocations" | "errors";
  title: string;
  description: string;
}) {
  const { source } = useQueryScope();
  const q = useMetric(["function", fn, metric], true, (w, signal) => source.functionRate!(fn, metric, w, { signal }));
  return (
    <ChartCard
      title={title}
      description={description}
      series={
        q.data && [{ id: metric, label: title, points: q.data, color: metric === "errors" ? "series-2" : "series-1" }]
      }
      error={q.error}
      formatValue={formatCalls}
      empty="Not called in the last hour."
    />
  );
}

function ExecutionTime({ fn }: { fn: string }) {
  const { source } = useQueryScope();
  const q = useMetric(["function", fn, "latency"], typeof source.latencyPercentiles === "function", (w, signal) =>
    source.latencyPercentiles!(fn, PERCENTILES, w, { signal }),
  );
  return (
    <ChartCard
      title="Execution time"
      description="Percentiles per minute"
      series={q.data?.map((p) => ({
        id: `p${p.percentile}`,
        label: `p${p.percentile}`,
        points: p.series,
        color: `series-p${p.percentile}`,
      }))}
      error={q.error}
      formatValue={formatMs}
      directLabels
      empty="Not called in the last hour."
    />
  );
}

function CacheHitRate({ fn }: { fn: string }) {
  const { source } = useQueryScope();
  const q = useMetric(["function", fn, "cache"], true, (w, signal) => source.cacheHitPercentage!(fn, w, { signal }));
  return (
    <ChartCard
      title="Cache hit rate"
      description="Share of calls served from the cache, per minute"
      series={q.data && [{ id: "cache", label: "Cache hit rate", points: q.data, color: "series-3" }]}
      error={q.error}
      formatValue={formatPercent}
      max={100}
      empty="Not called in the last hour."
    />
  );
}

export function FunctionStats({ fn }: { fn: FunctionInfo }) {
  const access = useMetricsAccess("functionRate");
  const { source } = useQueryScope();
  if (access === undefined) return null;
  if (access !== "ok") return <p className="text-sm text-muted-foreground">{NO_METRICS[access]}</p>;
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <Rate fn={fn.path} metric="invocations" title="Function calls" description="Calls per minute" />
      <Rate fn={fn.path} metric="errors" title="Errors" description="Failed calls per minute" />
      {typeof source.latencyPercentiles === "function" && <ExecutionTime fn={fn.path} />}
      {fn.kind === "query" && typeof source.cacheHitPercentage === "function" && <CacheHitRate fn={fn.path} />}
    </div>
  );
}

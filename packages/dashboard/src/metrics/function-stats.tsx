// A function's Statistics tab (UI-01 §18.2, STUDY-12 §12), as Convex's `PerformanceGraphs.tsx`: over the last
// hour, its calls and errors per minute, its execution time percentiles (p50, p90, p95, p99: one blue,
// light to dark, labelled at the lines' ends) and, for a query, the share of calls served from the cache.
// When the source says which clients made the calls (UI-01 §33, a bunvex addition), its calls and errors by
// platform over the hour.
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { PLATFORM_LABEL } from "../clients/names.ts";
import { PlatformIcon } from "../clients/words.tsx";
import { useQueryScope } from "../context.tsx";
import { type FunctionInfo, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
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

function ByPlatform({ fn }: { fn: string }) {
  const { source } = useQueryScope();
  const q = useMetric(["function", fn, "clients"], true, (w, signal) => source.functionClients!(fn, w, { signal }));
  const d = q.data;
  const most = Math.max(1, ...(d?.byPlatform.map((p) => p.calls) ?? []));
  return (
    // relative: the table's hidden head stays inside the tab's scroller, not below the page
    <section aria-labelledby="chart-by-platform" className="relative flex min-w-0 flex-col gap-3 border p-4">
      <div>
        <h3 id="chart-by-platform" className="text-sm font-medium">
          By platform
        </h3>
        <p className="text-xs text-muted-foreground">Calls and errors in the last hour, by the client that made them</p>
      </div>
      {q.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load: {toDataSourceError(q.error).message}
        </p>
      ) : !d ? (
        <Skeleton className="h-[180px]" />
      ) : d.byPlatform.length === 0 && d.withoutClient.calls === 0 ? (
        <p className="text-sm text-muted-foreground">Not called in the last hour.</p>
      ) : (
        <>
          <table className="w-full text-sm" aria-label="Calls and errors by platform">
            <thead className="sr-only">
              <tr>
                <th>Platform</th>
                <th>Calls</th>
                <th>Errors</th>
              </tr>
            </thead>
            <tbody>
              {d.byPlatform.map((p) => (
                <tr key={p.platform}>
                  <th scope="row" className="w-32 py-1 pr-2 text-left font-normal">
                    <span className="flex items-center gap-1.5">
                      <PlatformIcon platform={p.platform} className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{PLATFORM_LABEL[p.platform]}</span>
                    </span>
                  </th>
                  <td className="py-1">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-2 flex-1 bg-muted">
                        <span
                          className="block h-full bg-[var(--series-1)]"
                          style={{ width: `${(p.calls / most) * 100}%` }}
                        />
                      </span>
                      <span className="w-12 text-right font-mono text-xs tabular-nums">{formatCount(p.calls)}</span>
                    </span>
                  </td>
                  <td
                    className={`w-20 py-1 text-right font-mono text-xs tabular-nums ${p.errors > 0 ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {p.errors === 0 ? "no errors" : `${formatCount(p.errors)} error${p.errors === 1 ? "" : "s"}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.withoutClient.calls > 0 && (
            <p className="text-xs text-muted-foreground">
              And {formatCount(d.withoutClient.calls)} call{d.withoutClient.calls === 1 ? "" : "s"} no client made
              (scheduled, crons, other functions)
              {d.withoutClient.errors > 0 && `, ${formatCount(d.withoutClient.errors)} failed`}.
            </p>
          )}
        </>
      )}
    </section>
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
      {typeof source.functionClients === "function" && <ByPlatform fn={fn.path} />}
    </div>
  );
}

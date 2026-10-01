// The Health screen's charts (UI-01 §18.1, STUDY-12 §12), as Convex's `HealthView.tsx`: over the last hour,
// the top functions by calls, by failure rate and by cache hit rate (the rest folded into "Other
// functions"), and how late scheduled runs started. Shown when the source has metrics and the credential
// may view them; otherwise it says why.
import { useQueryScope } from "../context.tsx";
import type { TopKMeasure } from "../data-source.ts";
import { ChartCard } from "./chart-card.tsx";
import {
  formatCalls,
  formatPercent,
  formatSeconds,
  NO_METRICS,
  topSeries,
  useMetric,
  useMetricsAccess,
} from "./metrics.ts";

const K = 5;

function TopChart(props: { measure: TopKMeasure; title: string; description: string }) {
  const { source } = useQueryScope();
  const q = useMetric(["top", props.measure, K], true, (w, signal) =>
    source.topFunctions!(props.measure, w, K, { signal }),
  );
  const percent = props.measure !== "invocations";
  return (
    <ChartCard
      title={props.title}
      description={props.description}
      series={q.data && topSeries(q.data)}
      error={q.error}
      formatValue={percent ? formatPercent : formatCalls}
      max={percent ? 100 : undefined}
      empty={
        props.measure === "cacheHitPercentage" ? "No query ran in the last hour." : "No function ran in the last hour."
      }
    />
  );
}

function SchedulerLag() {
  const { source } = useQueryScope();
  const q = useMetric(["scheduler-lag"], true, (w, signal) => source.scheduledJobLag!(w, { signal }));
  return (
    <ChartCard
      title="Scheduler lag"
      description="How late scheduled runs started, worst per minute"
      series={q.data && [{ id: "lag", label: "Lag", points: q.data, color: "series-1" }]}
      error={q.error}
      formatValue={formatSeconds}
    />
  );
}

export function HealthMetrics() {
  const top = useMetricsAccess("topFunctions");
  const lag = useMetricsAccess("scheduledJobLag");
  if (top === undefined) return null;
  return (
    <section aria-labelledby="function-metrics" className="mt-8">
      <h2 id="function-metrics" className="text-sm font-medium">
        Functions, last hour
      </h2>
      {top === "ok" ? (
        <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          <TopChart measure="invocations" title="Function calls" description={`Calls per minute, top ${K}`} />
          <TopChart
            measure="failurePercentage"
            title="Failure rate"
            description={`Share of calls that failed, per minute, top ${K}`}
          />
          <TopChart
            measure="cacheHitPercentage"
            title="Cache hit rate"
            description={`Share of query calls served from the cache, per minute, top ${K}`}
          />
          {lag === "ok" && <SchedulerLag />}
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{NO_METRICS[top]}</p>
      )}
    </section>
  );
}

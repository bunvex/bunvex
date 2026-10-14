// The Health screen's charts (UI-01 §18.1, STUDY-12 §12), as Convex's `HealthView.tsx`: over the last hour,
// its Functions section — the top functions by calls, by failure rate and by cache hit rate (the rest folded
// into "Other functions") — and its Concurrency section: how late scheduled runs started, how many functions
// ran and waited for a slot per kind, and the mutation and table pairs that re-ran the most subscribed queries.
// Shown when the source has metrics and the credential may view them; otherwise it says why.
import { Button } from "@bunvex/ui/components/button";
import { Heatmap, type HeatmapRow } from "@bunvex/ui/components/heatmap";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { useState } from "react";
import { useQueryScope } from "../context.tsx";
import {
  type ConcurrencyKind,
  type FunctionConcurrency,
  REST,
  type Timeseries,
  type TopKMeasure,
  type TopKSeries,
  toDataSourceError,
} from "../data-source.ts";
import { ChartCard } from "./chart-card.tsx";
import {
  formatCalls,
  formatPercent,
  formatSeconds,
  HEALTH_REFRESH_MS,
  invalidationSeries,
  NO_METRICS,
  topSeries,
  useMetric,
  useMetricsAccess,
} from "./metrics.ts";

const K = 5;

type View = "chart" | "heatmap";

/** A rate card's view, kept in this browser (as Convex keeps `health-*-view` in local storage). */
function useView(measure: TopKMeasure, initial: View): [View, (v: View) => void] {
  const key = `bunvex:health-${measure}-view`;
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === "chart" || v === "heatmap" ? v : initial;
    } catch {
      return initial;
    }
  });
  return [
    view,
    (v) => {
      setView(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // storage off: the choice lasts for this visit
      }
    },
  ];
}

/**
 * The heatmap's rows, as Convex's: worst first by the row's average (failures high, cache hits low), rows with
 * no value at all last; "Other functions" sorted with the rest.
 */
export function heatmapRows(top: TopKSeries, measure: "failurePercentage" | "cacheHitPercentage"): HeatmapRow[] {
  const avg = (t: TopKSeries[number]) => {
    const vs = t.series.map((p) => p.value).filter((v): v is number => v !== null);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };
  return [...top]
    .sort((a, b) => {
      const x = avg(a);
      const y = avg(b);
      if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
      return measure === "failurePercentage" ? y - x : x - y;
    })
    .map((t) => ({
      id: t.function,
      label: t.function === REST ? "Other functions" : t.function,
      cells: t.series.map((p) => p.value),
    }));
}

function ViewToggle(props: { title: string; view: View; onView: (v: View) => void }) {
  return (
    <fieldset className="m-0 flex gap-1 border-0 p-0">
      <legend className="sr-only">{`How to show ${props.title}`}</legend>
      {(["chart", "heatmap"] as const).map((v) => (
        <Button
          key={v}
          type="button"
          size="xs"
          variant={props.view === v ? "secondary" : "ghost"}
          aria-pressed={props.view === v}
          onClick={() => props.onView(v)}
        >
          {v === "chart" ? "Line chart" : "Heatmap"}
        </Button>
      ))}
    </fieldset>
  );
}

function TopChart(props: { measure: TopKMeasure; title: string; description: string }) {
  const { source } = useQueryScope();
  const q = useMetric(
    ["top", props.measure, K],
    true,
    (w, signal) => source.topFunctions!(props.measure, w, K, { signal }),
    HEALTH_REFRESH_MS,
  );
  const percent = props.measure !== "invocations";
  // as Convex: the failure rate opens as a line chart, the cache hit rate as a heatmap
  const [view, setView] = useView(props.measure, props.measure === "cacheHitPercentage" ? "heatmap" : "chart");
  if (props.measure !== "invocations" && view === "heatmap") {
    const failures = props.measure === "failurePercentage";
    const id = `chart-${props.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return (
      <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 border p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 id={id} className="text-sm font-medium">
              {props.title}
            </h3>
            <p className="text-xs text-muted-foreground">{props.description}</p>
          </div>
          <ViewToggle title={props.title} view={view} onView={setView} />
        </div>
        {q.error ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load: {toDataSourceError(q.error).message}
          </p>
        ) : q.data ? (
          <Heatmap
            label={`${props.title}, ${props.description}`}
            rows={heatmapRows(q.data, props.measure)}
            times={q.data[0]?.series.map((p) => p.time) ?? []}
            // the darker, the worse: more failures, or fewer cache hits
            intensity={(v) => (failures ? v / 100 : 1 - v / 100)}
            formatValue={(v) => `${formatPercent(v)} ${failures ? "failed" : "from the cache"}`}
            legend={failures ? ["0%", "100% failed"] : ["100%", "0% from the cache"]}
            empty={failures ? "No function ran in the last hour." : "No query ran in the last hour."}
          />
        ) : (
          <Skeleton className="h-[180px]" />
        )}
      </section>
    );
  }
  return (
    <ChartCard
      title={props.title}
      description={props.description}
      series={q.data && topSeries(q.data)}
      error={q.error}
      formatValue={percent ? formatPercent : formatCalls}
      max={percent ? 100 : undefined}
      actions={percent ? <ViewToggle title={props.title} view={view} onView={setView} /> : undefined}
      empty={
        props.measure === "cacheHitPercentage" ? "No query ran in the last hour." : "No function ran in the last hour."
      }
    />
  );
}

function SchedulerLag({ q }: { q: { data?: Timeseries; error: unknown } }) {
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

/** Convex's names for the kinds it charts (`mapFunctionTypeToDisplayName`, `appMetrics.ts`). */
export const CONCURRENCY_LABEL: Record<ConcurrencyKind, string> = {
  query: "Queries",
  mutation: "Mutations",
  action: "Actions",
  nodeAction: "Actions (Node)",
  httpAction: "HTTP Actions",
};
const CONCURRENCY_COLOR: Record<ConcurrencyKind, string> = {
  query: "series-1",
  mutation: "series-2",
  action: "series-3",
  nodeAction: "series-4",
  httpAction: "series-5",
};

function Concurrency(props: {
  q: { data?: FunctionConcurrency; error: unknown };
  state: "running" | "queued";
  title: string;
  description: string;
}) {
  return (
    <ChartCard
      title={props.title}
      description={props.description}
      series={props.q.data?.map((k) => ({
        id: k.kind,
        label: CONCURRENCY_LABEL[k.kind],
        points: k[props.state],
        color: CONCURRENCY_COLOR[k.kind],
      }))}
      error={props.q.error}
      formatValue={formatCalls}
      empty="No function ran in the last hour."
    />
  );
}

/** Convex's Health shows the top 3 pairs (`SubscriptionInvalidations.tsx`). */
const INVALIDATIONS_K = 3;

function Invalidations() {
  const { source } = useQueryScope();
  const q = useMetric(
    ["invalidations", INVALIDATIONS_K],
    true,
    (w, signal) => source.subscriptionInvalidations!(w, INVALIDATIONS_K, { signal }),
    HEALTH_REFRESH_MS,
  );
  return (
    <ChartCard
      title="Subscription invalidations"
      description="Queries re-run per minute, by the mutation and table that caused it, top 3"
      series={q.data && invalidationSeries(q.data)}
      error={q.error}
      formatValue={formatCalls}
      empty="No subscription was invalidated in the last hour."
    />
  );
}

export type ConcurrencyIssue = { severity: "critical" | "warning"; message: string };

/**
 * What Convex's Concurrency section says about itself (`ConcurrencyStatus.tsx`): the scheduler behind by more than
 * a minute now, or behind earlier and recovered; a kind with functions queued now while some run (at its limit),
 * or queued earlier in the hour. The lag is in seconds here, in whole minutes there.
 */
export function concurrencyIssues(lag: Timeseries | undefined, concurrency: FunctionConcurrency | undefined) {
  const issues: ConcurrencyIssue[] = [];
  if (lag && lag.length > 0) {
    const minutes = (v: number | null) => Math.round((v ?? 0) / 60);
    const current = minutes(lag[lag.length - 1]!.value);
    if (current > 1) issues.push({ severity: "critical", message: `Scheduler is ${current} minutes behind` });
    else if (current === 0 && lag.some((b) => minutes(b.value) > 0))
      issues.push({ severity: "warning", message: "Scheduler was behind but has recovered" });
  }
  for (const k of concurrency ?? []) {
    const last = (t: Timeseries) => t[t.length - 1]?.value ?? 0;
    const name = CONCURRENCY_LABEL[k.kind];
    if (last(k.queued) > 0) {
      if (last(k.running) > 0) issues.push({ severity: "critical", message: `${name} currently at concurrency limit` });
    } else if (k.queued.some((b) => (b.value ?? 0) > 0))
      issues.push({ severity: "warning", message: `${name} hit concurrency limit` });
  }
  return issues;
}

function ConcurrencySection() {
  const { source } = useQueryScope();
  const lagAccess = useMetricsAccess("scheduledJobLag");
  const concurrencyAccess = useMetricsAccess("functionConcurrency");
  const invalidationsAccess = useMetricsAccess("subscriptionInvalidations");
  // the scheduler lag every minute, the concurrency every 8 s (`appMetrics.ts` `useSchedulerLag`,
  // `useFunctionConcurrency`)
  const lag = useMetric(["scheduler-lag"], lagAccess === "ok", (w, signal) => source.scheduledJobLag!(w, { signal }));
  const concurrency = useMetric(
    ["concurrency"],
    concurrencyAccess === "ok",
    (w, signal) => source.functionConcurrency!(w, { signal }),
    HEALTH_REFRESH_MS,
  );
  if (lagAccess !== "ok" && concurrencyAccess !== "ok" && invalidationsAccess !== "ok") return null;
  const issues = concurrencyIssues(lag.data, concurrency.data);
  return (
    <section aria-labelledby="concurrency-metrics" className="mt-8">
      <h2 id="concurrency-metrics" className="text-sm font-medium">
        Concurrency, last hour
      </h2>
      {issues.length > 0 && (
        <ul aria-label="Concurrency issues" className="mt-2 flex flex-col gap-1 text-sm">
          {issues.map((i) => (
            <li key={i.message} className={i.severity === "critical" ? "text-destructive" : "text-muted-foreground"}>
              {i.severity === "critical" ? "Critical: " : "Warning: "}
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {lagAccess === "ok" && <SchedulerLag q={lag} />}
        {concurrencyAccess === "ok" && (
          <>
            <Concurrency
              q={concurrency}
              state="running"
              title="Running functions"
              description="The most running at once per minute, system functions included"
            />
            <Concurrency
              q={concurrency}
              state="queued"
              title="Queued functions"
              description="The most waiting for a slot at once per minute"
            />
          </>
        )}
        {invalidationsAccess === "ok" && <Invalidations />}
      </div>
    </section>
  );
}

export function HealthMetrics() {
  const top = useMetricsAccess("topFunctions");
  if (top === undefined) return null;
  return (
    <>
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
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{NO_METRICS[top]}</p>
        )}
      </section>
      {top === "ok" && <ConcurrencySection />}
    </>
  );
}

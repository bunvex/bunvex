// The Overview (UI-01 §27): the dashboard's home, Convex's Health reshaped — how the deployment is doing right
// now and where to look next. A summary of the deployment, a few indicators with their last hour, what needs
// attention (each item links to the screen that explains it), recent activity, and — when there is nothing
// yet — how to get started. The detailed charts follow under Metrics; the engine's own counters (the commit
// clock and friends) sit in a collapsed Engine section at the end.
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CircleAlert, CircleCheck } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { useStatsHistory } from "../data/live.ts";
import {
  capabilitiesQuery,
  dashboardKeys,
  deploymentQuery,
  deploymentStateQuery,
  functionsQuery,
  tablesQuery,
} from "../data/queries.ts";
import { describeEvent } from "../history/describe.ts";
import { formatCalls, formatMs, formatPercent as formatPct, useMetric, useMetricsAccess } from "../metrics/metrics.ts";
import { DashLink } from "../router.tsx";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import {
  type Attention,
  attention,
  FAIL_WINDOW,
  latest,
  maxSeries,
  recentMax,
  sumSeries,
  values,
} from "./overview-data.ts";
import { formatBytes, formatCount, timeAgo } from "./stats.ts";

const SECTION_TITLE = "text-sm font-medium";

// below the fold: the charts and the engine's counters are fetched after the page (Health's first-load
// budget, UI-01 §14.1)
const HealthMetrics = lazy(() => import("../metrics/health.tsx").then((m) => ({ default: m.HealthMetrics })));
const Engine = lazy(() => import("./engine.tsx").then((m) => ({ default: m.Engine })));

export function Overview() {
  const scope = useQueryScope();
  const deployment = useQuery(deploymentQuery(scope));
  const tables = useQuery(tablesQuery(scope));
  const functions = useQuery(functionsQuery(scope));
  const empty = tables.data?.length === 0 || functions.data?.length === 0;
  return (
    <div className={SCREEN}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>Overview</h1>
          {deployment.data && (
            <span className="text-sm text-muted-foreground">
              {deployment.data.name} · {deployment.data.version}
            </span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-8 p-4 md:p-6">
            {empty && (
              <GettingStarted noTables={tables.data?.length === 0} noFunctions={functions.data?.length === 0} />
            )}
            <Summary />
            <Indicators />
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
              <NeedsAttention />
              <RecentActivity />
            </div>
            <section aria-labelledby="overview-metrics">
              <h2 id="overview-metrics" className={SECTION_TITLE}>
                Metrics
              </h2>
              <WhenVisible fallback={<p className="mt-2 text-sm text-muted-foreground">Loading the charts…</p>}>
                <HealthMetrics />
              </WhenVisible>
            </section>
            <EngineSection />
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the deployment

function Summary() {
  const scope = useQueryScope();
  const { source } = scope;
  const deployment = useQuery(deploymentQuery(scope));
  const topology = useTopology();
  const audit = useAudit();
  const lastDeploy = audit.data?.find((e) => e.action === "push_config");
  const d = deployment.data;
  return (
    <section aria-labelledby="overview-summary">
      <h2 id="overview-summary" className="sr-only">
        The deployment
      </h2>
      <dl className="grid grid-cols-1 gap-px border bg-border sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Deployment">
          {d ? (
            <>
              <span className="font-medium">{d.name}</span>
              <span className="text-muted-foreground">
                {" "}
                · {d.version} · {d.persistence}
              </span>
            </>
          ) : (
            "…"
          )}
        </Fact>
        <Fact label="Client URL">
          {d?.url ? <Url url={d.url} label="client URL" /> : <Muted>Not shown by this host</Muted>}
        </Fact>
        <Fact label="Last deploy">
          {typeof source.listAuditEvents !== "function" ? (
            <Muted>Not reported</Muted>
          ) : lastDeploy ? (
            <>
              <time
                dateTime={new Date(lastDeploy.time).toISOString()}
                title={new Date(lastDeploy.time).toLocaleString()}
              >
                {timeAgo(lastDeploy.time, Date.now())}
              </time>
              {lastDeploy.author && <span className="text-muted-foreground"> by {lastDeploy.author}</span>}
            </>
          ) : (
            <Muted>{audit.isPending ? "…" : "No deploy recorded"}</Muted>
          )}
        </Fact>
        <Fact label="Nodes">
          {topology.data ? (
            <DashLink link={{ to: "/topology" }} className="underline-offset-2 hover:underline">
              {topology.data.nodes.length === 1
                ? "1 node"
                : `${topology.data.nodes.length} nodes · ${topology.data.nodes.filter((n) => n.role === "follower").length} followers`}
            </DashLink>
          ) : (
            <Muted>{typeof source.getTopology === "function" ? "…" : "Not reported"}</Muted>
          )}
        </Fact>
        {d?.httpActionsUrl && (
          <Fact label="HTTP actions URL" wide>
            <Url url={d.httpActionsUrl} label="HTTP actions URL" />
          </Fact>
        )}
      </dl>
    </section>
  );
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-w-0 bg-background px-4 py-3", wide && "sm:col-span-2 xl:col-span-4")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm">{children}</dd>
    </div>
  );
}

function Url({ url, label }: { url: string; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="truncate font-mono text-xs">{url}</code>
      <CopyButton text={url} label={`Copy the ${label}`} iconOnly />
    </span>
  );
}

/** A value, or a dash when the window had none. */
const orDash = (v: number | null, format: (v: number) => string) => (v === null ? "—" : format(v));

const Muted = ({ children }: { children: ReactNode }) => <span className="text-muted-foreground">{children}</span>;

// ------------------------------------------------------------------ indicators

/** The busiest functions whose latency the indicator watches. */
const BUSIEST = 5;

function Indicators() {
  const scope = useQueryScope();
  const { source } = scope;
  const metrics = useMetricsAccess("topFunctions") === "ok";
  const latencyOk = useMetricsAccess("latencyPercentiles") === "ok";
  const calls = useMetric(["overview", "calls"], metrics, (w, signal) =>
    source.topFunctions!("invocations", w, 50, { signal }),
  );
  const failures = useFailures(metrics);
  const busiest = (calls.data ?? [])
    .filter((t) => !t.function.startsWith("_"))
    .slice(0, BUSIEST)
    .map((t) => t.function);
  const p95 = useMetric(["overview", "p95", ...busiest], latencyOk && busiest.length > 0, async (w, signal) =>
    maxSeries(
      await Promise.all(
        busiest.map((fn) => source.latencyPercentiles!(fn, [95], w, { signal }).then((r) => r[0]?.series ?? [])),
      ),
    ),
  );
  const tables = useQuery(tablesQuery(scope));
  const files = useQuery({
    // not the Files screen's query module: it would join the first load (UI-01 §14.1 budget)
    queryKey: [...dashboardKeys.all(scope.scope), "overview", "file-stats"],
    queryFn: ({ signal }) => source.fileStats!({}, { signal }),
    enabled: typeof source.fileStats === "function",
  });
  const topology = useTopology();
  const { history } = useStatsHistory();

  const callSeries = calls.data ? sumSeries(calls.data.map((t) => t.series)) : undefined;
  const failSeries = failures.data
    ? maxSeries(failures.data.filter((t) => !t.function.startsWith("_")).map((t) => t.series))
    : undefined;
  const documents = tables.data?.reduce((n, t) => n + (t.documentCount ?? 0), 0);
  const connections = topology.data?.nodes.reduce((n, node) => n + node.connections, 0);
  const subscriptions = history.at(-1)?.subscriptions;
  const noMetrics = "No metrics from this deployment";
  const hasFiles = typeof source.fileStats === "function";
  const p95Now = p95.data ? latest(p95.data) : null;

  return (
    <section aria-labelledby="overview-indicators">
      <h2 id="overview-indicators" className={SECTION_TITLE}>
        Now
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Indicator
          label="Calls per minute"
          value={callSeries ? orDash(latest(callSeries), formatCalls) : metrics ? "…" : "—"}
          detail={metrics ? "Every function, last minute" : noMetrics}
          trend={callSeries && values(callSeries)}
          format={formatCalls}
        />
        <Indicator
          label="Failure rate"
          value={failSeries ? orDash(recentMax(failSeries), formatPct) : metrics ? "…" : "—"}
          detail={metrics ? `The worst function, last ${FAIL_WINDOW} minutes` : noMetrics}
          trend={failSeries && values(failSeries)}
          format={formatPct}
        />
        <Indicator
          label="Latency p95"
          value={p95.data ? (p95Now === null ? "—" : formatMs(p95Now)) : latencyOk ? "…" : "—"}
          detail={latencyOk ? `The slowest of the ${BUSIEST} busiest functions` : noMetrics}
          trend={p95.data && values(p95.data)}
          format={formatMs}
        />
        <Indicator
          label={connections !== undefined ? "Live connections" : "Live subscriptions"}
          value={
            connections !== undefined
              ? formatCount(connections)
              : subscriptions !== undefined
                ? formatCount(subscriptions)
                : "…"
          }
          detail={connections !== undefined ? "WebSockets open on every node" : "Open now, across every client"}
          trend={connections === undefined ? history.map((s) => s.subscriptions) : undefined}
          format={formatCount}
        />
        <Indicator
          label="Documents"
          value={documents === undefined ? "…" : formatCount(documents)}
          detail={tables.data ? `In ${formatCount(tables.data.length)} tables` : ""}
        />
        <Indicator
          label="File storage"
          value={files.data ? formatBytes(files.data.totalBytes) : hasFiles ? "…" : "—"}
          detail={files.data ? `${formatCount(files.data.count)} files` : hasFiles ? "" : "Not reported"}
        />
      </dl>
    </section>
  );
}

function Indicator(props: {
  label: string;
  value: string;
  detail: string;
  trend?: number[];
  format?: (v: number) => string;
}) {
  return (
    <div className="flex min-w-0 flex-col bg-background px-4 py-3">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</dd>
      <dd className="mt-0.5 truncate text-xs text-muted-foreground">{props.detail}</dd>
      {props.trend && props.trend.length > 1 && (
        <dd className="mt-2">
          <Sparkline
            className="h-8"
            values={props.trend}
            summary={`${props.label} over the last hour: now ${props.value}.`}
            formatValue={props.format ?? String}
          />
        </dd>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ attention and activity

function NeedsAttention() {
  const scope = useQueryScope();
  const { source } = scope;
  const metrics = useMetricsAccess("topFunctions") === "ok";
  const lagOk = useMetricsAccess("scheduledJobLag") === "ok";
  const failures = useFailures(metrics);
  const lag = useMetric(["scheduler-lag"], lagOk, (w, signal) => source.scheduledJobLag!(w, { signal }));
  const topology = useTopology();
  const state = useQuery(deploymentStateQuery(scope));
  const items = attention({
    failures: failures.data,
    topology: topology.data,
    schedulerLag: lag.data,
    paused: state.data?.state === "paused",
  });
  return (
    <section aria-labelledby="overview-attention">
      <h2 id="overview-attention" className={SECTION_TITLE}>
        Needs attention
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          Nothing right now.
        </p>
      ) : (
        <ul aria-labelledby="overview-attention" className="mt-3 divide-y border">
          {items.map((a) => (
            <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-sm">
              {a.severity === "critical" ? (
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              )}
              <span className="sr-only">{a.severity === "critical" ? "Critical: " : "Warning: "}</span>
              <AttentionLink a={a} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionLink({ a }: { a: Attention }) {
  const cls = "underline-offset-2 hover:underline";
  switch (a.to) {
    case "functions":
      return (
        <DashLink
          link={{ to: "/functions", search: { function: a.search?.function, tab: "statistics" } }}
          className={cls}
        >
          {a.text}
        </DashLink>
      );
    case "topology":
      return (
        <DashLink link={{ to: "/topology", search: { node: a.search?.node } }} className={cls}>
          {a.text}
        </DashLink>
      );
    case "scheduled":
      return (
        <DashLink link={{ to: "/schedules/functions" }} className={cls}>
          {a.text}
        </DashLink>
      );
    case "settings":
      return (
        <DashLink link={{ to: "/settings/general" }} className={cls}>
          {a.text}
        </DashLink>
      );
  }
}

const RECENT = 8;

function RecentActivity() {
  const scope = useQueryScope();
  const { source } = scope;
  const audit = useAudit();
  const failures = useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "overview", "failures"],
    queryFn: ({ signal }) => source.listLogs({ numItems: 200, cursor: null }, { signal }),
    select: (p) => p.page.filter((l) => l.execution?.status === "failure").slice(0, 3),
    refetchInterval: 30_000,
  });
  // the audit events and the failed executions, newest first
  const activity = [
    ...(audit.data ?? []).map((e) => ({ kind: "event" as const, time: e.time, e })),
    ...(failures.data ?? []).map((l) => ({ kind: "failure" as const, time: l.time, l })),
  ]
    .sort((x, y) => y.time - x.time)
    .slice(0, RECENT);
  return (
    <section aria-labelledby="overview-activity">
      <h2 id="overview-activity" className={SECTION_TITLE}>
        Recent activity
      </h2>
      <ul aria-labelledby="overview-activity" className="mt-3 divide-y border text-sm">
        {activity.map((item) =>
          item.kind === "event" ? (
            <li key={`e-${item.e.id}`} className="flex items-baseline gap-3 px-3 py-2">
              <When time={item.time} />
              <DashLink
                link={{ to: "/history", search: { event: item.e.id } }}
                className="min-w-0 truncate underline-offset-2 hover:underline"
              >
                {describeEvent(item.e)}
              </DashLink>
            </li>
          ) : (
            <li key={`f-${item.l.id}`} className="flex items-baseline gap-3 px-3 py-2">
              <When time={item.time} />
              <DashLink
                link={{ to: "/logs", search: { type: "failure" } }}
                className="min-w-0 truncate underline-offset-2 hover:underline"
              >
                <span className="font-medium text-destructive">Failed</span> {item.l.function?.path ?? "a function"}:{" "}
                {item.l.message}
              </DashLink>
            </li>
          ),
        )}
        {activity.length === 0 && (
          <li className="px-3 py-2 text-muted-foreground">{audit.isPending ? "Loading…" : "Nothing recorded yet."}</li>
        )}
      </ul>
    </section>
  );
}

function When({ time }: { time: number }) {
  return (
    <time
      dateTime={new Date(time).toISOString()}
      title={new Date(time).toLocaleString()}
      className="w-28 shrink-0 text-xs text-muted-foreground tabular-nums"
    >
      {timeAgo(time, Date.now())}
    </time>
  );
}

// ------------------------------------------------------------------ getting started and the engine

function GettingStarted({ noTables, noFunctions }: { noTables: boolean; noFunctions: boolean }) {
  const scope = useQueryScope();
  const deployment = useQuery(deploymentQuery(scope));
  const url = deployment.data?.url ?? "http://127.0.0.1:3210";
  const snippet = `import { BunvexClient } from "@bunvex/client";\n\nconst client = new BunvexClient("${url}");`;
  return (
    <section aria-labelledby="overview-start" className="border p-4 md:p-6">
      <h2 id="overview-start" className="text-base font-semibold">
        Get started
      </h2>
      <ol className="mt-3 flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li className={cn(!noFunctions && "text-muted-foreground")}>
          {noFunctions ? (
            <>
              Deploy your functions: <code className="font-mono text-xs">bunx bunvex dev</code>
            </>
          ) : (
            "Functions deployed."
          )}
        </li>
        <li className={cn(!noTables && "text-muted-foreground")}>
          {noTables ? (
            <>
              Create a table in{" "}
              <DashLink link={{ to: "/database" }} className="underline underline-offset-2">
                Database
              </DashLink>
              , or insert a document from a mutation.
            </>
          ) : (
            "Tables created."
          )}
        </li>
        <li>
          Connect a client:
          <div className="mt-2 flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto border bg-muted/40 p-3 font-mono text-xs">{snippet}</pre>
            <CopyButton text={snippet} label="Copy the client snippet" iconOnly />
          </div>
        </li>
      </ol>
    </section>
  );
}

function EngineSection() {
  // the counters stream only while the section is open
  const [open, setOpen] = useState(false);
  return (
    <details className="border" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Engine <span className="font-normal text-muted-foreground">— the commit clock, cache and subscriptions</span>
      </summary>
      {open && (
        <div className="border-t p-4 md:p-6">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
            <Engine />
          </Suspense>
        </div>
      )}
    </details>
  );
}

/** Mounts its children (a lazy chunk) once they come near the viewport: the charts sit below the fold. */
function WhenVisible({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), {
      rootMargin: "200px",
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return <div ref={ref}>{seen ? <Suspense fallback={fallback}>{children}</Suspense> : fallback}</div>;
}

// ------------------------------------------------------------------ shared queries

function useTopology() {
  const scope = useQueryScope();
  const { source } = scope;
  const caps = useQuery(capabilitiesQuery(scope));
  const canView = caps.data?.operations.includes("viewMetrics") ?? false;
  return useQuery({
    // the Topology screen's key: they share the picture
    queryKey: [...dashboardKeys.all(scope.scope), "topology"] as const,
    queryFn: ({ signal }) => source.getTopology!({ signal }),
    enabled: typeof source.getTopology === "function" && canView,
    refetchInterval: 10_000,
  });
}

function useAudit() {
  const scope = useQueryScope();
  const { source } = scope;
  return useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "overview", "audit"],
    queryFn: ({ signal }) => source.listAuditEvents!({ numItems: 20, cursor: null }, { signal }).then((p) => p.page),
    enabled: typeof source.listAuditEvents === "function",
    refetchInterval: 30_000,
  });
}

function useFailures(enabled: boolean) {
  const { source } = useQueryScope();
  return useMetric(["overview", "failures-top"], enabled, (w, signal) =>
    source.topFunctions!("failurePercentage", w, 5, { signal }),
  );
}

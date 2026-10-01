// The Topology screen (UI-01 §22, STUDY-12 §15) — a bunvex addition: who is running and how it connects, in
// lanes by role, left to right: the clients, the followers they connect to, the leader that feeds them the
// commit stream, and the store the leader holds the lease on (STUDY-24). Every link is also said in words on
// the cards. A deployment of one node (bunvex today) shows that node and its store. Live from watchTopology.
import { cn } from "@bunvex/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Database, Network, Star, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import { type Topology, type TopologyNode, type TopologyStore, toDataSourceError } from "../data-source.ts";
import { type TopologySearch, topologyRoute } from "../router.tsx";
import { formatBytes, formatCount, formatPercent } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { NodePanel } from "./node-panel.tsx";
import { LagGauge, StateLabel } from "./parts.tsx";
import { DRIVER, eventText, lagText, servesClients, summary, uptime } from "./words.ts";

export function TopologyScreen() {
  const scope = useQueryScope();
  const { source } = scope;
  const queryClient = useQueryClient();
  const caps = useQuery(capabilitiesQuery(scope));
  const canView = caps.data?.operations.includes("viewMetrics") ?? false;
  const offered = typeof source.getTopology === "function";
  const key = [...dashboardKeys.all(scope.scope), "topology"] as const;
  const topology = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => source.getTopology!({ signal }),
    enabled: offered && canView,
  });
  const liveError = useWatch<Topology>(
    (onValue, onError) => (offered && canView && source.watchTopology?.(onValue, onError)) || (() => {}),
    (t) => queryClient.setQueryData(key, t),
    [source, scope.scope, offered, canView],
  );
  const search = topologyRoute.useSearch();
  const navigate = topologyRoute.useNavigate();
  const open = (node: string | undefined) =>
    navigate({ search: (s: TopologySearch): TopologySearch => ({ ...s, node }), replace: true });

  if (!offered) return <NotOffered title="Topology" what="its topology" />;
  const t = topology.data;
  const opened = t?.nodes.find((n) => n.id === search.node);

  return (
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:p-6">
        <h1 className="text-xl font-semibold tracking-tight">Topology</h1>
        {caps.data && !canView ? (
          <p className="text-sm text-muted-foreground">This credential cannot view the deployment's topology.</p>
        ) : topology.error ? (
          <ErrorState error={toDataSourceError(topology.error)} onRetry={() => void topology.refetch()} />
        ) : !t ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="text-sm" data-testid="topology-summary">
              {summary(t)}
            </p>
            {liveError && <ErrorState error={liveError} />}
            <Lanes t={t} onOpen={open} opened={search.node} />
            <Events t={t} />
          </>
        )}
      </div>
      {t && opened && <NodePanel node={opened} topology={t} onClose={() => open(undefined)} />}
    </div>
  );
}

// ------------------------------------------------------------------ lanes

function Lanes({ t, onOpen, opened }: { t: Topology; onOpen: (id: string) => void; opened?: string }) {
  const leader = t.nodes.find((n) => n.role === "leader");
  const followers = t.nodes.filter((n) => n.role === "follower");
  const serving = t.nodes.filter((n) => servesClients(n, t));
  const single = followers.length === 0;
  return (
    <div
      className={cn(
        "grid gap-4 lg:items-start",
        single
          ? "lg:grid-cols-[minmax(10rem,0.7fr)_minmax(16rem,1.2fr)_minmax(14rem,1fr)]"
          : "lg:grid-cols-[minmax(10rem,0.7fr)_minmax(16rem,1.2fr)_minmax(16rem,1.1fr)_minmax(14rem,1fr)]",
      )}
    >
      <Lane title="Clients" icon={<Users />} toward="right">
        {serving.map((n) => (
          <li key={n.id} className="border bg-card px-3 py-2">
            <p className="font-mono text-lg tabular-nums">{formatCount(n.connections)}</p>
            <p className="text-xs text-muted-foreground">
              connections to <span className="font-mono">{n.id}</span>
            </p>
          </li>
        ))}
      </Lane>
      {!single && (
        <Lane title="Followers" icon={<Network />} toward="left" note="They serve queries and subscriptions.">
          {followers.map((n) => (
            <li key={n.id}>
              <NodeCard node={n} t={t} onOpen={onOpen} opened={opened === n.id} />
            </li>
          ))}
        </Lane>
      )}
      <Lane
        title={single ? "Node" : "Leader"}
        icon={<Star />}
        toward="right"
        note={single ? "Followers appear here when bunvex runs more than one node." : undefined}
      >
        {leader && (
          <li>
            <NodeCard node={leader} t={t} onOpen={onOpen} opened={opened === leader.id} />
          </li>
        )}
      </Lane>
      <Lane title="Store" icon={<Database />}>
        <li>
          <StoreCard store={t.store} now={t.time} />
        </li>
      </Lane>
    </div>
  );
}

function Lane(props: {
  title: string;
  icon: ReactNode;
  /** Where this lane's links point, drawn beside the heading (the cards say it in words). */
  toward?: "left" | "right";
  note?: string;
  children: ReactNode;
}) {
  const id = `lane-${props.title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <span aria-hidden="true" className="[&>svg]:size-4">
          {props.icon}
        </span>
        {props.title}
        {props.toward && (
          <span aria-hidden="true" className="ml-auto hidden text-muted-foreground/70 lg:inline [&>svg]:size-4">
            {props.toward === "right" ? <ArrowRight /> : <ArrowLeft />}
          </span>
        )}
      </h2>
      <ul className="flex flex-col gap-2">{props.children}</ul>
      {props.note && <p className="mt-2 text-xs text-muted-foreground">{props.note}</p>}
    </section>
  );
}

function NodeCard(props: { node: TopologyNode; t: Topology; onOpen: (id: string) => void; opened: boolean }) {
  const { node: n, t } = props;
  const followers = t.nodes.length - 1;
  return (
    <button
      type="button"
      onClick={() => props.onOpen(n.id)}
      aria-pressed={props.opened}
      className={cn(
        "flex w-full flex-col gap-2 border bg-card p-3 text-left outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring",
        props.opened && "border-ring",
        n.state === "down" && "opacity-70",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono font-medium">{n.id}</span>
        <StateLabel state={n.state} />
      </span>
      {n.lag && (
        <span className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>
            <span className="sr-only">Commit stream from the leader: </span>
            {lagText(n.lag)}
          </span>
          <LagGauge ms={n.lag.ms} state={n.state} />
        </span>
      )}
      {n.role === "leader" && (
        <span className="text-xs text-muted-foreground">
          {n.commitsPerSecond !== undefined && `${formatCount(n.commitsPerSecond)} commits/s`}
          {followers > 0 && ` · streams to ${followers === 1 ? "1 follower" : `${followers} followers`}`}
        </span>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        <Vital label="CPU">{n.cpu === null ? "—" : formatPercent(n.cpu)}</Vital>
        <Vital label="Memory">{n.memoryBytes === null ? "—" : formatBytes(n.memoryBytes)}</Vital>
        {servesClients(n, t) && <Vital label="Subscriptions">{formatCount(n.subscriptions)}</Vital>}
        <Vital label="Cache hits">{n.cacheHitRate === null ? "—" : formatPercent(n.cacheHitRate)}</Vital>
        <Vital label="Uptime">{uptime(n.startedAt, t.time)}</Vital>
        <Vital label="Actions">{formatCount(n.actionsRunning)}</Vital>
      </dl>
      {n.scheduler && <span className="text-xs text-muted-foreground">Runs the scheduler</span>}
    </button>
  );
}

function Vital({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono tabular-nums">{children}</dd>
    </div>
  );
}

function StoreCard({ store: s, now }: { store: TopologyStore; now: number }) {
  return (
    <div className="flex flex-col gap-2 border bg-card p-3">
      <p className="font-medium">{DRIVER[s.driver]}</p>
      <p className="text-xs text-muted-foreground">
        {s.singleNode ? (
          "One node: a file lock keeps a second one out."
        ) : s.leaseHolder ? (
          <>
            Lease held by <span className="font-mono">{s.leaseHolder}</span>
            {s.leaseExpiresAt !== null &&
              `, renews within ${Math.max(0, Math.ceil((s.leaseExpiresAt - now) / 1000))} s`}
            {s.leaseTtlMs !== null && ` (TTL ${Math.round(s.leaseTtlMs / 1000)} s)`}
          </>
        ) : (
          "No node holds the lease."
        )}
      </p>
      <dl className="grid grid-cols-1 gap-y-0.5 text-xs">
        <Vital label="Latency">{s.latencyMs === null ? "—" : `${formatCount(s.latencyMs)} ms`}</Vital>
        <Vital label="Size">{s.sizeBytes === null ? "—" : formatBytes(s.sizeBytes)}</Vital>
        <Vital label="Connections">
          {s.connections === null
            ? "—"
            : `${formatCount(s.connections.used)}${s.connections.max === null ? "" : ` / ${formatCount(s.connections.max)}`}`}
        </Vital>
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ events

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function Events({ t }: { t: Topology }) {
  return (
    <section aria-labelledby="topology-events" className="max-w-3xl">
      <h2 id="topology-events" className="mb-2 text-sm font-medium text-muted-foreground">
        Events
      </h2>
      {t.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has changed in the topology yet.</p>
      ) : (
        <ol className="divide-y border">
          {t.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-4 gap-y-0.5 px-3 py-1.5 text-sm">
              <time
                dateTime={new Date(e.time).toISOString()}
                className="font-mono text-xs text-muted-foreground tabular-nums"
              >
                {time.format(e.time)}
              </time>
              <span>{eventText(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

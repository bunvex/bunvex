// A node's details beside the Topology screen (UI-01 §22), in two tabs. Overview: its role, state, lag and vitals
// with CPU and lag (or connections) sparklines. Cache: the node's own query cache — each node keeps an
// in-process LRU, as each Convex process does, invalidated by the commit stream (STUDY-24 §4.5) — its hit rate
// and invalidations over the last minute, entries and bytes against the limits, evictions, and the functions
// with the most cached entries.
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import type { ReactNode } from "react";
import type { NodeCache, Topology, TopologyNode } from "../data-source.ts";
import { formatBytes, formatCount, formatPercent } from "../screens/stats.ts";
import { Panel } from "../shell/panel.tsx";
import { LagGauge, StateLabel } from "./parts.tsx";
import { lagText, servesClients, uptime } from "./words.ts";

const peak = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
const last = (xs: number[]) => xs.at(-1) ?? 0;

export function NodePanel({
  node: n,
  topology: t,
  onClose,
}: {
  node: TopologyNode;
  topology: Topology;
  onClose: () => void;
}) {
  const span = n.history.length > 1 ? Math.round((n.history.at(-1)!.time - n.history[0]!.time) / 1000) : 0;
  return (
    <Panel kind="topology-node" title={<span className="font-mono">{n.id}</span>} onClose={onClose}>
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="cache" disabled={!n.cache}>
            Cache
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-3">
          <Overview n={n} t={t} span={span} />
        </TabsContent>
        <TabsContent value="cache" className="pt-3">
          {n.cache && <CacheDetails n={n} cache={n.cache} span={span} />}
        </TabsContent>
      </Tabs>
    </Panel>
  );
}

function Overview({ n, t, span }: { n: TopologyNode; t: Topology; span: number }) {
  const cpu = n.history.map((h) => Math.round((h.cpu ?? 0) * 100));
  const lag = n.history.map((h) => h.lagMs ?? 0);
  const conns = n.history.map((h) => h.connections);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{n.role === "leader" ? "Leader" : "Follower"}</span>
        <StateLabel state={n.state} />
        <span className="text-muted-foreground">version {n.version}</span>
      </p>
      {n.lag && (
        <div className="flex flex-col gap-1">
          <p>{lagText(n.lag)}</p>
          <LagGauge ms={n.lag.ms} state={n.state} />
        </div>
      )}
      <Facts>
        <Fact label="CPU">{n.cpu === null ? "—" : formatPercent(n.cpu)}</Fact>
        <Fact label="Memory">
          {n.memoryBytes === null ? "—" : formatBytes(n.memoryBytes)}
          {n.memoryLimitBytes !== null && ` of ${formatBytes(n.memoryLimitBytes)}`}
        </Fact>
        <Fact label="Uptime">{uptime(n.startedAt, t.time)}</Fact>
        {servesClients(n, t) && (
          <>
            <Fact label="Connections">{formatCount(n.connections)}</Fact>
            <Fact label="Subscriptions">{formatCount(n.subscriptions)}</Fact>
          </>
        )}
        {n.commitsPerSecond !== undefined && <Fact label="Commits">{formatCount(n.commitsPerSecond)}/s</Fact>}
        <Fact label="Scheduler">{n.scheduler ? "Runs here" : "On the leader"}</Fact>
        <Fact label="Actions running">{formatCount(n.actionsRunning)}</Fact>
      </Facts>
      {n.history.length > 1 && (
        <section aria-label="Recent history" className="flex flex-col gap-3">
          <Trend title={`CPU, last ${span} s`}>
            <Sparkline
              values={cpu}
              formatValue={(v) => `${v}%`}
              summary={`CPU over the last ${span} seconds: now ${last(cpu)}%, peak ${peak(cpu)}%.`}
            />
          </Trend>
          {n.lag ? (
            <Trend title={`Lag, last ${span} s`}>
              <Sparkline
                values={lag}
                formatValue={(v) => `${formatCount(v)} ms`}
                summary={`Lag over the last ${span} seconds: now ${formatCount(last(lag))} ms, peak ${formatCount(peak(lag))} ms.`}
              />
            </Trend>
          ) : (
            servesClients(n, t) && (
              <Trend title={`Connections, last ${span} s`}>
                <Sparkline
                  values={conns}
                  formatValue={formatCount}
                  summary={`Connections over the last ${span} seconds: now ${formatCount(last(conns))}, peak ${formatCount(peak(conns))}.`}
                />
              </Trend>
            )
          )}
        </section>
      )}
    </div>
  );
}

function CacheDetails({ n, cache: c, span }: { n: TopologyNode; cache: NodeCache; span: number }) {
  const hits = n.history.map((h) => Math.round((h.cacheHitRate ?? 0) * 100));
  const invalidations = n.history.map((h) => h.invalidationsPerSecond ?? 0);
  const top = c.topQueries ?? [];
  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="cache-details">
      <p className="text-muted-foreground">
        This node's own query cache: results kept in its memory, dropped when a commit touches what they read.
      </p>
      <Facts>
        <Fact label="Hit rate">{c.hitRate === null ? "—" : formatPercent(c.hitRate)}</Fact>
        <Fact label="Entries">
          {formatCount(c.entries)} of {formatCount(c.maxEntries)}
        </Fact>
        {c.bytes !== undefined && (
          <Fact label="Size">
            {formatBytes(c.bytes)}
            {c.maxBytes !== undefined && ` of ${formatBytes(c.maxBytes)}`}
          </Fact>
        )}
        <Fact label="Invalidations">{formatCount(c.invalidationsPerSecond)}/s</Fact>
        <Fact label="Evictions">{formatCount(c.evictions)}</Fact>
      </Facts>
      <div className="flex flex-col gap-1">
        <span aria-hidden="true" className="block h-1 w-full bg-muted">
          <span
            className="block h-full bg-info"
            style={{ width: `${Math.round((c.entries / c.maxEntries) * 100)}%` }}
          />
        </span>
        <p className="text-xs text-muted-foreground">
          {formatPercent(c.entries / c.maxEntries)} of the LRU's capacity in use
        </p>
      </div>
      {n.history.length > 1 && (
        <section aria-label="Recent cache history" className="flex flex-col gap-3">
          <Trend title={`Hit rate, last ${span} s`}>
            <Sparkline
              values={hits}
              formatValue={(v) => `${v}%`}
              summary={`Cache hit rate over the last ${span} seconds: now ${last(hits)}%, peak ${peak(hits)}%.`}
            />
          </Trend>
          <Trend title={`Invalidations per second, last ${span} s`}>
            <Sparkline
              values={invalidations}
              formatValue={(v) => `${formatCount(v)}/s`}
              summary={`Invalidations over the last ${span} seconds: now ${formatCount(last(invalidations))} per second, peak ${formatCount(peak(invalidations))}.`}
            />
          </Trend>
        </section>
      )}
      {top.length > 0 && (
        <section aria-labelledby="cache-top" className="flex flex-col gap-1">
          <h3 id="cache-top" className="text-xs text-muted-foreground">
            Most cached queries
          </h3>
          <ol className="divide-y border">
            {top.map((q) => (
              <li key={q.function} className="flex items-center justify-between gap-3 px-2 py-1">
                <span className="truncate font-mono text-xs">{q.function}</span>
                <span className="font-mono text-xs tabular-nums">{formatCount(q.entries)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">{children}</dl>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{children}</dd>
    </>
  );
}

function Trend({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{title}</p>
      <div className="h-12">{children}</div>
    </div>
  );
}

// A node's details beside the Topology screen (UI-01 §22): everything the card shows and more, with its
// recent CPU and — for a follower — lag, or connections, as sparklines (the last minute or so).
import { Sparkline } from "@bunvex/ui/components/sparkline";
import type { ReactNode } from "react";
import type { Topology, TopologyNode } from "../data-source.ts";
import { formatBytes, formatCount, formatPercent } from "../screens/stats.ts";
import { Panel } from "../shell/panel.tsx";
import { LagGauge, StateLabel } from "./parts.tsx";
import { lagText, servesClients, uptime } from "./words.ts";

export function NodePanel({
  node: n,
  topology: t,
  onClose,
}: {
  node: TopologyNode;
  topology: Topology;
  onClose: () => void;
}) {
  const cpu = n.history.map((h) => Math.round((h.cpu ?? 0) * 100));
  const lag = n.history.map((h) => h.lagMs ?? 0);
  const conns = n.history.map((h) => h.connections);
  const peak = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const now = (xs: number[]) => xs.at(-1) ?? 0;
  const span = n.history.length > 1 ? Math.round((n.history.at(-1)!.time - n.history[0]!.time) / 1000) : 0;
  return (
    <Panel title={<span className="font-mono">{n.id}</span>} onClose={onClose}>
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">CPU</dt>
          <dd className="font-mono tabular-nums">{n.cpu === null ? "—" : formatPercent(n.cpu)}</dd>
          <dt className="text-muted-foreground">Memory</dt>
          <dd className="font-mono tabular-nums">
            {n.memoryBytes === null ? "—" : formatBytes(n.memoryBytes)}
            {n.memoryLimitBytes !== null && ` of ${formatBytes(n.memoryLimitBytes)}`}
          </dd>
          <dt className="text-muted-foreground">Uptime</dt>
          <dd className="font-mono tabular-nums">{uptime(n.startedAt, t.time)}</dd>
          {servesClients(n, t) && (
            <>
              <dt className="text-muted-foreground">Connections</dt>
              <dd className="font-mono tabular-nums">{formatCount(n.connections)}</dd>
              <dt className="text-muted-foreground">Subscriptions</dt>
              <dd className="font-mono tabular-nums">{formatCount(n.subscriptions)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Cache hits</dt>
          <dd className="font-mono tabular-nums">{n.cacheHitRate === null ? "—" : formatPercent(n.cacheHitRate)}</dd>
          {n.commitsPerSecond !== undefined && (
            <>
              <dt className="text-muted-foreground">Commits</dt>
              <dd className="font-mono tabular-nums">{formatCount(n.commitsPerSecond)}/s</dd>
            </>
          )}
          <dt className="text-muted-foreground">Scheduler</dt>
          <dd>{n.scheduler ? "Runs here" : "On the leader"}</dd>
          <dt className="text-muted-foreground">Actions running</dt>
          <dd className="font-mono tabular-nums">{formatCount(n.actionsRunning)}</dd>
        </dl>
        {n.history.length > 1 && (
          <section aria-label="Recent history" className="flex flex-col gap-3">
            <Trend title={`CPU, last ${span} s`}>
              <Sparkline
                values={cpu}
                formatValue={(v) => `${v}%`}
                summary={`CPU over the last ${span} seconds: now ${now(cpu)}%, peak ${peak(cpu)}%.`}
              />
            </Trend>
            {n.lag ? (
              <Trend title={`Lag, last ${span} s`}>
                <Sparkline
                  values={lag}
                  formatValue={(v) => `${formatCount(v)} ms`}
                  summary={`Lag over the last ${span} seconds: now ${formatCount(now(lag))} ms, peak ${formatCount(peak(lag))} ms.`}
                />
              </Trend>
            ) : (
              servesClients(n, t) && (
                <Trend title={`Connections, last ${span} s`}>
                  <Sparkline
                    values={conns}
                    formatValue={formatCount}
                    summary={`Connections over the last ${span} seconds: now ${formatCount(now(conns))}, peak ${formatCount(peak(conns))}.`}
                  />
                </Trend>
              )
            )}
          </section>
        )}
      </div>
    </Panel>
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

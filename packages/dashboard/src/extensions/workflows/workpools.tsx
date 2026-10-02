// Workflows → Work pools (UI-01 §26.3): each pool's parallelism in use against its limit, what waits, what backs
// off before a retry, its last 24 hours, its retry policy in words, and its throughput per minute (a line chart
// with completed and failed, a legend, and the numbers in text).
import { LineChart } from "@bunvex/ui/components/line-chart";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useQueryScope } from "../../context.tsx";
import { toDataSourceError } from "../../data-source.ts";
import { formatCount } from "../../screens/stats.ts";
import { BAR1 } from "../../shell/bars.ts";
import { ErrorState } from "../../shell/error-state.tsx";
import type { Workpool } from "./data-source.ts";
import { poolsQuery } from "./queries.ts";
import { duration } from "./words.ts";

export const retryWords = (p: Workpool) =>
  `${p.retryByDefault ? "Actions retry by default" : "Actions retry when asked"}: up to ${p.retry.maxAttempts} tries, waiting ${duration(p.retry.initialBackoffMs)} then ×${p.retry.base} each time`;

function Pool({ p }: { p: Workpool }) {
  const used = p.running / p.maxParallelism;
  return (
    <section aria-label={`Pool ${p.name}`} className="flex min-w-0 flex-col gap-3 border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="font-mono text-sm font-medium">{p.name}</h2>
        <span className="text-xs text-muted-foreground">parallelism {p.maxParallelism}</span>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">
          Running <span className="font-medium text-foreground tabular-nums">{p.running}</span> of {p.maxParallelism}
          {used >= 1 ? " — full" : ""}
        </p>
        <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-sm bg-muted">
          <div
            className={used >= 1 ? "h-full bg-warning" : "h-full bg-foreground/60"}
            style={{ width: `${used * 100}%` }}
          />
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs sm:grid-cols-6">
        {(
          [
            ["Pending", p.pending],
            ["Backing off", p.backingOff],
            ["Succeeded", p.succeeded],
            ["Failed", p.failed],
            ["Canceled", p.canceled],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="font-mono tabular-nums">{formatCount(v)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{retryWords(p)}. Last 24 hours for the counts.</p>
      <LineChart
        label={`Pool ${p.name}: completed and failed per minute, last 30 minutes`}
        height={140}
        directLabels
        series={[
          {
            id: "completed",
            label: "Completed",
            color: "series-1",
            points: p.throughput.map((t) => ({ time: t.time, value: t.completed })),
          },
          {
            id: "failed",
            label: "Failed",
            color: "series-2",
            points: p.throughput.map((t) => ({ time: t.time, value: t.failed })),
          },
        ]}
      />
    </section>
  );
}

export function WorkpoolsPage({ heading }: { heading: ReactNode }) {
  const scope = useQueryScope();
  const pools = useQuery(poolsQuery(scope));
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        {heading}
        {pools.data && <span className="text-sm text-muted-foreground tabular-nums">{pools.data.length} pools</span>}
      </div>
      {pools.error ? (
        <ErrorState error={toDataSourceError(pools.error)} />
      ) : (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 xl:grid-cols-2">
          {pools.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {pools.data?.length === 0 && <p className="text-sm text-muted-foreground">No work pool yet.</p>}
          {pools.data?.map((p) => (
            <Pool key={p.name} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}

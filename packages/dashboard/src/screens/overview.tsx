// The overview: is the deployment alive and healthy right now? Its centre is the commit clock — the
// timestamp every write advances — with the commit rate over the last minute beside it; the counters that
// explain it (cache, subscriptions, conflicts) sit below. Everything is live, from watchStats; the history
// lives in the query cache, so leaving the overview and coming back keeps the last minute.
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { cn } from "@bunvex/ui/lib/utils";
import type { ReactNode } from "react";
import { useStatsHistory } from "../data/live.ts";
import type { DeploymentStats } from "../data-source.ts";
import { HealthMetrics } from "../metrics/health.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { cacheHitRate, commitRates, formatCount, formatPercent, formatRate, ratePerSecond } from "./stats.ts";

export function Overview() {
  const { history, error } = useStatsHistory();
  const latest = history.at(-1);
  const prev = history.at(-2);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Health</h1>
      {error && (
        <div className="mt-4">
          <ErrorState error={error} />
        </div>
      )}
      {latest ? (
        <>
          <CommitPulse history={history} />
          <Counters latest={latest} prev={prev} />
        </>
      ) : (
        !error && <Loading />
      )}
      <HealthMetrics />
    </>
  );
}

function CommitPulse({ history }: { history: DeploymentStats[] }) {
  const latest = history.at(-1)!;
  const rates = commitRates(history);
  const now = rates.at(-1);
  const peak = rates.length ? Math.max(...rates) : undefined;
  const span = Math.round((latest.at - history[0]!.at) / 1000);
  const summary =
    now === undefined
      ? "Commits per second: waiting for a second sample."
      : `Commits per second over the last ${span} seconds: now ${formatRate(now)}, peak ${formatRate(peak!)}.`;
  return (
    <section aria-labelledby="commit-clock" className="mt-6 border p-4 md:p-6">
      {/* one row: the clock, its rates, and their trend as a compact line (UX-18: no near-empty card) */}
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <h2 id="commit-clock" className="text-sm text-muted-foreground">
            Commit timestamp
          </h2>
          <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums md:text-5xl">
            {formatCount(latest.commitTs)}
          </p>
        </div>
        <dl className="flex gap-8 text-sm">
          <div>
            <dt className="text-muted-foreground">Commits per second</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{now === undefined ? "…" : formatRate(now)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Peak{span > 0 ? `, last ${span} s` : ""}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{peak === undefined ? "…" : formatRate(peak)}</dd>
          </div>
        </dl>
        <div className="min-w-48 flex-1">
          <p className="text-xs text-muted-foreground">Commits per second{span > 0 ? `, last ${span} s` : ""}</p>
          <Sparkline
            className="mt-1 h-12"
            values={rates}
            summary={summary}
            formatValue={(v) => `${formatRate(v)} commits/s`}
            pointLabel={(i) => `${Math.round((latest.at - history[i + 1]!.at) / 1000)} s ago`}
          />
        </div>
      </div>
    </section>
  );
}

function Counters({ latest, prev }: { latest: DeploymentStats; prev: DeploymentStats | undefined }) {
  const perSecond = (counter: Parameters<typeof ratePerSecond>[2]) =>
    prev ? `${formatRate(ratePerSecond(prev, latest, counter))}/s` : "…/s";
  const hitRate = cacheHitRate(latest);
  const newConflicts = prev ? latest.conflicts - prev.conflicts : 0;
  return (
    <section aria-labelledby="counters" className="mt-6">
      <h2 id="counters" className="sr-only">
        Counters since the server started
      </h2>
      <dl className="grid grid-cols-1 gap-px border bg-border sm:grid-cols-2 lg:grid-cols-3">
        <Counter
          label="Query cache hit rate"
          value={hitRate === null ? "—" : formatPercent(hitRate)}
          detail={`${formatCount(latest.cacheHits)} hits, ${formatCount(latest.cacheMisses)} misses`}
        />
        <Counter
          label="Live subscriptions"
          value={formatCount(latest.subscriptions)}
          detail="Open now, across every client"
        />
        <Counter
          label="Subscription reruns"
          value={formatCount(latest.subscriptionReruns)}
          detail={perSecond("subscriptionReruns")}
        />
        <Counter
          label="Commit groups"
          value={formatCount(latest.commitGroups)}
          detail={`${perSecond("commitGroups")}, each made durable with one write`}
        />
        <Counter
          label="Conflicts"
          value={formatCount(latest.conflicts)}
          detail={`${formatCount(latest.retries)} mutation retries`}
          status={newConflicts > 0 ? `${formatCount(newConflicts)} new since the last sample` : undefined}
        />
        <Counter
          label="Updates pushed"
          value={formatCount(latest.subscriptionUpdates)}
          detail={perSecond("subscriptionUpdates")}
        />
      </dl>
    </section>
  );
}

function Counter({
  label,
  value,
  detail,
  status,
}: {
  label: string;
  value: string;
  detail: ReactNode;
  status?: string;
}) {
  return (
    <div className="bg-background p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className={cn("mt-1 text-sm text-muted-foreground tabular-nums")}>{detail}</dd>
      {status && <dd className="mt-1 text-sm font-medium text-warning">{status}</dd>}
    </div>
  );
}

function Loading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the deployment's counters" className="mt-6 space-y-6">
      <Skeleton className="h-44 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    </div>
  );
}

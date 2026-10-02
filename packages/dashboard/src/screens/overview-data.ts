// What the Overview derives from the contract (UI-01 §27), kept pure so it is tested apart from the screen:
// totals over the top-k series, the latest minute that has data, and the "needs attention" list.
import type { Timeseries, TopKSeries, Topology } from "../data-source.ts";
import { formatCount } from "./stats.ts";

/** Per bucket, the sum of every series (a missing value counts as nothing; a bucket with none stays null). */
export function sumSeries(all: Timeseries[]): Timeseries {
  const first = all[0];
  if (!first) return [];
  return first.map((b, i) => {
    const values = all.map((s) => s[i]?.value).filter((v): v is number => v !== null && v !== undefined);
    return { time: b.time, value: values.length ? values.reduce((a, v) => a + v, 0) : null };
  });
}

/** Per bucket, the largest value across the series. */
export function maxSeries(all: Timeseries[]): Timeseries {
  const first = all[0];
  if (!first) return [];
  return first.map((b, i) => {
    const values = all.map((s) => s[i]?.value).filter((v): v is number => v !== null && v !== undefined);
    return { time: b.time, value: values.length ? Math.max(...values) : null };
  });
}

/** The most recent bucket with a value. */
export function latest(series: Timeseries): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i]!.value !== null) return series[i]!.value;
  return null;
}

/** The largest value over the last `n` buckets (the window "needs attention" uses), or null without any. */
export function recentMax(series: Timeseries, n = FAIL_WINDOW): number | null {
  const recent = values(series.slice(-n));
  return recent.length ? Math.max(...recent) : null;
}

/** The values, oldest first, without the empty buckets (what a sparkline draws). */
export const values = (series: Timeseries) => series.map((b) => b.value).filter((v): v is number => v !== null);

export type Attention = {
  id: string;
  severity: "critical" | "warning";
  text: string;
  /** Where to look: a screen and its search. */
  to: "functions" | "topology" | "scheduled" | "settings";
  search?: Record<string, string>;
};

export type AttentionInput = {
  /** failurePercentage top-k over the window (0–100). */
  failures?: TopKSeries;
  topology?: Topology;
  /** Scheduler lag in seconds per bucket. */
  schedulerLag?: Timeseries;
  paused?: boolean;
};

/** Failing functions: any failure in the last FAIL_WINDOW buckets. */
export const FAIL_WINDOW = 5;
/** Scheduled runs starting this many seconds late or more. */
export const LAG_LIMIT_S = 10;
/** The store's connections at this share of its limit or more. */
export const CONNECTIONS_LIMIT = 0.8;

/** What needs someone's attention now, most severe first; each says where to look. */
export function attention(input: AttentionInput): Attention[] {
  const out: Attention[] = [];
  if (input.paused)
    out.push({
      id: "paused",
      severity: "critical",
      text: "The deployment is paused: new function calls fail until it is resumed",
      to: "settings",
    });
  for (const n of input.topology?.nodes ?? []) {
    if (n.state === "down")
      out.push({
        id: `down-${n.id}`,
        severity: "critical",
        text: `${n.id} stopped reporting`,
        to: "topology",
        search: { node: n.id },
      });
    else if (n.state === "lagging")
      out.push({
        id: `lag-${n.id}`,
        severity: "warning",
        text: `${n.id} is behind the leader${n.lag ? ` by ${formatCount(Math.round(n.lag.ms))} ms` : ""}`,
        to: "topology",
        search: { node: n.id },
      });
  }
  const conns = input.topology?.store.connections;
  if (conns?.max && conns.used / conns.max >= CONNECTIONS_LIMIT)
    out.push({
      id: "store-connections",
      severity: "warning",
      text: `The store uses ${conns.used} of its ${conns.max} connections`,
      to: "topology",
    });
  for (const f of input.failures ?? []) {
    if (f.function.startsWith("_")) continue; // the rest, folded together
    const recent = f.series.slice(-FAIL_WINDOW).map((b) => b.value ?? 0);
    const worst = Math.max(0, ...recent);
    if (worst > 0)
      out.push({
        id: `fail-${f.function}`,
        severity: worst >= 50 ? "critical" : "warning",
        text: `${f.function} failed in ${Math.round(worst)}% of its calls in the last ${FAIL_WINDOW} minutes`,
        to: "functions",
        search: { function: f.function, tab: "statistics" },
      });
  }
  const lag = input.schedulerLag ? latest(input.schedulerLag) : null;
  if (lag !== null && lag >= LAG_LIMIT_S)
    out.push({
      id: "scheduler-lag",
      severity: "warning",
      text: `Scheduled runs start ${formatCount(Math.round(lag))} s late`,
      to: "scheduled",
    });
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

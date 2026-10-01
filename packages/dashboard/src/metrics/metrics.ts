// What every metrics chart shares (UI-01 §18): the window (the last hour in one-minute buckets, as Convex's
// Health and function graphs), refreshed every minute; whether the source and the credential allow
// metrics; a colour per function that follows the function, not its rank; and how values read.
import type { ChartSeries } from "@bunvex/ui/components/line-chart";
import { useQuery } from "@tanstack/react-query";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery, dashboardKeys } from "../data/queries.ts";
import { type DashboardDataSource, type MetricsWindow, REST, type TopKSeries } from "../data-source.ts";

export const HOUR = 3_600_000;
export const REFRESH_MS = 60_000;

/** The last hour, in minutes, ending at the current minute's end. */
export function lastHour(now = Date.now()): MetricsWindow {
  const end = Math.ceil(now / 60_000) * 60_000;
  return { start: end - HOUR, end, numBuckets: 60 };
}

/**
 * Whether a metric can be shown: "absent" when the source does not have `method`, "denied" when the
 * credential may not view metrics, `undefined` until the capabilities are known.
 */
export function useMetricsAccess(method: keyof DashboardDataSource): "ok" | "absent" | "denied" | undefined {
  const scope = useQueryScope();
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  if (typeof scope.source[method] !== "function") return "absent";
  if (!caps) return undefined;
  return caps.operations.includes("viewMetrics") ? "ok" : "denied";
}

export const NO_METRICS = {
  absent: "This deployment does not report metrics.",
  denied: "This credential may not view metrics.",
} as const;

/** A metrics query: refetched every minute over a fresh window, only when allowed. */
export function useMetric<T>(
  key: readonly unknown[],
  enabled: boolean,
  fetch: (w: MetricsWindow, signal: AbortSignal) => Promise<T>,
) {
  const scope = useQueryScope();
  return useQuery({
    queryKey: [...dashboardKeys.all(scope.scope), "metrics", ...key],
    queryFn: ({ signal }) => fetch(lastHour(), signal),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

const SLOTS = 5;
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Top functions as chart series. A function keeps its colour whatever its rank: its slot comes from its
 * name, moving to the next free one on a clash; the rest ("Other functions") is always grey.
 */
export function topSeries(top: TopKSeries): ChartSeries[] {
  const taken = new Set<number>();
  const named = top
    .filter((t) => t.function !== REST)
    .sort((a, b) => a.function.localeCompare(b.function))
    .map((t) => {
      let slot = hash(t.function) % SLOTS;
      for (let i = 0; i < SLOTS && taken.has(slot); i++) slot = (slot + 1) % SLOTS;
      taken.add(slot);
      return { t, color: `series-${slot + 1}` };
    });
  const colorOf = new Map(named.map((n) => [n.t.function, n.color]));
  return top.map((t) => ({
    id: t.function,
    label: t.function === REST ? "Other functions" : t.function,
    points: t.series,
    color: colorOf.get(t.function) ?? "series-other",
  }));
}

export const formatPercent = (v: number) => `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`;
export const formatCalls = (v: number) => v.toLocaleString();
export const formatMs = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : `${Math.round(v)} ms`;
export const formatSeconds = (v: number) => `${v.toFixed(v >= 10 ? 0 : 1)} s`;

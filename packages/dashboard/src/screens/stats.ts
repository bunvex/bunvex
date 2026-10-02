// What the overview derives from two stats samples. Pure, so it is tested without a DOM.
import type { DeploymentStats } from "../data-source.ts";

type Counter = Exclude<keyof DeploymentStats, "at" | "subscriptions">;

/** Per-second rate of a counter between two samples; 0 when time did not move or the counter went back. */
export function ratePerSecond(prev: DeploymentStats, cur: DeploymentStats, counter: Counter): number {
  const dt = (cur.at - prev.at) / 1000;
  const d = cur[counter] - prev[counter];
  return dt > 0 && d >= 0 ? d / dt : 0;
}

/** Query cache hit rate since the server started, 0..1; null before any cached query ran. */
export function cacheHitRate(s: DeploymentStats): number | null {
  const total = s.cacheHits + s.cacheMisses;
  return total === 0 ? null : s.cacheHits / total;
}

/**
 * Keeps the last `max` samples. A commit clock that went back means the server restarted (its counters
 * reset): the history starts over. A sample no newer than the last one — a watcher re-subscribing gets the
 * current sample first — is dropped.
 */
export function appendSample(history: DeploymentStats[], s: DeploymentStats, max: number): DeploymentStats[] {
  const last = history.at(-1);
  if (last !== undefined && s.commitTs < last.commitTs) return [s];
  if (last !== undefined && s.at <= last.at) return history;
  const next = [...history, s];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Commits per second for each consecutive pair of samples. */
export const commitRates = (history: DeploymentStats[]) =>
  history.slice(1).map((s, i) => ratePerSecond(history[i]!, s, "commitTs"));

const integer = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });

export const formatCount = (n: number) => integer.format(n);
export const formatRate = (n: number) => (n >= 100 ? integer.format(n) : oneDecimal.format(n));
export const formatPercent = (r: number) => percent.format(r);

/** "1.2 KB", "3.4 MB" (powers of 1 024, as file sizes are usually read). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "58 seconds ago", "3 minutes ago", "now". */
export function timeAgo(ms: number, now: number): string {
  const d = ms - now;
  for (const [unit, size] of UNITS)
    if (Math.abs(d) >= size || unit === "second") return relative.format(Math.trunc(d / size), unit);
  return "now";
}

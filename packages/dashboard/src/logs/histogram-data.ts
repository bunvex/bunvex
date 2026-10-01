// The numbers behind the Logs histogram (UI-01 §22.4): the loaded lines counted per time bucket and outcome,
// over a domain that runs from the oldest loaded line (or the time range's start, when that is earlier) to
// now. Pure, so it is tested without a layout.
import type { LogEntry } from "../data-source.ts";
import type { TimeWindow } from "./log-filter.ts";

export type Outcome = "ok" | "warn" | "error";
export const OUTCOMES: readonly Outcome[] = ["ok", "warn", "error"];
export const OUTCOME_LABEL: Record<Outcome, string> = { ok: "Success", warn: "Warning", error: "Failure" };

/** A failed execution or an error line is a failure; a warning line a warning; anything else succeeded. */
export function outcomeOf(e: LogEntry): Outcome {
  if (e.level === "error" || e.execution?.status === "failure") return "error";
  if (e.level === "warn") return "warn";
  return "ok";
}

export type Bucket = { from: number; to: number; ok: number; warn: number; error: number; total: number };

/** How many buckets the strip has. */
export const BUCKETS = 60;

/** The strip's span: the oldest loaded line or `start` (whichever is earlier) to `now`; null with neither. */
export function histogramDomain(lines: LogEntry[], now: number, start?: number): TimeWindow | null {
  const oldest = lines.at(-1)?.time;
  const newest = lines[0]?.time;
  const from = Math.min(oldest ?? Number.POSITIVE_INFINITY, start ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(from)) return null;
  // a little room after the newest line; at least a minute wide, so one line is not one full-width bar
  const to = Math.max(now, (newest ?? now) + 1);
  return { from: Math.min(from, to - 60_000), to };
}

/** `lines` counted into `n` equal buckets over `domain`, oldest first. */
export function bucketize(lines: LogEntry[], domain: TimeWindow, n = BUCKETS): Bucket[] {
  const size = (domain.to - domain.from) / n;
  const buckets: Bucket[] = Array.from({ length: n }, (_, i) => ({
    from: domain.from + i * size,
    to: domain.from + (i + 1) * size,
    ok: 0,
    warn: 0,
    error: 0,
    total: 0,
  }));
  for (const e of lines) {
    if (e.time < domain.from || e.time > domain.to) continue;
    const b = buckets[Math.min(n - 1, Math.floor((e.time - domain.from) / size))]!;
    b[outcomeOf(e)]++;
    b.total++;
  }
  return buckets;
}

/** The window between two points of a drag, as fractions (0–1) of the domain; null when it is too narrow. */
export function windowFromDrag(domain: TimeWindow, a: number, b: number): TimeWindow | null {
  const clamp = (f: number) => Math.min(1, Math.max(0, f));
  const lo = clamp(Math.min(a, b));
  const hi = clamp(Math.max(a, b));
  if (hi - lo < 0.005) return null;
  const span = domain.to - domain.from;
  return { from: Math.floor(domain.from + lo * span), to: Math.ceil(domain.from + hi * span) };
}

/** Where `t` falls in the domain, 0–1. */
export const fractionOf = (domain: TimeWindow, t: number) =>
  Math.min(1, Math.max(0, (t - domain.from) / (domain.to - domain.from)));

// A cron's next run (Convex's crates/model/src/cron_jobs/next_ts.rs `compute_next_ts`), in ms:
// - an interval runs at `prev + seconds`, and at once when new (anchored to the previous *scheduled* time);
// - a clock schedule is a cron string (an omitted minute is 0), searched in UTC;
// - splay: a stable random delay, up to an hour when the minute is not pinned, else up to
//   CRON_SPLAY_SECONDS (60). It is kept only as the previous run's offset within its period.
import type { CronSchedule } from "./cron.ts";
import { parseCronExpression } from "./cron-expression.ts";

export type Rng = (maxExclusive: number) => number;
export const defaultRng: Rng = (max) => Math.floor(Math.random() * max);

/** The cron string a clock schedule runs on. */
export function cronStringOf(s: Exclude<CronSchedule, { type: "interval" }>): string {
  const m = s.type === "cron" ? 0 : (s.minuteUTC ?? 0);
  switch (s.type) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${s.hourUTC} * * *`;
    case "weekly":
      return `${m} ${s.hourUTC} * * ${s.dayOfWeek}`;
    case "monthly":
      return `${m} ${s.hourUTC} ${s.day} * *`;
    case "cron":
      return s.cronExpr;
  }
}

/** `{maxSplay, period}` in seconds, or null for no splay. */
function splayBounds(s: CronSchedule, cronSplaySeconds: number): { max: number; period: number } | null {
  if (s.type === "interval") return null;
  const unpinned = s.type !== "cron" && s.minuteUTC === undefined;
  const b = unpinned ? { max: 3600, period: 3600 } : { max: cronSplaySeconds, period: 60 };
  return b.max === 0 ? null : b;
}

function splay(s: CronSchedule, prevTs: number | null, rng: Rng, cronSplaySeconds: number) {
  const b = splayBounds(s, cronSplaySeconds);
  if (!b) return { previous: 0, next: 0 };
  if (prevTs !== null) {
    const delay = Math.floor(prevTs / 1000) % b.period;
    // A previous run without a delay (it predates splay) draws one, from the following occurrence on.
    return delay !== 0 ? { previous: delay, next: delay } : { previous: 0, next: rng(b.max) };
  }
  const delay = rng(b.max);
  return { previous: delay, next: delay };
}

export function computeNextTs(
  s: CronSchedule,
  prevTs: number | null,
  now: number,
  opts: { rng?: Rng; cronSplaySeconds?: number } = {},
): number {
  if (s.type === "interval") return prevTs === null ? now : prevTs + s.seconds * 1000;
  const cron = parseCronExpression(cronStringOf(s));
  const { previous, next } = splay(s, prevTs, opts.rng ?? defaultRng, opts.cronSplaySeconds ?? 60);
  // Search from now minus the previous delay, so a slow run does not skip an occurrence its delay pushed
  // past now; the result is after now because the search is strictly increasing.
  const occurrence = cron.nextAfter(now - previous * 1000);
  if (occurrence === null) throw new Error("Could not compute next timestamp for cron");
  return occurrence + next * 1000;
}

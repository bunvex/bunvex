// Cron schedules (Convex's shapes, UTC): how to say one in words, and when it next fires. The screen
// describes them; the mock runs them.
import type { CronSchedule } from "../data-source.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");
const at = (h: number, m: number) => `${pad(h)}:${pad(m)} UTC`;
const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

function every(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units)
    if (seconds % size === 0) {
      const n = seconds / size;
      return n === 1 ? `Every ${name}` : `Every ${n} ${name}s`;
    }
  return `Every ${seconds} seconds`;
}

/** "Every 5 minutes", "Daily at 03:00 UTC", "Cron 0 * * * *". */
export function describeSchedule(s: CronSchedule): string {
  switch (s.type) {
    case "interval":
      return every(s.seconds);
    case "hourly":
      return `Hourly at minute ${s.minuteUTC}`;
    case "daily":
      return `Daily at ${at(s.hourUTC, s.minuteUTC)}`;
    case "weekly":
      return `Weekly on ${DAYS[s.dayOfWeek] ?? `day ${s.dayOfWeek}`} at ${at(s.hourUTC, s.minuteUTC)}`;
    case "monthly":
      return `Monthly on the ${ordinal(s.day)} at ${at(s.hourUTC, s.minuteUTC)}`;
    case "cron":
      return `Cron ${s.cronExpr}`;
  }
}

// ------------------------------------------------------------------ when it fires

/** The values a cron field allows: `*`, `*\/n`, `a-b`, `a,b`, numbers. */
function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    const [lo, hi] =
      range === "*" ? [min, max] : range.includes("-") ? range.split("-").map(Number) : [Number(range), Number(range)];
    if (![lo, hi, step].every(Number.isInteger) || step < 1) throw new Error(`bad cron field "${spec}"`);
    for (let v = lo!; v <= hi!; v += step) out.add(v);
  }
  return out;
}

/** The first minute after `after` (ms) that a five-field cron expression matches, in UTC. */
function nextCron(expr: string, after: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has five fields: "${expr}"`);
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = field(mi, 0, 59);
  const hours = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mon, 1, 12);
  const weekdays = field(dow, 0, 6);
  const t = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      minutes.has(t.getUTCMinutes()) &&
      hours.has(t.getUTCHours()) &&
      days.has(t.getUTCDate()) &&
      months.has(t.getUTCMonth() + 1) &&
      weekdays.has(t.getUTCDay())
    )
      return t.getTime();
    t.setTime(t.getTime() + 60_000);
  }
  throw new Error(`"${expr}" never fires`);
}

/** When the schedule fires next, strictly after `after` (ms). */
export function nextRunAfter(s: CronSchedule, after: number): number {
  const d = new Date(after);
  const utc = (y: number, mo: number, day: number, h: number, m: number) => Date.UTC(y, mo, day, h, m);
  const [y, mo, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  let t: number;
  switch (s.type) {
    case "interval":
      return after + s.seconds * 1000;
    case "hourly":
      t = utc(y, mo, day, d.getUTCHours(), s.minuteUTC);
      return t > after ? t : t + 3_600_000;
    case "daily":
      t = utc(y, mo, day, s.hourUTC, s.minuteUTC);
      return t > after ? t : t + 86_400_000;
    case "weekly":
      t = utc(y, mo, day + ((s.dayOfWeek - d.getUTCDay() + 7) % 7), s.hourUTC, s.minuteUTC);
      return t > after ? t : t + 7 * 86_400_000;
    case "monthly":
      t = utc(y, mo, s.day, s.hourUTC, s.minuteUTC);
      return t > after ? t : utc(y, mo + 1, s.day, s.hourUTC, s.minuteUTC);
    case "cron":
      return nextCron(s.cronExpr, after);
  }
}

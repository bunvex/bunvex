// Cron jobs (STUDY-30 §1.5): `cronJobs()` as Convex's (npm-packages/convex/src/server/cron.ts), and the
// server's second validation of what it exports (crates/model/src/cron_jobs/types.rs
// `CronSpec::from_exported_json`). bunvex has no push yet, so the crons are handed to `createServer`
// and checked at start (S1).
import { type AnyFunctionReference, getFunctionName } from "@bunvex/protocol";
import { isSimpleObject, toJsonValue, type Value, valueSize } from "@bunvex/values";
import { parseCronExpression } from "./cron-expression.ts";

const DAYS_OF_WEEK = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

export type Schedule =
  | { type: "cron"; cron: string }
  | { type: "interval"; seconds: number }
  | { type: "interval"; minutes: number }
  | { type: "interval"; hours: number }
  | { type: "hourly"; minuteUTC?: number }
  | { type: "daily"; hourUTC: number; minuteUTC?: number }
  | { type: "weekly"; dayOfWeek: DayOfWeek; hourUTC: number; minuteUTC?: number }
  | { type: "monthly"; day: number; hourUTC: number; minuteUTC?: number };

export type CronJob = { name: string; args: [Record<string, Value>]; schedule: Schedule };
type Fn = AnyFunctionReference | string;
type Args = Record<string, unknown>;

export const cronJobs = () => new Crons();

function validateIntervalNumber(n: number) {
  if (!Number.isInteger(n) || n <= 0) throw new Error("Interval must be an integer greater than 0");
}
function validatedDayOfMonth(n: number) {
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error("Day of month must be an integer from 1 to 31");
  return n;
}
function validatedDayOfWeek(s: string) {
  if (!DAYS_OF_WEEK.includes(s as DayOfWeek)) throw new Error('Day of week must be a string like "monday".');
  return s as DayOfWeek;
}
function validatedHourOfDay(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 23) throw new Error("Hour of day must be an integer from 0 to 23");
  return n;
}
function validatedMinuteOfHour(n: number) {
  if (!Number.isInteger(n) || n < 0 || n > 59) throw new Error("Minute of hour must be an integer from 0 to 59");
  return n;
}
const validatedOptionalMinuteOfHour = (n: number | undefined) =>
  n === undefined ? undefined : validatedMinuteOfHour(n);
function validatedCronIdentifier(s: string) {
  if (!s.match(/^[ -~]*$/))
    throw new Error(`Invalid cron identifier ${s}: use ASCII letters that are not control characters`);
  return s;
}
function parseArgs(args: unknown): Record<string, Value> {
  if (args === undefined) return {};
  if (!isSimpleObject(args))
    throw new Error(`The arguments to a bunvex function must be an object. Received: ${args as unknown}`);
  return args as Record<string, Value>;
}
const isFunction = (x: unknown) => {
  try {
    getFunctionName(x as Fn);
    return true;
  } catch {
    return false;
  }
};

export class Crons {
  crons: Record<string, CronJob> = {};
  readonly isCrons = true as const;

  schedule(cronIdentifier: string, schedule: Schedule, fn: Fn, args?: Args) {
    const cronArgs = parseArgs(args);
    validatedCronIdentifier(cronIdentifier);
    if (cronIdentifier in this.crons) throw new Error(`Cron identifier registered twice: ${cronIdentifier}`);
    this.crons[cronIdentifier] = { name: getFunctionName(fn), args: [cronArgs], schedule };
  }

  interval(
    cronIdentifier: string,
    schedule: { seconds?: number; minutes?: number; hours?: number },
    fn: Fn,
    args?: Args,
  ) {
    const has = (k: "seconds" | "minutes" | "hours") => +(k in schedule && schedule[k] !== undefined);
    if (has("seconds") + has("minutes") + has("hours") !== 1)
      throw new Error("Must specify one of seconds, minutes, or hours");
    validateIntervalNumber((schedule.seconds ?? schedule.minutes ?? schedule.hours)!);
    this.schedule(cronIdentifier, { ...schedule, type: "interval" } as Schedule, fn, args);
  }

  /** `hourly(id, fn, args?)`, or `hourly(id, { minuteUTC }, fn, args?)`. */
  hourly(cronIdentifier: string, scheduleOrFn: { minuteUTC?: number } | Fn, fnOrArgs?: Fn | Args, args?: Args) {
    if (isFunction(scheduleOrFn)) {
      this.schedule(cronIdentifier, { type: "hourly" }, scheduleOrFn as Fn, fnOrArgs as Args | undefined);
      return;
    }
    const minuteUTC = validatedOptionalMinuteOfHour((scheduleOrFn as { minuteUTC?: number }).minuteUTC);
    this.schedule(
      cronIdentifier,
      minuteUTC === undefined ? { type: "hourly" } : { minuteUTC, type: "hourly" },
      fnOrArgs as Fn,
      args,
    );
  }

  daily(cronIdentifier: string, schedule: { hourUTC: number; minuteUTC?: number }, fn: Fn, args?: Args) {
    const hourUTC = validatedHourOfDay(schedule.hourUTC);
    const minuteUTC = validatedOptionalMinuteOfHour(schedule.minuteUTC);
    this.schedule(
      cronIdentifier,
      minuteUTC === undefined ? { hourUTC, type: "daily" } : { hourUTC, minuteUTC, type: "daily" },
      fn,
      args,
    );
  }

  weekly(
    cronIdentifier: string,
    schedule: { dayOfWeek: DayOfWeek; hourUTC: number; minuteUTC?: number },
    fn: Fn,
    args?: Args,
  ) {
    const dayOfWeek = validatedDayOfWeek(schedule.dayOfWeek);
    const hourUTC = validatedHourOfDay(schedule.hourUTC);
    const minuteUTC = validatedOptionalMinuteOfHour(schedule.minuteUTC);
    this.schedule(
      cronIdentifier,
      minuteUTC === undefined
        ? { dayOfWeek, hourUTC, type: "weekly" }
        : { dayOfWeek, hourUTC, minuteUTC, type: "weekly" },
      fn,
      args,
    );
  }

  monthly(cronIdentifier: string, schedule: { day: number; hourUTC: number; minuteUTC?: number }, fn: Fn, args?: Args) {
    const day = validatedDayOfMonth(schedule.day);
    const hourUTC = validatedHourOfDay(schedule.hourUTC);
    const minuteUTC = validatedOptionalMinuteOfHour(schedule.minuteUTC);
    this.schedule(
      cronIdentifier,
      minuteUTC === undefined ? { day, hourUTC, type: "monthly" } : { day, hourUTC, minuteUTC, type: "monthly" },
      fn,
      args,
    );
  }

  /** A unix cron string, `"m h dom mon dow"`, in UTC. Checked by the server, as Convex's. */
  cron(cronIdentifier: string, cron: string, fn: Fn, args?: Args) {
    this.schedule(cronIdentifier, { cron, type: "cron" }, fn, args);
  }

  /** The JSON a push would carry (Convex's `export()`). */
  export() {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(this.crons).map(([k, c]) => [k, { ...c, args: [toJsonValue(c.args[0] as Value)] }]),
      ),
    );
  }
}

/** A cron as the server keeps it (Convex's `CronSpec`): the schedule normalized, intervals in seconds. */
export type CronSchedule =
  | { type: "interval"; seconds: number }
  | { type: "hourly"; minuteUTC?: number }
  | { type: "daily"; hourUTC: number; minuteUTC?: number }
  | { type: "weekly"; dayOfWeek: number; hourUTC: number; minuteUTC?: number }
  | { type: "monthly"; day: number; hourUTC: number; minuteUTC?: number }
  | { type: "cron"; cronExpr: string };
export type CronSpec = { udfPath: string; udfArgs: Value[]; cronSchedule: CronSchedule };

/** Convex's MAX_USER_SIZE: a cron's args must fit in a document. */
const MAX_CRON_ARGS_SIZE = 1 << 20;

/**
 * The server's checks of each exported cron (`CronSpec::from_exported_json`), as `InvalidCron` errors.
 * `canonical` resolves and checks the target (`validate_cron_jobs`).
 */
export function cronSpecs(crons: Crons, canonical: (id: string, name: string) => string): Map<string, CronSpec> {
  const out = new Map<string, CronSpec>();
  for (const [id, c] of Object.entries(crons.crons)) {
    if ([...id].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e))
      throw new Error(
        `${id} is not a valid cron identifier. CronIdentifiers can only contain ASCII letters, numbers, spaces, underscores, dashes and apostrophes`,
      );
    const json = JSON.stringify(c.schedule);
    const s = c.schedule as Record<string, unknown>;
    const int = (k: string) => {
      const n = s[k];
      if (n !== undefined && !Number.isInteger(n)) throw new Error("Invalid JSON");
      return n as number | undefined;
    };
    const range = (k: string, lo: number, hi: number, label: string) => {
      const n = int(k);
      if (n !== undefined && (n < lo || n > hi)) throw new Error(`${label} must be ${lo}-${hi} in ${json}`);
      return n;
    };
    let schedule: CronSchedule;
    switch (c.schedule.type) {
      case "interval": {
        const given = ["seconds", "minutes", "hours"].filter((k) => s[k] !== undefined);
        if (given.length !== 1) throw new Error("Exactly one of (seconds, minutes, hours) should be specified");
        const n = int(given[0])!;
        if (n <= 0) throw new Error("Interval must be an integer greater than 0");
        schedule = { type: "interval", seconds: n * { seconds: 1, minutes: 60, hours: 3600 }[given[0] as "seconds"] };
        break;
      }
      case "hourly":
        schedule = { type: "hourly", ...opt("minuteUTC", range("minuteUTC", 0, 59, "minuteUTC")) };
        break;
      case "daily":
        schedule = {
          type: "daily",
          hourUTC: range("hourUTC", 0, 23, "hourUTC")!,
          ...opt("minuteUTC", range("minuteUTC", 0, 59, "minuteUTC")),
        };
        break;
      case "weekly": {
        const dow = DAYS_OF_WEEK.indexOf(c.schedule.dayOfWeek);
        if (dow === -1) throw new Error("Invalid JSON");
        schedule = {
          type: "weekly",
          dayOfWeek: dow,
          hourUTC: range("hourUTC", 0, 23, "hourUTC")!,
          ...opt("minuteUTC", range("minuteUTC", 0, 59, "minuteUTC")),
        };
        break;
      }
      case "monthly":
        schedule = {
          type: "monthly",
          day: range("day", 1, 31, "day of month")!,
          hourUTC: range("hourUTC", 0, 23, "hourUTC")!,
          ...opt("minuteUTC", range("minuteUTC", 0, 59, "minuteUTC")),
        };
        break;
      case "cron": {
        const expr = (c.schedule as { cron: string }).cron;
        const parsed = parseCronExpression(expr); // throws on a syntax error
        if (!parsed.any()) throw new Error(`The cron spec ${JSON.stringify(expr)} will never match any time`);
        schedule = { type: "cron", cronExpr: expr };
        break;
      }
      default:
        throw new Error("Invalid JSON");
    }
    const size = valueSize(c.args as unknown as Value);
    if (size > MAX_CRON_ARGS_SIZE)
      throw new Error(`Cron job args too large (${size} > maximum size ${MAX_CRON_ARGS_SIZE})`);
    out.set(id, { udfPath: canonical(id, c.name), udfArgs: c.args, cronSchedule: schedule });
  }
  return out;
}

const opt = <K extends string>(k: K, v: number | undefined) =>
  v === undefined ? {} : ({ [k]: v } as Record<K, number>);

// Cron rows as Convex stores them (STUDY-134, DV-425; crates/model/src/cron_jobs/types.rs): a spec's schedule
// numbers are int64s and an absent `minuteUTC` is null (`SerializedCronSchedule`), its arguments the JSON text of
// the argument array as bytes (`SerializedCronSpec.udf_args`), every time an int64 of nanoseconds
// (`SerializedCronNextRun`, `CronJobLog.ts`), an in-progress state's ids snake_case (`CronJobState`). The rest of
// the server keeps its own in-memory forms (numbers, milliseconds, the argument array); these convert at the row.
import { fromJsonValue, jsonText, toJsonValue, type Value } from "@bunvex/values";
import type { CronSchedule, CronSpec } from "./cron.ts";

/** A millisecond time as a row's int64 of nanoseconds (Convex's `Timestamp`). */
export function nsOfMs(ms: number): bigint {
  const whole = Math.trunc(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000));
}

/** A row's int64 of nanoseconds as milliseconds. */
export function msOfNs(ns: bigint): number {
  return Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1_000_000;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The arguments as Convex's `SerializedArgs`: the JSON text of the argument array, as bytes. */
export const argsBytes = (args: Value[]): ArrayBuffer =>
  encoder.encode(jsonText(toJsonValue(args as Value))).buffer as ArrayBuffer;
export const argsOfBytes = (bytes: ArrayBuffer): Value[] => fromJsonValue(JSON.parse(decoder.decode(bytes))) as Value[];

const int = (n: number) => BigInt(n);
const minute = (s: { minuteUTC?: number }) => (s.minuteUTC === undefined ? null : int(s.minuteUTC));

/** A schedule as its row (`SerializedCronSchedule`). */
export function scheduleRow(s: CronSchedule): Record<string, Value> {
  switch (s.type) {
    case "interval":
      return { type: "interval", seconds: int(s.seconds) };
    case "hourly":
      return { type: "hourly", minuteUTC: minute(s) };
    case "daily":
      return { type: "daily", hourUTC: int(s.hourUTC), minuteUTC: minute(s) };
    case "weekly":
      return { type: "weekly", dayOfWeek: int(s.dayOfWeek), hourUTC: int(s.hourUTC), minuteUTC: minute(s) };
    case "monthly":
      return { type: "monthly", day: int(s.day), hourUTC: int(s.hourUTC), minuteUTC: minute(s) };
    case "cron":
      return { type: "cron", cronExpr: s.cronExpr };
  }
}

/** A schedule from its row. */
export function scheduleOf(row: Record<string, unknown>): CronSchedule {
  const n = (k: string) => Number(row[k] as bigint);
  const m = row.minuteUTC === null || row.minuteUTC === undefined ? {} : { minuteUTC: n("minuteUTC") };
  switch (row.type) {
    case "interval":
      return { type: "interval", seconds: n("seconds") };
    case "hourly":
      return { type: "hourly", ...m };
    case "daily":
      return { type: "daily", hourUTC: n("hourUTC"), ...m };
    case "weekly":
      return { type: "weekly", dayOfWeek: n("dayOfWeek"), hourUTC: n("hourUTC"), ...m };
    case "monthly":
      return { type: "monthly", day: n("day"), hourUTC: n("hourUTC"), ...m };
    case "cron":
      return { type: "cron", cronExpr: row.cronExpr as string };
    default:
      throw new Error(`Invalid cron schedule type ${String(row.type)}`);
  }
}

/** A spec as its row (`SerializedCronSpec`). */
export const cronSpecRow = (spec: CronSpec): Record<string, Value> => ({
  udfPath: spec.udfPath,
  udfArgs: argsBytes(spec.udfArgs),
  cronSchedule: scheduleRow(spec.cronSchedule),
});

/** A spec from its row. */
export const cronSpecOf = (row: Record<string, unknown>): CronSpec => ({
  udfPath: row.udfPath as string,
  udfArgs: argsOfBytes(row.udfArgs as ArrayBuffer),
  cronSchedule: scheduleOf(row.cronSchedule as Record<string, unknown>),
});

/** A module's cron specs as `analyzeResult.cronSpecs`: Convex's `[{identifier, spec}]`, or null. */
export const cronSpecsRow = (specs: Record<string, CronSpec> | null): Value =>
  specs === null ? null : Object.entries(specs).map(([identifier, spec]) => ({ identifier, spec: cronSpecRow(spec) }));

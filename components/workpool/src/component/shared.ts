// What the component and the client share (STUDY-199 §1.3, §1.4): the time segments, the config, retry, result,
// onComplete and status validators, and the bounds on a job's start time. Names, defaults and shapes are those of
// Convex's workpool 0.4.14.
import { type Infer, type VAny, type Validator, v } from "@bunvex/values";
import { type Logger, logLevel } from "./logging";

export const fnType = v.union(v.literal("action"), v.literal("mutation"), v.literal("query"));

export const DEFAULT_MAX_PARALLELISM = 10;
/** The batch worker's queue: one per pool. */
export const WORKER_NAME = "main";
/** A segment is this slice of time: jobs due in one are handled together. */
const SEGMENT_MS = 100;
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const YEAR = 365 * DAY;

/** The segment a time (ms since the epoch) falls in. */
export function toSegment(ms: number): bigint {
  return BigInt(Math.floor(ms / SEGMENT_MS));
}

export function getCurrentSegment(): bigint {
  return toSegment(Date.now());
}

export function getNextSegment(): bigint {
  return getCurrentSegment() + 1n;
}

/** When a segment starts, in ms since the epoch. */
export function fromSegment(segment: bigint): number {
  return Number(segment) * SEGMENT_MS;
}

export const vConfig = v.object({
  maxParallelism: v.number(),
  logLevel,
});
export type Config = Infer<typeof vConfig>;

/** How a failed action is retried: `maxAttempts` in all, waiting `initialBackoffMs * base^(n - 1)` (±50%). */
export const retryBehavior = v.object({
  maxAttempts: v.number(),
  initialBackoffMs: v.number(),
  base: v.number(),
});
/** How a failed action is retried. */
export type RetryBehavior = {
  /** The most attempts made in all: 2 means one retry. */
  maxAttempts: number;
  /** How long before the first retry, in ms: 100 waits about 100 ms. */
  initialBackoffMs: number;
  /**
   * What each wait is multiplied by: with 2 and an initial backoff of 100 ms, the retries wait about 100, 200, 400 ms,
   * and so on.
   */
  base: number;
};
/** Five attempts, waiting about 250, 500, 1000 and 2000 ms between them. */
export const DEFAULT_RETRY_BEHAVIOR: RetryBehavior = {
  maxAttempts: 5,
  initialBackoffMs: 250,
  base: 2,
};
// The type and the validator agree.
void ({} as RetryBehavior satisfies Infer<typeof retryBehavior>);

/** A run's result, with any return value. */
export const vResult = vRunResult(v.any());

/** A run's result, its return value checked by `returnValue`: a success, a failure with its message, or canceled. */
// biome-ignore lint/suspicious/noExplicitAny: any return value validator
export function vRunResult<RV extends Validator<any, any> = VAny>(returnValue: RV) {
  return v.union(
    v.object({ kind: v.literal("success"), returnValue }),
    v.object({ kind: v.literal("failed"), error: v.string() }),
    v.object({ kind: v.literal("canceled") }),
  );
}
/** How a job ended. */
export type RunResult<Returns = unknown> =
  | {
      kind: "success";
      /** What the function returned. */
      returnValue: Returns;
    }
  | {
      kind: "failed";
      /** The error's message. */
      error: string;
    }
  | {
      kind: "canceled";
    };

export const vOnCompleteFnContext = v.object({
  // A mutation's handle.
  fnHandle: v.string(),
  context: v.optional(v.any()),
  excludeKinds: v.optional(v.array(v.union(v.literal("success"), v.literal("failed"), v.literal("canceled")))),
});

/** What an `onComplete` mutation is called with. */
export type OnCompleteArgs = {
  /** The job that ended. */
  workId: string;
  /** The `context` given when the job was enqueued, to carry data from there to here. */
  context: unknown;
  /** How it ended. */
  result: RunResult;
};

export const status = v.union(
  v.union(
    v.object({ state: v.literal("pending"), previousAttempts: v.number() }),
    v.object({ state: v.literal("running"), previousAttempts: v.number() }),
    v.object({ state: v.literal("finished") }),
  ),
);
/** Where a job is: waiting to start (or to retry), running, or done (or never existed). */
export type Status = Infer<typeof status>;

/** A start time more than a year old becomes now; more than four years ahead becomes a year from now. */
export function boundScheduledTime(ms: number, console: Logger): number {
  if (ms < Date.now() - YEAR) {
    console.error("scheduled time is too old, defaulting to now", ms);
    return Date.now();
  }
  if (ms > Date.now() + 4 * YEAR) {
    console.error("scheduled time is too far in the future, defaulting to 1 year from now", ms);
    return Date.now() + YEAR;
  }
  return ms;
}

/** The smaller of two bigints. */
export function min<T extends bigint>(a: T, b: T): T {
  return a > b ? b : a;
}

/** The larger of two bigints. */
export function max<T extends bigint>(a: T, b: T): T {
  return a < b ? b : a;
}

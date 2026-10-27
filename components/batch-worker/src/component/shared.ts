// What the component and the client share (STUDY-196 §1.1, §1.7): the timing constants, the config and status
// validators, and the contract between the loop and the app's two functions: the work query's arguments and
// results, the worker mutation's results, and `defineBatchWorkerValidators` that builds all four from one batch
// shape and one cursor type. Names, defaults and shapes are those of Convex's `@convex-dev/batch-worker` 0.3.6.
//
// The three validators Convex deprecated in 0.3.0 (`vBatchQueryArgs`, `vBatchResult`, `vWorkerResult`) are not
// built (DV-539, STUDY-196 B-1).
import {
  asObjectValidator,
  type Infer,
  type PropertyValidators,
  type Validator,
  type VCommitTs,
  v,
} from "@bunvex/values";

export const MS = 1;
export const SECOND = 1000 * MS;
export const MINUTE = 60 * SECOND;

/** A next run this close keeps the worker `running` (a ping is then a no-op); a later one lets it wait as `idle`. */
export const RUNNING_THRESHOLD_MS = 1 * SECOND;
/** The monitor's default distance behind the loop's next run: it fires only if the loop missed that run. */
export const MONITOR_LAG_MS = 60 * SECOND;
/** The monitor is moved back only once it would fire within this; also the smallest lag it keeps. */
export const MONITOR_REFRESH_WITHIN_MS = 10 * SECOND;
/** A run still pending this long after its time is stuck, not just late behind a busy scheduler. */
export const STUCK_RUNNER_GRACE_MS = 60 * SECOND;

/** A worker's loop configuration. */
export const vConfig = v.object({
  /** How long the loop waits before its first batch after starting from idle, to let a burst of inserts gather. */
  debounceMs: v.number(),
  /**
   * How long after the loop's next run the monitor is scheduled. The monitor restarts a loop that did not run by
   * then, so this is also how soon a failing query or mutation is retried.
   */
  monitorLagMs: v.number(),
});
export type Config = Infer<typeof vConfig>;

export const DEFAULT_CONFIG: Config = {
  debounceMs: 0,
  monitorLagMs: MONITOR_LAG_MS,
};

/**
 * A worker's run state, on its `workers` row.
 *
 * - `idle`: nothing scheduled, or a wait a ping may interrupt;
 * - `running`: the loop runs or is about to, so a ping does nothing;
 * - `stopped`: `stop` was called; only `start` resumes it.
 */
export const vStatus = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("stopped") }),
);
export type Status = Infer<typeof vStatus>;

/** The default cursor: a commit timestamp, written as `ctx.db.vars.commitTs` and read back as a `bigint`. */
export const vDefaultCursor = v.commitTs();
export type DefaultCursor = Infer<typeof vDefaultCursor>;

/** The work query's arguments: the worker's `name`, and the `cursor` it last committed, once it has one. */
export type BatchQueryArgs<Cursor = DefaultCursor> = {
  name: string;
  cursor?: Cursor;
};

// biome-ignore lint/suspicious/noExplicitAny: any batch or cursor validator, as Convex's package takes
type AnyValidator = Validator<any, "required">;

function batchResultValidator<B extends AnyValidator | PropertyValidators, C extends AnyValidator>(
  batch: B,
  cursor: C,
) {
  return v.union(
    v.object({
      kind: v.optional(v.literal("work")),
      batch: asObjectValidator(batch),
      cursor: v.optional(cursor),
    }),
    v.object({
      kind: v.literal("idle"),
      /** How long the loop keeps polling an empty queue before going idle. */
      cooldownMs: v.optional(v.number()),
      /** How long between polls while cooling down. */
      pollIntervalMs: v.optional(v.number()),
      /** Once cooled down, run again at the latest this long from now; a ping may wake it sooner. */
      timeoutMs: v.optional(v.number()),
    }),
  );
}

/**
 * What the work query returns: a `batch` for the worker mutation, with the `cursor` it reached; or `idle`, with
 * hints on how long to keep polling and when to look again.
 *
 * A cursor is committed with the batch, only if the worker mutation commits, and comes back as the next call's
 * `args.cursor`. `idle` carries none: to move past a stretch with nothing to do, return an empty batch and the
 * advanced cursor.
 */
export type BatchResult<Batch, Cursor = DefaultCursor> =
  | {
      kind?: "work";
      batch: Batch;
      /** How far this batch got; omit it to leave the cursor as it is. */
      cursor?: Cursor;
    }
  | {
      kind: "idle";
      /** How long the loop keeps polling an empty queue before going idle. */
      cooldownMs?: number;
      /** How long between polls while cooling down. */
      pollIntervalMs?: number;
      /** The longest the worker stays idle when nothing pings it. */
      timeoutMs?: number;
    };

function workerResultValidator<C extends AnyValidator>(cursor: C) {
  return v.union(
    v.null(),
    v.object({
      /** Don't run again, and ignore pings, for at least this long. */
      debounceMs: v.optional(v.number()),
      /** Replaces the cursor the work query returned, when the batch got only part of the way. */
      cursor: v.optional(cursor),
    }),
  );
}

/** What the worker mutation may return. Nothing (or null) runs the loop again at once. */
export type WorkerResult<Cursor = DefaultCursor> = null | {
  debounceMs?: number;
  cursor?: Cursor;
};

/**
 * The work query's and the worker mutation's argument and return validators, from one batch shape and one cursor
 * type, so the two functions agree.
 *
 * `cursor` is a commit timestamp ({@link vDefaultCursor}) unless given, e.g. a `paginator` cursor.
 *
 * @example
 * ```ts
 * const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } = defineBatchWorkerValidators({
 *   batch: { ids: v.array(v.id("tasks")) },
 * });
 *
 * export const getBatch = internalQuery({ args: vQueryArgs, returns: vQueryReturns, handler: async (ctx, args) => … });
 * export const processBatch = internalMutation({ args: vMutationArgs, returns: vMutationReturns, handler: … });
 * ```
 */
export function defineBatchWorkerValidators<
  B extends AnyValidator | PropertyValidators,
  C extends AnyValidator = VCommitTs,
>(spec: { batch: B; cursor?: C }) {
  const cursor = (spec.cursor ?? vDefaultCursor) as C;
  return {
    /** The work query's `args`: `{ name, cursor? }`. */
    vQueryArgs: v.object({ name: v.string(), cursor: v.optional(cursor) }),
    /** The work query's `returns`: a batch and an optional cursor, or idle. */
    vQueryReturns: batchResultValidator(spec.batch, cursor),
    /** The worker mutation's `args`: the batch. */
    vMutationArgs: asObjectValidator(spec.batch),
    /** The worker mutation's `returns`: null, or `{ debounceMs?, cursor? }`. */
    vMutationReturns: workerResultValidator(cursor),
  };
}

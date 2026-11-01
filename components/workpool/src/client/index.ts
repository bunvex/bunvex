// The pool's client (STUDY-199 §1.16), with the API of Convex's workpool 0.4.14: the `Workpool` class, which
// enqueues actions, mutations and queries (one at a time or in batches), cancels them and reads their status; the
// free functions `enqueue` and `enqueueBatch`; and the validators and types an `onComplete` is written with. The
// class applies no defaults: an option left unset is not sent, and the pool keeps what it has stored.
//
// The aliases Convex deprecated (`resultValidator`, `workIdValidator`, `vOnCompleteValidator`) are not built
// (DV-539); `vWorkIdValidator` and `vResultValidator`, current names, are (STUDY-199 W-5). `NonRetryableError` is a
// `BunvexError` (DV-538).
import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionHandle,
  type FunctionReference,
  type FunctionType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  internalMutationGeneric,
  type RegisteredMutation,
} from "@bunvex/server";
import { type Infer, type VAny, type Validator, type Value, type VString, v, valueSize } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { LogLevel } from "../component/logging.ts";
import {
  type Config,
  DEFAULT_RETRY_BEHAVIOR,
  type RetryBehavior,
  type RunResult,
  type OnCompleteArgs as SharedOnCompleteArgs,
  type Status,
  vResult,
  vRunResult,
} from "../component/shared.ts";
import { type ActionCtx, type MutationCtx, type QueryCtx, safeFunctionName } from "./utils.ts";

export { isNonRetryableError, NonRetryableError } from "../component/errors.ts";
export { type LogLevel, logLevel as vLogLevel } from "../component/logging.ts";
export { retryBehavior as vRetryBehavior } from "../component/shared.ts";

/** A job's id, as `enqueue*` returns it. */
export type WorkId = string & { __isWorkId: true };
/** A job's id: a string. */
export const vWorkId = v.string() as VString<WorkId>;
export {
  DEFAULT_RETRY_BEHAVIOR,
  type RetryBehavior,
  type RunResult,
  vResult,
  // Older names, still current.
  vResult as vResultValidator,
  vRunResult,
  vWorkId as vWorkIdValidator,
};
/** The arguments of an `onComplete` mutation with any context: `vOnCompleteArgs(v.any())`. */
export const vOnComplete = vOnCompleteArgs(v.any());

/** The pool's component, as `components.<name>` gives it. */
export type WorkpoolComponent = ComponentApi;

/**
 * The calls the client makes on a context, by reference. bunvex's contexts also take a function by its name (an
 * overload), and TypeScript cannot call an overloaded method through a union of contexts.
 */
type RunMutation = {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: FunctionArgs<M>,
  ): Promise<unknown>;
};
type RunQuery = {
  runQuery<Q extends FunctionReference<"query", "internal">>(query: Q, args: FunctionArgs<Q>): Promise<unknown>;
};
const runMutation = <M extends FunctionReference<"mutation", "internal">>(
  ctx: MutationCtx | ActionCtx,
  mutation: M,
  args: FunctionArgs<M>,
) => (ctx as unknown as RunMutation).runMutation(mutation, args);
const runQuery = <Q extends FunctionReference<"query", "internal">>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  query: Q,
  args: FunctionArgs<Q>,
) => (ctx as unknown as RunQuery).runQuery(query, args);

export class Workpool {
  /**
   * A pool, on the component mounted as `component`.
   *
   * Each mount (`app.use(workpool, { name })` in `bunvex.config.ts`) is one pool: several `Workpool` objects on the
   * same mount share its queue and its limit.
   *
   * @param component The mounted component, like `components.workpool` from `./_generated/api`.
   * @param options The pool's {@link WorkpoolOptions}; `{}` keeps what the pool has stored.
   */
  constructor(
    public component: WorkpoolComponent,
    public options: WorkpoolOptions,
  ) {}

  /**
   * Enqueue an action.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The action, like `internal.example.myAction`.
   * @param fnArgs Its arguments.
   * @param options Its retry behavior, `onComplete`, and when to run it (`runAt` or `runAfter`).
   * @returns The job's id.
   */
  async enqueueAction<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"action", FunctionVisibility, Args, NoInfer<ReturnType>>,
    fnArgs: Args,
    options?: RetryOption & EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId> {
    const retryBehavior = getRetryBehavior(
      this.options.defaultRetryBehavior,
      this.options.retryActionsByDefault,
      options?.retry,
    );
    return enqueue(this.component, ctx, "action", fn, fnArgs, { retryBehavior, ...this.options, ...options });
  }

  /**
   * Enqueue an action once per item of `argsArray`. Each runs on its own, and `onComplete` is called for each.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The action, like `internal.example.myAction`.
   * @param argsArray The arguments of each run.
   * @param options Their retry behavior, `onComplete`, and when to run them (`runAt` or `runAfter`).
   * @returns The jobs' ids, in the order of `argsArray`.
   */
  async enqueueActionBatch<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"action", FunctionVisibility, Args, NoInfer<ReturnType>>,
    argsArray: Array<Args>,
    options?: RetryOption & EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId[]> {
    const retryBehavior = getRetryBehavior(
      this.options.defaultRetryBehavior,
      this.options.retryActionsByDefault,
      options?.retry,
    );
    return enqueueBatch(this.component, ctx, "action", fn, argsArray, {
      retryBehavior,
      ...this.options,
      ...options,
    });
  }

  /**
   * Enqueue a mutation.
   *
   * The pool does not retry mutations: the platform already retries them on conflicts and transient failures, and,
   * being deterministic, a retry from outside would fail the same way.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The mutation, like `internal.example.myMutation`.
   * @param fnArgs Its arguments.
   * @param options Its `onComplete`, and when to run it (`runAt` or `runAfter`).
   * @returns The job's id.
   */
  async enqueueMutation<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"mutation", FunctionVisibility, Args, NoInfer<ReturnType>>,
    fnArgs: Args,
    options?: EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId> {
    return enqueue(this.component, ctx, "mutation", fn, fnArgs, { ...this.options, ...options });
  }

  /**
   * Enqueue a mutation once per item of `argsArray`. Each runs on its own, and `onComplete` is called for each.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The mutation, like `internal.example.myMutation`.
   * @param argsArray The arguments of each run.
   * @param options Their `onComplete`, and when to run them (`runAt` or `runAfter`).
   * @returns The jobs' ids, in the order of `argsArray`.
   */
  async enqueueMutationBatch<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"mutation", FunctionVisibility, Args, NoInfer<ReturnType>>,
    argsArray: Array<Args>,
    options?: EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId[]> {
    return enqueueBatch(this.component, ctx, "mutation", fn, argsArray, { ...this.options, ...options });
  }

  // Convex's doc says the query runs in a mutation; since 0.4.9 it runs from an action (STUDY-199 §2.3). This one
  // says what both do.
  /**
   * Enqueue a query: seldom what you want, but useful in workflows. Its result goes to `onComplete`.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The query, like `internal.example.myQuery`.
   * @param fnArgs Its arguments.
   * @param options Its `onComplete`, and when to run it (`runAt` or `runAfter`).
   * @returns The job's id.
   */
  async enqueueQuery<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"query", FunctionVisibility, Args, NoInfer<ReturnType>>,
    fnArgs: Args,
    options?: EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId> {
    return enqueue(this.component, ctx, "query", fn, fnArgs, { ...this.options, ...options });
  }

  /**
   * Enqueue a query once per item of `argsArray`. Each runs on its own, and `onComplete` is called for each.
   *
   * @param ctx A mutation's or an action's context.
   * @param fn The query, like `internal.example.myQuery`.
   * @param argsArray The arguments of each run.
   * @param options Their `onComplete`, and when to run them (`runAt` or `runAfter`).
   * @returns The jobs' ids, in the order of `argsArray`.
   */
  async enqueueQueryBatch<Args extends DefaultFunctionArgs, Context, ReturnType>(
    ctx: MutationCtx | ActionCtx,
    fn: FunctionReference<"query", FunctionVisibility, Args, NoInfer<ReturnType>>,
    argsArray: Array<Args>,
    options?: EnqueueOptions<Context, ReturnType>,
  ): Promise<WorkId[]> {
    return enqueueBatch(this.component, ctx, "query", fn, argsArray, { ...this.options, ...options });
  }

  /**
   * Cancel a job. One not started yet never starts, and ends as `canceled`; one running finishes its attempt, and is
   * not retried.
   *
   * @param ctx A mutation's or an action's context.
   * @param id The job's id.
   */
  async cancel(ctx: MutationCtx | ActionCtx, id: WorkId): Promise<void> {
    await runMutation(ctx, this.component.lib.cancel, { id, logLevel: this.options.logLevel });
  }

  /**
   * Cancel every job, as {@link cancel} does, a page of `limit` (64 by default) at a time.
   *
   * @param ctx A mutation's or an action's context.
   */
  async cancelAll(ctx: MutationCtx | ActionCtx, options?: { limit?: number }): Promise<void> {
    await runMutation(ctx, this.component.lib.cancelAll, { logLevel: this.options.logLevel, ...options });
  }

  /**
   * Where a job is.
   *
   * @param ctx A query's, a mutation's or an action's context.
   * @param id The job's id.
   * @returns One of:
   * - `{ state: "pending", previousAttempts: number }`, waiting to start or to retry;
   * - `{ state: "running", previousAttempts: number }`;
   * - `{ state: "finished" }`, also for an id the pool no longer knows.
   */
  async status(ctx: QueryCtx | MutationCtx | ActionCtx, id: WorkId): Promise<Status> {
    return (await runQuery(ctx, this.component.lib.status, { id })) as Status;
  }

  /**
   * Where each of several jobs is, as {@link status} says.
   *
   * @param ctx A query's, a mutation's or an action's context.
   * @param ids The jobs' ids.
   * @returns Their statuses, in the order of `ids`.
   */
  async statusBatch(ctx: QueryCtx | MutationCtx | ActionCtx, ids: WorkId[]): Promise<Status[]> {
    return (await runQuery(ctx, this.component.lib.statusBatch, { ids })) as Status[];
  }

  /**
   * Define the mutation to run when a job ends, to pass as `onComplete` to `enqueue*`:
   * ```ts
   * export const myOnComplete = pool.defineOnComplete({
   *   context: v.literal("myContextValue"), // optional
   *   handler: async (ctx, { workId, context, result }) => {
   *     // ... use the result
   *   },
   * });
   *
   * // elsewhere:
   * const workId = await pool.enqueueAction(ctx, internal.foo.bar, { ... }, {
   *   onComplete: internal.foo.myOnComplete,
   * });
   * ```
   */
  defineOnComplete<
    DataModel extends GenericDataModel,
    // biome-ignore lint/suspicious/noExplicitAny: any context validator
    VContext extends Validator<any, any> = VAny<any, "optional">,
    // biome-ignore lint/suspicious/noExplicitAny: any return value validator
    VReturnValue extends Validator<any, any> = VAny<any, "optional">,
  >({
    context,
    handler,
    returnValue,
  }: {
    context?: VContext;
    handler: (
      ctx: GenericMutationCtx<DataModel>,
      args: { workId: WorkId; context: Infer<VContext>; result: RunResult<Infer<VReturnValue>> },
    ) => Promise<void>;
    returnValue?: VReturnValue;
  }): RegisteredMutation<"internal", OnCompleteArgs<Infer<VContext>, Infer<VReturnValue>>, null> {
    return internalMutationGeneric({
      args: vOnCompleteArgs(context, returnValue),
      handler: handler as never,
    }) as unknown as RegisteredMutation<"internal", OnCompleteArgs<Infer<VContext>, Infer<VReturnValue>>, null>;
  }
}

/**
 * The arguments of an `onComplete` mutation:
 * ```ts
 * export const myOnComplete = internalMutation({
 *   args: vOnCompleteArgs(v.string()),
 *   handler: async (ctx, { workId, context, result }) => {
 *     // `context` is checked to be a string
 *   },
 * });
 * ```
 * @param context The context's validator; any value, or none, when omitted.
 * @param runResult The return value's validator; any value when omitted.
 */
export function vOnCompleteArgs<
  // biome-ignore lint/suspicious/noExplicitAny: any context validator
  VContext extends Validator<any, "required"> = VAny,
  // biome-ignore lint/suspicious/noExplicitAny: any return value validator
  VReturn extends Validator<any, "required"> = VAny,
>(context?: VContext, runResult?: VReturn) {
  return v.object({
    workId: vWorkId,
    context: (context ?? v.optional(v.any())) as VContext,
    result: vRunResult(runResult ?? (v.optional(v.any()) as unknown as VReturn)),
  });
}

/** Whether, and how, a failed action is retried. */
export type RetryOption = {
  /**
   * `false`: not retried. `true`: retried with the pool's default {@link RetryBehavior}. A behavior: retried with it.
   * Unset: as the pool's `retryActionsByDefault` says.
   */
  retry?: boolean | RetryBehavior;
};

/** A pool's options. */
export type WorkpoolOptions = {
  /**
   * How many jobs may run at once in this pool (at most 200; above 100 is warned about). 0 starts nothing new.
   */
  maxParallelism?: number;
  // Convex's doc says `status` updates it too; it does not (STUDY-199 §2.3).
  /**
   * How much the pool logs; sent, and stored, by each `enqueue*` and `cancel*`. `REPORT` (the default) logs warnings,
   * errors and a report each minute; `INFO` adds an event for each job started and completed, as JSON for a log
   * pipeline to parse; `DEBUG` adds timers and the loop's own steps.
   */
  logLevel?: LogLevel;
} & WorkpoolRetryOptions;

/** How a pool retries actions. */
export type WorkpoolRetryOptions = {
  /**
   * The retry behavior for actions enqueued with `retry: true`, or with no `retry` when `retryActionsByDefault` is
   * set. Setting it alone retries nothing. See {@link RetryBehavior}.
   */
  defaultRetryBehavior?: RetryBehavior;
  /** Whether a failed action is retried when its `retry` is unset; false by default. Only for idempotent actions. */
  retryActionsByDefault?: boolean;
};

/** Options for one enqueued job. */
export type EnqueueOptions<Context = unknown, ReturnValue = unknown> = {
  /**
   * The name logged for the function. By default, its path (`foo/bar:baz` for `api.foo.bar.baz`), or the handle when
   * a handle is given.
   */
  name?: string;
  /**
   * A mutation to run once the job succeeds, fails (with no retry left) or is canceled, with `{ workId, context,
   * result }`. Define it with `defineOnComplete`, or with `vOnCompleteArgs` as its `args`.
   */
  onComplete?: FunctionReference<"mutation", FunctionVisibility, OnCompleteArgs<Context, ReturnValue>> | null;
  /**
   * The results not to call `onComplete` for. Omitted or empty, it is called for every result. A failed attempt that
   * is retried never calls it.
   */
  onCompleteExcludeKinds?: readonly RunResult["kind"][];
  /** A value passed to `onComplete` as `context`, to carry data from here to there. */
  context?: Context;
} & (
  | {
      /** When to run (ms since the epoch); as soon as possible when unset. A job may start later than this. */
      runAt?: number;
      runAfter?: never;
    }
  | {
      /** How long from now to run, in ms; as soon as possible when unset. A job may start later than this. */
      runAfter?: number;
      runAt?: never;
    }
);

/** What an `onComplete` mutation is called with. */
export type OnCompleteArgs<Context = unknown, Returns = unknown> = {
  /** The job that ended. */
  workId: string;
  /** The `context` given when it was enqueued. */
  context: Context;
  /** How it ended. */
  result: RunResult<Returns>;
};

// The client's type and the component's agree.
void ({} as OnCompleteArgs satisfies SharedOnCompleteArgs);

function getRetryBehavior(
  defaultRetryBehavior: RetryBehavior | undefined,
  retryActionsByDefault: boolean | undefined,
  retryOverride: boolean | RetryBehavior | undefined,
): RetryBehavior | undefined {
  const defaultRetry = defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR;
  if (retryOverride === true) return defaultRetry;
  if (retryOverride === false) return undefined;
  return retryOverride ?? ((retryActionsByDefault ?? false) ? defaultRetry : undefined);
}

type ClientEnqueueOptions<Context, ReturnType> = EnqueueOptions<Context, ReturnType> &
  Partial<Config> & { retryBehavior?: RetryBehavior | undefined };

async function enqueueArgs<Context, ReturnType>(
  fn: FunctionReference<FunctionType, FunctionVisibility> | FunctionHandle<FunctionType, DefaultFunctionArgs>,
  opts: ClientEnqueueOptions<Context, ReturnType> | undefined,
) {
  // A handle is used as it is; a reference gets one made.
  const [fnHandle, fnName] =
    typeof fn === "string" && (fn as string).startsWith("function://")
      ? [fn as string, opts?.name ?? (fn as string)]
      : [
          await createFunctionHandle(fn as FunctionReference<FunctionType, FunctionVisibility>),
          opts?.name ?? safeFunctionName(fn as FunctionReference<FunctionType, FunctionVisibility>),
        ];
  return {
    fnHandle,
    fnName,
    onComplete: opts?.onComplete
      ? {
          fnHandle: await createFunctionHandle(opts.onComplete),
          context: opts.context,
          excludeKinds: opts.onCompleteExcludeKinds ? [...opts.onCompleteExcludeKinds] : undefined,
        }
      : undefined,
    runAt: getRunAt(opts),
    retryBehavior: opts?.retryBehavior,
    config: { logLevel: opts?.logLevel, maxParallelism: opts?.maxParallelism },
  } satisfies Omit<FunctionArgs<ComponentApi["lib"]["enqueue"]>, "fnArgs" | "fnType">;
}

function getRunAt(options: { runAt?: number; runAfter?: number } | undefined): number {
  if (options?.runAt !== undefined) return options.runAt;
  if (options?.runAfter !== undefined) return Date.now() + options.runAfter;
  return Date.now();
}

/** The most bytes of items sent in one `enqueueBatch` call. */
const MAX_BATCH_SIZE = 8_000_000;

/**
 * Enqueue a function of type `fnType` once per item of `fnArgsArray` on the pool `component`, as the `Workpool`
 * class's `enqueue*Batch` methods do, in as few calls as fit.
 */
export async function enqueueBatch<FnType extends FunctionType, Args extends DefaultFunctionArgs, ReturnType, Context>(
  component: WorkpoolComponent,
  ctx: MutationCtx | ActionCtx,
  fnType: FnType,
  fn: FunctionReference<FnType, FunctionVisibility, Args, NoInfer<ReturnType>>,
  fnArgsArray: Array<Args>,
  options: EnqueueOptions<Context, ReturnType> & {
    retryBehavior?: RetryBehavior | undefined;
    maxParallelism?: number | undefined;
    logLevel?: LogLevel | undefined;
  },
): Promise<WorkId[]> {
  const { config, ...defaults } = await enqueueArgs(fn, options as ClientEnqueueOptions<Context, ReturnType>);
  type Item = typeof defaults & { fnArgs: Args; fnType: FnType };
  const batches: Item[][] = [];
  let current: Item[] = [];
  let size = 0;
  for (const fnArgs of fnArgsArray) {
    const item: Item = { ...defaults, fnArgs, fnType };
    const itemSize = valueSize(item as unknown as Value);
    if (current.length > 0 && size + itemSize > MAX_BATCH_SIZE) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += itemSize;
  }
  if (current.length > 0) batches.push(current);

  const ids: WorkId[] = [];
  for (const items of batches) {
    const batch = await runMutation(ctx, component.lib.enqueueBatch, { items, config });
    ids.push(...(batch as WorkId[]));
  }
  return ids;
}

/** Enqueue a function of type `fnType` on the pool `component`, as the `Workpool` class's `enqueue*` methods do. */
export async function enqueue<FnType extends FunctionType, Args extends DefaultFunctionArgs, ReturnType, Context>(
  component: WorkpoolComponent,
  ctx: MutationCtx | ActionCtx,
  fnType: FnType,
  fn: FunctionReference<FnType, FunctionVisibility, Args, NoInfer<ReturnType>>,
  fnArgs: Args,
  options: EnqueueOptions<Context, ReturnType> & {
    retryBehavior?: RetryBehavior | undefined;
    maxParallelism?: number | undefined;
    logLevel?: LogLevel | undefined;
  },
): Promise<WorkId> {
  const id = await runMutation(ctx, component.lib.enqueue, {
    ...(await enqueueArgs(fn, options as ClientEnqueueOptions<Context, ReturnType>)),
    fnArgs,
    fnType,
  });
  return id as WorkId;
}

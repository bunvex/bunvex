// The batch worker's client (STUDY-196 §1.7), with the API of Convex's `@convex-dev/batch-worker` 0.3.6: `ping`,
// which makes the handles of the app's work query and worker mutation and hands them to `lib:ping`, and the
// validators and types the two functions are written with. `start`, `stop`, `kick`, `status`, `getCursor` and
// `setCursor` are called on the component directly (`components.batchWorker.lib.*`).
import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "@bunvex/server";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { BatchQueryArgs, BatchResult, Config, DefaultCursor, WorkerResult } from "../component/shared.ts";

export type { Config as WorkerConfig, Status as WorkerStatus } from "../component/shared.ts";
export {
  type BatchQueryArgs,
  type BatchResult,
  type DefaultCursor,
  defineBatchWorkerValidators,
  vDefaultCursor,
  type WorkerResult,
} from "../component/shared.ts";

type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
/**
 * The one call `ping` makes on a context, by reference. bunvex's contexts also take a function by its name (an
 * overload), and TypeScript cannot call an overloaded method through the union `MutationCtx | ActionCtx`.
 */
type RunMutation = {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: FunctionArgs<M>,
  ): Promise<unknown>;
};

/**
 * Create the worker, or refresh it, and make sure its loop runs. Call it right after inserting work: while the loop
 * runs it is a cheap no-op.
 *
 * - `workQuery` returns the next batch, or `idle`;
 * - `workerMutation` processes a batch and cleans up after it, and may return `{ debounceMs }` to slow the loop.
 *
 * Write both with {@link defineBatchWorkerValidators}; the cursor type comes from the work query's `cursor`.
 *
 * @example
 * ```ts
 * export const enqueue = mutation({
 *   args: { task: v.string() },
 *   handler: async (ctx, { task }) => {
 *     await ctx.db.insert("tasks", { task });
 *     await ping(ctx, components.batchWorker, {
 *       name: "tasks",
 *       workQuery: internal.tasks.getBatch,
 *       workerMutation: internal.tasks.processBatch,
 *     });
 *   },
 * });
 * ```
 */
export async function ping<Batch extends DefaultFunctionArgs, Cursor = DefaultCursor>(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: {
    /** The worker's name, also given to the work query as `args.name`. */
    name: string;
    /** Returns the next batch, or `idle`. */
    workQuery: FunctionReference<"query", "internal", BatchQueryArgs<Cursor>, BatchResult<Batch, NoInfer<Cursor>>>;
    /** Processes a batch the work query returned. */
    // biome-ignore lint/suspicious/noConfusingVoidType: a mutation that returns nothing is accepted, as in Convex's package
    workerMutation: FunctionReference<"mutation", "internal", Batch, WorkerResult<NoInfer<Cursor>> | void>;
    /** The loop's configuration. */
    config?: Partial<Config>;
  },
): Promise<void> {
  const [workQuery, workerMutation] = await Promise.all([
    createFunctionHandle(args.workQuery),
    createFunctionHandle(args.workerMutation),
  ]);
  await (ctx as unknown as RunMutation).runMutation(component.lib.ping, {
    name: args.name,
    workQuery,
    workerMutation,
    config: args.config ?? {},
  });
}

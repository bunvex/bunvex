// The worker's loop (STUDY-196 §1.4), as Convex's package runs it: one scheduled internal mutation per iteration,
// at most one live per worker (a run whose `generation` is not the stored one exits).
//
// 1. The work query runs at the transaction's start snapshot (`useStaleSnapshot`): it takes no read dependencies,
//    so inserts racing the loop do not make it retry.
// 2. A batch: the worker mutation runs in this same transaction, and the cursor (the mutation's, else the query's)
//    commits with it. The next run is after the mutation's `debounceMs`, or at once.
// 3. No batch: poll every `pollIntervalMs` until `cooldownMs` after the last work; then read the query again with a
//    dependency, in case a ping raced the snapshot; then wait for `timeoutMs`, or go idle.
//
// A query or mutation that throws fails this run and nothing reschedules it; the monitor restarts the loop.
import type { FunctionHandle } from "@bunvex/server";
import { type Value, v } from "@bunvex/values";
import { internalMutation, type MutationCtx } from "./functions";
import { continueRunning, getOrCreateWorkerState, getWorker, goIdle, scheduleWaiting } from "./kick";
import { type BatchQueryArgs, type BatchResult, RUNNING_THRESHOLD_MS, type WorkerResult } from "./shared";

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_COOLDOWN_MS = 2000;

type WorkQuery = FunctionHandle<"query", BatchQueryArgs<Value>, BatchResult<Value, Value>>;
// biome-ignore lint/suspicious/noExplicitAny: the batch is the app's, typed by its own validators
type WorkerMutation = FunctionHandle<"mutation", any, WorkerResult<Value>>;

export const loop = internalMutation({
  args: { name: v.string(), generation: v.int64() },
  handler: async (ctx, { name, generation }) => {
    const worker = await getWorker(ctx, name);
    const state = worker && (await getOrCreateWorkerState(ctx, worker));
    if (!worker || !state) {
      ctx.log.debug(`[loop] "${name}" worker not found or state missing`);
      return;
    }
    if (state.generation !== generation) {
      ctx.log.debug(`[loop] "${name}" superseded (gen ${generation} !== ${state.generation})`);
      return;
    }

    const now = Date.now();
    const queryArgs: BatchQueryArgs<Value> = {
      name,
      ...(state.cursor !== undefined ? { cursor: state.cursor } : {}),
    };
    const workQuery = worker.workQuery as unknown as WorkQuery;
    const result = await ctx.runQuery(workQuery, queryArgs, { useStaleSnapshot: true });

    if (result && "batch" in result) {
      const workerMutation = worker.workerMutation as unknown as WorkerMutation;
      const ret = await ctx.runMutation(workerMutation, result.batch);
      // The mutation knows how far the batch really got, so its cursor wins.
      const cursor = ret?.cursor !== undefined ? ret.cursor : result.cursor;
      await continueRunning(ctx, worker, ret?.debounceMs ?? 0, { lastWorkTs: now, cursor });
      return;
    }

    const pollIntervalMs = result.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (now < state.lastWorkTs + (result.cooldownMs ?? DEFAULT_COOLDOWN_MS)) {
      await continueRunning(ctx, worker, pollIntervalMs);
      return;
    }

    // Cooled down. Before waiting or going idle, read the query again with a dependency: a ping that raced the
    // snapshot read then conflicts with this run instead of being lost.
    if (await hasWork(ctx, workQuery, queryArgs)) {
      ctx.log.warn(`[loop] ${worker.name} snapshot query mismatch`);
      await continueRunning(ctx, worker, 0);
      return;
    }

    const timeoutMs = result?.kind === "idle" ? result.timeoutMs : undefined;
    if (timeoutMs != null) {
      if (timeoutMs <= RUNNING_THRESHOLD_MS || timeoutMs <= pollIntervalMs) {
        await continueRunning(ctx, worker, timeoutMs);
      } else {
        await scheduleWaiting(ctx, worker, timeoutMs);
      }
      return;
    }

    await goIdle(ctx, worker, state);
    ctx.log.debug(`[loop] "${name}" → idle`);
  },
});

/** The work query read as usual, taking dependencies: does it return a batch? */
async function hasWork(ctx: MutationCtx, workQuery: WorkQuery, args: BatchQueryArgs<Value>): Promise<boolean> {
  const result = await ctx.runQuery(workQuery, args);
  return !!result && "batch" in result;
}

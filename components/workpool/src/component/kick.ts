// Waking the loop (STUDY-199 §1.9): the pool has no loop of its own; the batch worker runs it, calling `loop:getBatch`
// for the next batch and `loop:run` to process it. Every enqueue, cancelation, completion and raise of
// `maxParallelism` pings it, which is a no-op while it runs. The ping never reads `internalState`, which the loop
// writes every iteration, so that callers do not conflict with it.
import { ping } from "@bunvex/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { MINUTE, WORKER_NAME } from "./shared";

/** Who pinged; kept for the logs' sake, as Convex's is, and unused. */
type KickSource = "enqueue" | "cancel" | "complete" | "retry" | "kick";

/** Make sure the batch worker's loop runs, with this pool's work query and worker mutation. */
export async function kickMainLoop(ctx: MutationCtx, _source: KickSource = "kick"): Promise<void> {
  await ping(ctx, components.batchWorker, {
    name: WORKER_NAME,
    workQuery: internal.loop.getBatch,
    workerMutation: internal.loop.run,
    // The monitor restarts a loop that died between iterations within about two minutes.
    config: { monitorLagMs: 2 * MINUTE },
  });
}

/** Stop the loop and start it again with its stored functions and config: for a loop that is stuck. */
export const forceKick = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.batchWorker.lib.stop, { name: WORKER_NAME });
    await ctx.runMutation(components.batchWorker.lib.start, { name: WORKER_NAME });
  },
});

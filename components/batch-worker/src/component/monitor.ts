// The liveness monitor (STUDY-196 §1.5), as Convex's package's. It is scheduled `monitorLagMs` behind the loop's
// next run and moved back as the loop keeps running, so it only fires when the loop missed a run:
//
// - a run still pending well past its time (the scheduler retrying it after system failures), unless stopped:
//   cancel it and run again now;
// - not `running`: nothing to watch, so it clears itself;
// - a pending run: it fired early, so it re-arms behind that run;
// - no live run: run again now.
import { v } from "@bunvex/values";
import { internalMutation } from "./functions";
import { cancelMonitor, continueRunning, ensureMonitored, getOrCreateWorkerState, getWorker } from "./kick";
import { STUCK_RUNNER_GRACE_MS } from "./shared";

export const monitor = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const worker = await getWorker(ctx, name);
    if (!worker) {
      ctx.log.debug(`[monitor] "${name}" not found, bailing`);
      return;
    }
    const state = await getOrCreateWorkerState(ctx, worker);
    const run = state.runnerId && (await ctx.db.system.get("_scheduled_functions", state.runnerId));
    const now = Date.now();

    // Checked before the status: a stuck run wedges a waiting worker as much as a running one (every ping is then a
    // no-op). `stop` cancels the run, so a stopped worker has none.
    if (
      run &&
      run.state.kind === "pending" &&
      run.scheduledTime <= now - STUCK_RUNNER_GRACE_MS &&
      worker.status.kind !== "stopped"
    ) {
      ctx.log.error(
        `[monitor] "${name}" loop stuck pending since ${new Date(run.scheduledTime).toISOString()} — restarting`,
      );
      ctx.log.event("restart", { name, stuck: true });
      await ctx.scheduler.cancel(run._id);
      await continueRunning(ctx, worker, 0);
      return;
    }

    if (worker.status.kind !== "running") {
      await cancelMonitor(ctx, state);
      ctx.log.debug(`[monitor] "${name}" ${worker.status.kind}, no-op`);
      return;
    }

    // Another mutation never sees a scheduled mutation in progress, so a pending run is a live loop.
    if (run && run.state.kind === "pending") {
      await ensureMonitored(ctx, worker, run.scheduledTime);
      return;
    }

    ctx.log.error(`[monitor] "${name}" loop is not running — restarting`);
    ctx.log.event("restart", { name });
    await continueRunning(ctx, worker, 0);
  },
});

// Starting, waking, stopping and scheduling a worker (STUDY-196 §1.2, §1.3), as Convex's package does:
//
// - `ping` creates the worker or refreshes its handles and config, and wakes it when idle;
// - `start` resumes a stopped worker; `stop` cancels its run and monitor; `kick` restarts it from any state;
// - every scheduled loop run carries a new `generation`, so a superseded run exits;
// - the monitor trails the loop's next run by `monitorLagMs` and is moved only when it is about to fire.
import type { Value } from "@bunvex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./functions";
import { type Config, DEFAULT_CONFIG, MONITOR_LAG_MS, MONITOR_REFRESH_WITHIN_MS, RUNNING_THRESHOLD_MS } from "./shared";

export function getWorker(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workers")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

/** The worker's state row, recreated (and the worker pointed at it) if it was deleted. */
export async function getOrCreateWorkerState(ctx: MutationCtx, worker: Doc<"workers">) {
  const state = await ctx.db.get("workerState", worker.stateId);
  if (state) return state;
  worker.stateId = await ctx.db.insert("workerState", { generation: 0n, lastWorkTs: 0 });
  await ctx.db.patch("workers", worker._id, { stateId: worker.stateId });
  return (await ctx.db.get("workerState", worker.stateId))!;
}

/**
 * Create the worker, or refresh its handles and config, and make sure its loop runs. Called after inserting work:
 * while the loop runs it only reads the `workers` row.
 */
export async function ping(
  ctx: MutationCtx,
  args: { name: string; workQuery: string; workerMutation: string; config?: Partial<Config> | undefined },
): Promise<void> {
  const worker = await getWorker(ctx, args.name);
  if (!worker) {
    const stateId = await ctx.db.insert("workerState", { generation: 0n, lastWorkTs: 0 });
    const workerId = await ctx.db.insert("workers", {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config: args.config ?? {},
      status: { kind: "running" },
      stateId,
    });
    const created = (await ctx.db.get("workers", workerId))!;
    await scheduleLoopRun(ctx, created, { delayMs: args.config?.debounceMs ?? DEFAULT_CONFIG.debounceMs });
    return;
  }

  const configChanged =
    args.config !== undefined &&
    (args.config.debounceMs !== worker.config.debounceMs || args.config.monitorLagMs !== worker.config.monitorLagMs);
  if (args.workQuery !== worker.workQuery || args.workerMutation !== worker.workerMutation || configChanged) {
    worker.workQuery = args.workQuery;
    worker.workerMutation = args.workerMutation;
    if (args.config) worker.config = args.config;
    await ctx.db.replace("workers", worker._id, worker);
  }
  if (worker.status.kind !== "idle") {
    ctx.log.debug(`[ping] "${worker.name}" ${worker.status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

/** Resume a stopped worker with its stored handles and config. Nothing for a worker never pinged. */
export async function start(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  if (worker.status.kind !== "stopped") {
    ctx.log.debug(`[start] "${worker.name}" ${worker.status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

/**
 * Restart a wedged worker from any state, stopped included: cancel what is scheduled, then schedule a run now and a
 * fresh monitor. For when its scheduled functions were cancelled from the dashboard.
 */
export async function kick(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getOrCreateWorkerState(ctx, worker);
  if (state.runnerId) await cancelIfPending(ctx, state.runnerId);
  // Forget the monitor, so the run below arms a new one even if the old time still looks fine.
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  await scheduleLoopRun(ctx, worker, { delayMs: 0 });
}

/** Cancel the run and the monitor, and mark the worker stopped. Only `start` resumes it. */
export async function stop(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getOrCreateWorkerState(ctx, worker);
  if (state.runnerId) {
    await cancelIfPending(ctx, state.runnerId);
    await ctx.db.patch("workerState", state._id, { runnerId: undefined, generation: state.generation + 1n });
  }
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "stopped" } });
}

/**
 * Mark the worker running and have a run within its debounce window. A pending run due sooner than a new one would
 * be is kept; otherwise it is replaced by one `debounceMs` from now.
 */
async function wake(ctx: MutationCtx, worker: Doc<"workers">): Promise<void> {
  const state = await getOrCreateWorkerState(ctx, worker);
  const now = Date.now();
  const pending = state.runnerId && (await ctx.db.system.get("_scheduled_functions", state.runnerId));
  const delayMs = worker.config.debounceMs ?? DEFAULT_CONFIG.debounceMs;
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  if (pending?.state.kind === "pending" && pending.scheduledTime < now + Math.max(delayMs, RUNNING_THRESHOLD_MS)) {
    ctx.log.debug(`[wake] "${worker.name}" already scheduled to run sooner — keeping it`);
    // The kept run starts a cooldown window of its own.
    await ctx.db.patch("workerState", state._id, { lastWorkTs: Math.max(state.lastWorkTs, pending.scheduledTime) });
    return;
  }
  ctx.log.debug(`[wake] "${worker.name}" interrupting wait`);
  if (pending) await cancelIfPending(ctx, pending._id);
  await scheduleLoopRun(ctx, worker, { delayMs, lastWorkTs: now + delayMs });
}

/** Run the loop again after `delayMs`, as `running`. Entering `running` starts a new cooldown window. */
export async function continueRunning(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number,
  opts?: { lastWorkTs?: number | undefined; cursor?: Value | undefined },
): Promise<void> {
  let lastWorkTs = opts?.lastWorkTs;
  if (worker.status.kind !== "running") {
    await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
    lastWorkTs = Math.max(lastWorkTs ?? 0, Date.now() + delayMs);
  }
  await scheduleLoopRun(ctx, worker, { delayMs, lastWorkTs, cursor: opts?.cursor });
}

/** Wait `timeoutMs` as `idle`: a ping may interrupt the wait. */
export async function scheduleWaiting(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  timeoutMs: number,
  lastWorkTs?: number,
): Promise<void> {
  await scheduleLoopRun(ctx, worker, { delayMs: timeoutMs, lastWorkTs });
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

/** Stop looping until a ping: a new generation, no run, no monitor, `idle`. */
export async function goIdle(ctx: MutationCtx, worker: Doc<"workers">, state: Doc<"workerState">): Promise<void> {
  await ctx.db.patch("workerState", state._id, { generation: state.generation + 1n, runnerId: undefined });
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

async function scheduleLoopRun(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  opts: { delayMs: number; lastWorkTs?: number | undefined; cursor?: Value | undefined },
): Promise<void> {
  const state = await getOrCreateWorkerState(ctx, worker);
  const generation = state.generation + 1n;
  const runnerId = await ctx.scheduler.runAfter(opts.delayMs, internal.loop.loop, { name: worker.name, generation });
  // One patch per iteration; an undefined `lastWorkTs` or cursor leaves the stored one.
  await ctx.db.patch("workerState", state._id, {
    generation,
    runnerId,
    ...(opts.lastWorkTs !== undefined ? { lastWorkTs: opts.lastWorkTs } : {}),
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
  });
  await ensureMonitored(ctx, worker, Date.now() + opts.delayMs);
}

/**
 * Keep the monitor `monitorLagMs` (at least 10 s) behind the loop's next run. It is rescheduled only when missing
 * or about to fire, so a busy worker moves it about once a lag rather than every iteration.
 */
export async function ensureMonitored(ctx: MutationCtx, worker: Doc<"workers">, loopRunAtMs: number): Promise<void> {
  const state = await ctx.db.get("workerState", worker.stateId);
  if (!state) return;
  const lag = Math.max(MONITOR_REFRESH_WITHIN_MS, worker.config.monitorLagMs ?? MONITOR_LAG_MS);
  const now = Date.now();
  // A short lag refreshes within half of itself.
  const refreshWithin = Math.min(lag / 2, MONITOR_REFRESH_WITHIN_MS);
  const dueSoon = state.monitorRunAtMs == null || state.monitorRunAtMs <= now + refreshWithin;
  if (state.monitorId && !dueSoon) return;

  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  // Never in the past, even behind a stuck run's old time.
  const runAt = Math.max(loopRunAtMs, now) + lag;
  const monitorId = await ctx.scheduler.runAt(runAt, internal.monitor.monitor, { name: worker.name });
  await ctx.db.patch("workerState", worker.stateId, { monitorId, monitorRunAtMs: runAt });
}

export async function cancelMonitor(ctx: MutationCtx, state: Doc<"workerState">): Promise<void> {
  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  if (state.monitorId || state.monitorRunAtMs != null) {
    await ctx.db.patch("workerState", state._id, { monitorId: undefined, monitorRunAtMs: undefined });
  }
}

async function cancelIfPending(ctx: MutationCtx, id: Id<"_scheduled_functions">): Promise<void> {
  const job = await ctx.db.system.get("_scheduled_functions", id);
  if (job?.state.kind === "pending") await ctx.scheduler.cancel(id);
}

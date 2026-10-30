// The pool's public functions (STUDY-199 §1.7, §1.8), with the paths, validators and behaviour of Convex's workpool
// 0.4.14: `enqueue` and `enqueueBatch` write a `work` row and a `pendingStart` (large arguments and contexts in
// `payload`); `cancel` and `cancelAll` queue a `pendingCancelation` for the loop; `status` and `statusBatch` read
// where a job is. Each write pings the loop. Validation fails a call before anything is written.
import type { WithoutSystemFields } from "@bunvex/server";
import { type ObjectType, v, valueSize } from "@bunvex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, type QueryCtx, query } from "./_generated/server";
import { getOrUpdateGlobals } from "./config";
import { kickMainLoop } from "./kick";
import { createLogger, type Logger, type LogLevel, logLevel } from "./logging";
import {
  boundScheduledTime,
  fnType,
  getCurrentSegment,
  max,
  retryBehavior,
  status as statusValidator,
  toSegment,
  vConfig,
  vOnCompleteFnContext,
} from "./shared";
import { recordEnqueued } from "./stats";

/** Arguments or a context this large go to a `payload` row. */
const INLINE_METADATA_THRESHOLD = 8_000;
/** Arguments or a context larger than this are refused: below the 1 MiB document limit, with room to spare. */
const MAX_DOC_SIZE = 1_000_000;
/** The size of `{ args: null, context: null }`, counted in `payloadSize`. */
const PAYLOAD_DOC_OVERHEAD = 78;

const itemArgs = {
  fnHandle: v.string(),
  fnName: v.string(),
  fnArgs: v.any(),
  fnType,
  runAt: v.number(),
  onComplete: v.optional(vOnCompleteFnContext),
  retryBehavior: v.optional(retryBehavior),
};

export const enqueue = mutation({
  args: { ...itemArgs, config: vConfig.partial() },
  returns: v.id("work"),
  handler: async (ctx, { config, ...item }) => {
    const globals = await getOrUpdateGlobals(ctx, config);
    const console = createLogger(globals.logLevel);
    await kickMainLoop(ctx, "enqueue");
    return await enqueueHandler(ctx, console, item);
  },
});

async function enqueueHandler(
  ctx: MutationCtx,
  console: Logger,
  { runAt, ...item }: ObjectType<typeof itemArgs>,
): Promise<Id<"work">> {
  runAt = boundScheduledTime(runAt, console);

  const argsSize = valueSize(item.fnArgs);
  if (argsSize > MAX_DOC_SIZE) {
    throw new Error(
      `Function arguments for function ${item.fnName} too large: ${argsSize} bytes (max: ${MAX_DOC_SIZE} bytes)`,
    );
  }
  const context = item.onComplete?.context;
  let contextSize = 0;
  if (context !== undefined) {
    contextSize = valueSize(context);
    if (contextSize > MAX_DOC_SIZE) {
      throw new Error(
        `OnComplete context for function ${item.fnName} too large: ${contextSize} bytes (max: ${MAX_DOC_SIZE} bytes)`,
      );
    }
  }

  const work: WithoutSystemFields<Doc<"work">> = { ...item, attempts: 0 };
  if (argsSize >= INLINE_METADATA_THRESHOLD) {
    // The arguments move to `payload`, and the context with them when it is large too.
    const payload: { args: Record<string, unknown>; context?: unknown } = { args: item.fnArgs };
    work.payloadSize = argsSize + PAYLOAD_DOC_OVERHEAD;
    delete work.fnArgs;
    if (contextSize >= INLINE_METADATA_THRESHOLD) {
      payload.context = context;
      work.payloadSize += contextSize;
      delete work.onComplete!.context;
    }
    work.payloadId = await ctx.db.insert("payload", payload);
  } else if (argsSize + contextSize >= INLINE_METADATA_THRESHOLD) {
    // Small arguments, but not with the context: the context alone moves.
    work.payloadId = await ctx.db.insert("payload", { context });
    delete work.onComplete!.context;
    work.payloadSize = contextSize + PAYLOAD_DOC_OVERHEAD;
  }

  const workId = await ctx.db.insert("work", work);
  await ctx.db.insert("pendingStart", { workId, segment: max(toSegment(runAt), getCurrentSegment()) });
  recordEnqueued(console, { workId, fnName: item.fnName, runAt });
  return workId;
}

export const enqueueBatch = mutation({
  args: { items: v.array(v.object(itemArgs)), config: vConfig.partial() },
  returns: v.array(v.id("work")),
  handler: async (ctx, { config, items }) => {
    const globals = await getOrUpdateGlobals(ctx, config);
    const console = createLogger(globals.logLevel);
    await kickMainLoop(ctx, "enqueue");
    return Promise.all(items.map((item) => enqueueHandler(ctx, console, item)));
  },
});

export const cancel = mutation({
  args: { id: v.id("work"), logLevel: v.optional(logLevel) },
  handler: async (ctx, { id, logLevel }) => {
    const globals = await getOrUpdateGlobals(ctx, { logLevel });
    if (!(await shouldCancelWorkItem(ctx, id, globals.logLevel))) return;
    await kickMainLoop(ctx, "cancel");
    await ctx.db.insert("pendingCancelation", { workId: id, segment: getCurrentSegment() });
  },
});

/** `cancelAll`'s page when no `limit` is given. */
const PAGE_SIZE = 64;

export const cancelAll = mutation({
  args: { logLevel: v.optional(logLevel), before: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { logLevel, before, limit }) => {
    const until = before ?? Date.now();
    const pageSize = limit ?? PAGE_SIZE;
    // Newest first, up to and including `until`: the next page reads the last row of this one again.
    const page = await ctx.db
      .query("work")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", until))
      .order("desc")
      .take(pageSize);
    const globals = await getOrUpdateGlobals(ctx, { logLevel });
    const cancels = await Promise.all(page.map(({ _id }) => shouldCancelWorkItem(ctx, _id, globals.logLevel)));
    if (cancels.some(Boolean)) await kickMainLoop(ctx, "cancel");
    const segment = getCurrentSegment();
    await Promise.all(
      page.map(({ _id }, i) => (cancels[i] ? ctx.db.insert("pendingCancelation", { workId: _id, segment }) : null)),
    );
    if (page.length === pageSize) {
      // With `limit: 0` there is no last row, and this throws, as Convex's does.
      await ctx.scheduler.runAfter(0, api.lib.cancelAll, {
        logLevel,
        before: (page[page.length - 1] as Doc<"work">)._creationTime,
        limit: pageSize,
      });
    }
  },
});

export const status = query({
  args: { id: v.id("work") },
  returns: statusValidator,
  handler: statusHandler,
});

async function statusHandler(ctx: QueryCtx, { id }: { id: Id<"work"> }) {
  const work = await ctx.db.get("work", id);
  if (!work) return { state: "finished" } as const;
  const pendingStart = await ctx.db
    .query("pendingStart")
    .withIndex("workId", (q) => q.eq("workId", id))
    .unique();
  if (pendingStart) return { state: "pending", previousAttempts: work.attempts } as const;
  const pendingCompletion = await ctx.db
    .query("pendingCompletion")
    .withIndex("workId", (q) => q.eq("workId", id))
    .unique();
  if (pendingCompletion?.retry) return { state: "pending", previousAttempts: work.attempts } as const;
  // Running, or about to be canceled: a pending cancelation is not consulted.
  return { state: "running", previousAttempts: work.attempts } as const;
}

export const statusBatch = query({
  args: { ids: v.array(v.id("work")) },
  returns: v.array(statusValidator),
  handler: async (ctx, { ids }) => Promise.all(ids.map((id) => statusHandler(ctx, { id }))),
});

/** Whether a cancelation should be queued: not for a job that is gone or already being canceled. */
async function shouldCancelWorkItem(ctx: MutationCtx, workId: Id<"work">, level: LogLevel): Promise<boolean> {
  const console = createLogger(level);
  const work = await ctx.db.get("work", workId);
  if (!work) {
    console.warn(`[cancel] work ${workId} doesn't exist`);
    return false;
  }
  const pending = await ctx.db
    .query("pendingCancelation")
    .withIndex("workId", (q) => q.eq("workId", workId))
    .unique();
  if (pending) {
    console.warn(`[cancel] work ${workId} has already been canceled`);
    return false;
  }
  return true;
}

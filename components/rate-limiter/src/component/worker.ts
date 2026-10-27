// The asynchronous mode's worker (STUDY-197 §1.5), on the child batch worker, named `rateLimiter` as in Convex's
// package:
//
// - the work query reads the queued updates from the cursor, up to 1024 or a quarter of the transaction's read
//   budget, whichever comes first, and returns the last commit timestamp as the cursor;
// - the worker mutation folds them, per name and key, into shard 0: a reset clears the state, a consumption applies
//   the math at its own time (never earlier than the state's), then writes each state and deletes the updates.
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import { v } from "@bunvex/values";
import { calculateRateLimit, SINGLETON_SHARD, vPendingUpdate } from "../shared";
import { components, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { getShard } from "./internal";

export const WORKER_NAME = "rateLimiter";
export const BATCH_SIZE = 1024;
/** The share of the read limit the work query may use, leaving the rest to the worker mutation. */
export const READ_BUDGET_FRACTION = 0.25;

const worker = {
  name: WORKER_NAME,
  workQuery: internal.worker.getBatch,
  workerMutation: internal.worker.processBatch,
};

/** Wake the worker to drain what was just queued. */
export async function pingWorker(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, worker);
}

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } = defineBatchWorkerValidators({
  batch: { updates: v.array(v.object({ id: v.id("pendingUpdates"), update: vPendingUpdate })) },
});

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const { used, remaining } = (await ctx.meta.getTransactionMetrics()).bytesRead;
    const readBudget = (used + remaining) * READ_BUDGET_FRACTION;
    const docs: Doc<"pendingUpdates">[] = [];
    const queued = ctx.db.query("pendingUpdates").withIndex("updatedAt", (q) => q.gte("updatedAt", cursor ?? 0n));
    for await (const doc of queued) {
      docs.push(doc);
      if (docs.length >= BATCH_SIZE) break;
      if ((await ctx.meta.getTransactionMetrics()).bytesRead.used >= readBudget) break;
    }
    if (docs.length === 0) return { kind: "idle" as const };
    return {
      kind: "work" as const,
      batch: { updates: docs.map((doc) => ({ id: doc._id, update: doc.update })) },
      cursor: docs[docs.length - 1]!.updatedAt,
    };
  },
});

type LimitState = {
  name: string;
  key: string | undefined;
  existing: Doc<"rateLimits"> | null;
  next: { value: number; ts: number } | null;
};

export const processBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { updates }) => {
    const states = new Map<string, LimitState>();
    for (const { update } of updates) {
      const state = await loadLimitState(ctx, states, update.name, update.key);
      switch (update.kind) {
        case "reset":
          state.next = null;
          break;
        case "consume": {
          // At the update's own time, so the limit's capacity is used as fully as it can be; never earlier than the
          // state (updates may come out of order, or after a reset).
          const now = Math.max(update.ts, state.next?.ts ?? update.ts, state.existing?.ts ?? update.ts);
          const { value, ts } = calculateRateLimit(state.next, update.config, now, update.count);
          state.next = { value, ts };
          break;
        }
        default:
          update satisfies never;
          throw new Error(`Unhandled pending update: ${JSON.stringify(update)}`);
      }
    }
    await Promise.all([
      ...Array.from(states.values(), (state) => writeLimitState(ctx, state)),
      ...updates.map(({ id }) => ctx.db.delete("pendingUpdates", id)),
    ]);
    return null;
  },
});

async function loadLimitState(
  ctx: MutationCtx,
  states: Map<string, LimitState>,
  name: string,
  key: string | undefined,
): Promise<LimitState> {
  const id = JSON.stringify([name, key ?? null]);
  const cached = states.get(id);
  if (cached) return cached;
  const existing = await getShard(ctx.db, name, key, SINGLETON_SHARD);
  const state: LimitState = { name, key, existing, next: existing ? { value: existing.value, ts: existing.ts } : null };
  states.set(id, state);
  return state;
}

async function writeLimitState(ctx: MutationCtx, state: LimitState) {
  if (state.next === null) {
    if (state.existing) await ctx.db.delete("rateLimits", state.existing._id);
  } else if (state.existing) {
    await ctx.db.patch("rateLimits", state.existing._id, { value: state.next.value, ts: state.next.ts });
  } else {
    await ctx.db.insert("rateLimits", {
      name: state.name,
      key: state.key,
      shard: SINGLETON_SHARD,
      value: state.next.value,
      ts: state.next.ts,
    });
  }
}

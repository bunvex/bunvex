// Rate-limited LLM batches: requests queue up in `llmRequests`, the `llm` worker takes them five at a time and
// spends their estimated input tokens from one `@bunvex/rate-limiter` budget, then schedules the (stubbed) model call
// for when that budget allows it. The call's output tokens come out of the same budget once they are known, so a
// batch that wrote a lot pushes the next ones back.
//
// The budget is tiny on purpose (300 tokens per 5 s, at most 300 at once), so a few clicks are enough to watch the
// batches wait their turn. A real one follows the provider's tokens-per-minute limit.
import { defineBatchWorkerValidators, ping } from "@bunvex/batch-worker";
import { RateLimiter, SECOND } from "@bunvex/rate-limiter";
import { v } from "@bunvex/values";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server.js";

const WORKER = "llm";
/** Small, so a burst of requests drains in several batches instead of one. */
const BATCH_SIZE = 5;

const rateLimiter = new RateLimiter(components.rateLimiter, {
  /** Every token, input and output, comes out of this one budget. */
  llmTokens: { kind: "token bucket", rate: 300, period: 5 * SECOND, capacity: 300 },
});

const worker = {
  name: WORKER,
  workQuery: internal.rateLimited.getBatch,
  workerMutation: internal.rateLimited.startBatch,
  // A second's wait before the first batch lets a burst of requests travel together.
  config: { debounceMs: 1000 },
};

/** Queue a prompt; `inputTokens` is what the caller expects it to cost. */
export const submitRequest = mutation({
  args: { prompt: v.string(), inputTokens: v.number() },
  handler: async (ctx, { prompt, inputTokens }) => {
    await ctx.db.insert("llmRequests", { prompt, inputTokens, state: "pending", updatedAt: ctx.db.vars.commitTs });
    await ping(ctx, components.batchWorker, worker);
  },
});

// The batch carries the prompts, so the action never reads them back.
const vRequest = v.object({ id: v.id("llmRequests"), prompt: v.string(), inputTokens: v.number() });
const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } = defineBatchWorkerValidators({
  batch: { requests: v.array(vRequest) },
});

/** The next pending requests from the cursor on, or `idle`. */
export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    // Claimed requests move out of the pending range, leaving tombstones behind: the cursor skips them. A real app
    // would also retry `started` requests whose call never reported back; this one leaves that out.
    const pending = await ctx.db
      .query("llmRequests")
      .withIndex("state_updatedAt", (q) => q.eq("state", "pending").gte("updatedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (pending.length === 0) return { kind: "idle" as const };
    return {
      kind: "work" as const,
      batch: { requests: pending.map((r) => ({ id: r._id, prompt: r.prompt, inputTokens: r.inputTokens })) },
      cursor: pending.at(-1)!.updatedAt,
    };
  },
});

/**
 * Spend the batch's input tokens, claim its requests, and schedule the call for when the budget allows it. The
 * worker waits as long before the next batch.
 */
export const startBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { requests }) => {
    const inputTokens = requests.reduce((total, r) => total + r.inputTokens, 0);
    // `reserve: true` never refuses: it borrows from the budget to come, and `retryAfter` says when it is repaid.
    const { retryAfter } = await rateLimiter.limit(ctx, "llmTokens", { count: inputTokens, reserve: true });
    const startedAt = Date.now();
    for (const { id } of requests) {
      await ctx.db.patch("llmRequests", id, { state: "started", startedAt, updatedAt: ctx.db.vars.commitTs });
    }
    await ctx.scheduler.runAfter(retryAfter ?? 0, internal.rateLimited.runBatch, {
      prompts: requests.map(({ id, prompt }) => ({ id, prompt })),
    });
    return retryAfter ? { debounceMs: retryAfter } : null;
  },
});

/** The model call, the one step that has to be an action. Stubbed: each answer echoes its prompt. */
export const runBatch = internalAction({
  args: { prompts: v.array(v.object({ id: v.id("llmRequests"), prompt: v.string() })) },
  handler: async (ctx, { prompts }) => {
    // A real app sends the prompts to its provider's batch API here and waits for the answers.
    const responses = prompts.map(({ id, prompt }) => ({
      id,
      response: `Echo: ${prompt}`,
      outputTokens: prompt.length,
    }));
    await ctx.runMutation(internal.rateLimited.finishBatch, { responses });
  },
});

/** Store the answers, then spend the output tokens they cost. */
export const finishBatch = internalMutation({
  args: {
    responses: v.array(v.object({ id: v.id("llmRequests"), response: v.string(), outputTokens: v.number() })),
  },
  handler: async (ctx, { responses }) => {
    let outputTokens = 0;
    for (const r of responses) {
      outputTokens += r.outputTokens;
      await ctx.db.patch("llmRequests", r.id, {
        state: "finished",
        response: r.response,
        outputTokens: r.outputTokens,
        updatedAt: ctx.db.vars.commitTs,
      });
    }
    await rateLimiter.limit(ctx, "llmTokens", { count: outputTokens, reserve: true });
  },
});

/** The latest 50 requests, newest first. */
export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    const requests = await ctx.db.query("llmRequests").order("desc").take(50);
    return requests.map((r) => ({ prompt: r.prompt, state: r.state, response: r.response ?? null }));
  },
});

/** How many requests are queued (counted from the worker's cursor), in flight, and done. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const inState = async (state: "started" | "finished") =>
      (
        await ctx.db
          .query("llmRequests")
          .withIndex("state_updatedAt", (q) => q.eq("state", state))
          .take(500)
      ).length;
    const from = ((await ctx.runQuery(components.batchWorker.lib.getCursor, { name: WORKER })) ?? 0n) as bigint;
    const pending = (
      await ctx.db
        .query("llmRequests")
        .withIndex("state_updatedAt", (q) => q.eq("state", "pending").gte("updatedAt", from))
        .take(500)
    ).length;
    return { pending, started: await inState("started"), finished: await inState("finished") };
  },
});

export const workerStatus = query({
  args: {},
  handler: async (ctx) => ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});

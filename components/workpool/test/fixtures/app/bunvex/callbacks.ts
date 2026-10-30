// The app's side of upstream's client tests (`src/client/index.test.ts` of get-convex/workpool 0.4.14): the jobs
// (an action, a mutation and a query that succeed or fail on request), and the `onComplete` callbacks, which record
// what they get in `events`. Upstream counts the callback's calls with a `vi.fn` spy and holds a running action with
// a module-level promise in the test's file; the deployment runs these functions in a realm of its own (a separate
// copy of this module, shared by every call of one deployment), so the count and the gate live here, read and
// opened through functions.
import {
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
} from "@bunvex/server";
import { type ObjectType, v } from "@bunvex/values";
import { NonRetryableError, type OnCompleteArgs, vOnCompleteArgs, type WorkId } from "@bunvex/workpool";

const runArgs = {
  key: v.string(),
  fail: v.optional(v.boolean()),
  failures: v.optional(v.number()),
  nonRetryable: v.optional(v.boolean()),
  payload: v.optional(v.string()),
};
type RunArgs = ObjectType<typeof runArgs>;
type Context = { key: string; padding?: string; throw?: boolean };

// biome-ignore lint/suspicious/noExplicitAny: the app's data model is untyped here
type Ctx = any;

/** How many times a callback ran, its rolled-back runs included (upstream's spy). */
let callbackCalls = 0;
/** Held by `closeGate`, released by `openGate`: the action waits on it after recording its attempt. */
let gate: Promise<void> | undefined;
let openIt: (() => void) | undefined;

const attemptRef = makeFunctionReference<"mutation", { key: string }, number>("callbacks:attempt");

export const attempt = internalMutationGeneric({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx: Ctx, { key }) => {
    await ctx.db.insert("events", { key, kind: "attempt" });
    const events = await ctx.db
      .query("events")
      .withIndex("key", (q: Ctx) => q.eq("key", key))
      .collect();
    return events.filter((e: { kind: string }) => e.kind === "attempt").length;
  },
});

export const action = internalActionGeneric({
  args: runArgs,
  returns: v.string(),
  handler: async (ctx, args: RunArgs): Promise<string> => {
    const n = await ctx.runMutation(attemptRef, { key: args.key });
    await gate;
    if (args.fail || n <= (args.failures ?? 0)) {
      if (args.nonRetryable) throw new NonRetryableError("work failed");
      throw new Error("work failed");
    }
    return "action result";
  },
});

export const mutation = internalMutationGeneric({
  args: runArgs,
  returns: v.string(),
  handler: async (ctx: Ctx, args: RunArgs) => {
    await ctx.db.insert("events", { key: args.key, kind: "work" });
    if (args.fail) {
      if (args.nonRetryable) throw new NonRetryableError("work failed");
      throw new Error("work failed");
    }
    return "mutation result";
  },
});

export const query = internalQueryGeneric({
  args: runArgs,
  returns: v.string(),
  handler: async (_ctx, args: RunArgs) => {
    if (args.fail) {
      if (args.nonRetryable) throw new NonRetryableError("work failed");
      throw new Error("work failed");
    }
    return "query result";
  },
});

async function callback(ctx: Ctx, args: OnCompleteArgs<Context | undefined> & { workId: WorkId }) {
  callbackCalls++;
  await ctx.db.insert("events", {
    key: args.context?.key ?? "default",
    kind: "callback",
    workId: args.workId,
    context: args.context,
    result: args.result,
  });
  if (args.context?.throw) throw new Error("callback failed");
  return null;
}

export const complete = internalMutationGeneric({
  args: vOnCompleteArgs(v.object({ key: v.string(), padding: v.optional(v.string()), throw: v.optional(v.boolean()) })),
  returns: v.null(),
  handler: callback as never,
});

export const optionalComplete = internalMutationGeneric({
  args: vOnCompleteArgs(),
  returns: v.null(),
  handler: callback as never,
});

/** How many times a callback ran. A mutation: a query reading no table would be cached at its first answer. */
export const calls = internalMutationGeneric({ args: {}, handler: async () => callbackCalls });

/** Hold every action after its attempt is recorded, until `openGate`. */
export const closeGate = internalMutationGeneric({
  args: {},
  handler: async () => {
    gate = new Promise<void>((resolve) => {
      openIt = resolve;
    });
  },
});

export const openGate = internalMutationGeneric({
  args: {},
  handler: async () => {
    openIt?.();
    gate = undefined;
  },
});

/** The events recorded under `key`, in order. */
export const events = internalQueryGeneric({
  args: { key: v.string() },
  handler: async (ctx: Ctx, { key }) =>
    ctx.db
      .query("events")
      .withIndex("key", (q: Ctx) => q.eq("key", key))
      .collect(),
});

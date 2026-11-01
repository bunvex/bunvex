// Functions of the test app's own, not the component's: scheduled by the tests to give a scheduled function a real
// state (failed, canceled, pending) for recovery, and to run as jobs and callbacks.
import { internalActionGeneric, internalMutationGeneric, internalQueryGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

/** Fails with `message`. */
export const fail = internalMutationGeneric({
  args: { message: v.optional(v.string()) },
  handler: async (_ctx, { message }) => {
    throw new Error(message ?? "boom");
  },
});

/** Does nothing. */
export const noop = internalMutationGeneric({ args: {}, handler: async () => null });

/** Returns its argument. */
export const echoAction = internalActionGeneric({
  args: { value: v.any() },
  handler: async (_ctx, { value }) => value,
});

/** Returns its argument. */
export const echoQuery = internalQueryGeneric({ args: { value: v.any() }, handler: async (_ctx, { value }) => value });

/** What `complete` was called with, in order: kept in the deployment's realm, read through `calls`. */
const completions: unknown[] = [];

/** An `onComplete` callback that records its arguments. */
export const complete = internalMutationGeneric({
  args: { workId: v.string(), context: v.any(), result: v.any() },
  handler: async (_ctx, args) => {
    completions.push(args);
  },
});

/** The callback's calls so far. A mutation: a query reading no table would be cached at its first answer. */
export const calls = internalMutationGeneric({ args: {}, handler: async () => completions });

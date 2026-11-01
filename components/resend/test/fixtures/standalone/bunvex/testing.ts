// Functions of the test app's own, not the component's: an `onEmailEvent` callback that records what it gets, read
// back through `events` (the deployment runs it in a realm of its own).
import { internalMutationGeneric, mutationGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

const received: unknown[] = [];

/** An `onEmailEvent` callback: records its arguments. */
export const onEmailEvent = internalMutationGeneric({
  args: { id: v.string(), event: v.any() },
  handler: async (_ctx, args) => {
    received.push(args);
  },
});

/** What `onEmailEvent` received, in order (a mutation, so it is never a cached answer). */
export const events = mutationGeneric({ args: {}, handler: async () => received });

// The app of test/nested-errors.test.ts: functions that throw, and V8 actions that call them, uncaught or caught.
import { actionGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError } from "convex/values";

class FooError extends ConvexError<{ message: string; code: bigint }> {
  name = "FooError";
  constructor(message: string) {
    super({ message, code: 123n });
  }
}

export const queryApp = queryGeneric(async () => {
  throw new ConvexError("Boom boom bop");
});
export const queryPlainError = queryGeneric(async () => {
  throw new Error("Normal error");
});
export const querySubclass = queryGeneric(async () => {
  throw new FooError("Boom boom bop");
});
export const mutationApp = mutationGeneric(async () => {
  throw new ConvexError({ message: "Boom boom bop", code: 123n });
});
export const actionApp = actionGeneric(async () => {
  throw new ConvexError("Boom boom bop");
});

const refs: Record<string, ReturnType<typeof makeFunctionReference>> = {
  queryApp: makeFunctionReference<"query">("errors:queryApp"),
  queryPlainError: makeFunctionReference<"query">("errors:queryPlainError"),
  querySubclass: makeFunctionReference<"query">("errors:querySubclass"),
  mutationApp: makeFunctionReference<"mutation">("errors:mutationApp"),
  actionApp: makeFunctionReference<"action">("errors:actionApp"),
  nodeApp: makeFunctionReference<"action">("node:nodeApp"),
};
const call = (ctx: any, target: string) =>
  target.startsWith("query")
    ? ctx.runQuery(refs[target] as never)
    : target.startsWith("mutation")
      ? ctx.runMutation(refs[target] as never)
      : ctx.runAction(refs[target] as never);

/** Calls `target` and lets its error leave the action. */
export const callUncaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  await call(ctx, target);
});

/** Calls `target` and returns what the action caught. */
export const callCaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  try {
    await call(ctx, target);
    return null;
  } catch (e: any) {
    return { name: e.name, message: e.message, data: e.data === undefined ? "undefined" : e.data, stack: e.stack };
  }
});

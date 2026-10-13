"use node";
// The "use node" side of test/nested-errors.test.ts.
import { actionGeneric, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

export const nodeApp = actionGeneric(async () => {
  throw new ConvexError("Boom boom bop");
});

const refs: Record<string, ReturnType<typeof makeFunctionReference>> = {
  queryApp: makeFunctionReference<"query">("errors:queryApp"),
  querySubclass: makeFunctionReference<"query">("errors:querySubclass"),
  queryPlainError: makeFunctionReference<"query">("errors:queryPlainError"),
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

export const nodeCallUncaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  await call(ctx, target);
});

export const nodeCallCaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  try {
    await call(ctx, target);
    return null;
  } catch (e: any) {
    return { name: e.name, message: e.message, data: e.data === undefined ? "undefined" : e.data, stack: e.stack };
  }
});

// The app of test/run-missing.test.ts: an action and a mutation that call, schedule or take a handle of a function
// named by `target` (one that exists, or not, in the app or in its component), the error left uncaught or caught.
import {
  actionGeneric,
  componentsGeneric,
  createFunctionHandle,
  internalQueryGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

export const q = queryGeneric(async () => "q");
export const iq = internalQueryGeneric(async () => "iq");
export const m = mutationGeneric(async () => "m");
export const a = actionGeneric(async () => "a");

const components = componentsGeneric() as any;
const ref = (target: string): any => {
  if (target.startsWith("components."))
    return target
      .split(".")
      .slice(1)
      .reduce((r, k) => r[k], components);
  if (target.startsWith("function://")) return target;
  return makeFunctionReference(target);
};

/** What an error looks like to the code that caught it. */
export const seen = (e: any) => ({
  name: e?.name,
  message: e?.message,
  isError: e instanceof Error,
  ctor: e?.constructor?.name,
  data: e?.data === undefined ? "undefined" : e.data,
});

export async function run(ctx: any, op: string, target: string) {
  const r = ref(target);
  switch (op) {
    case "runQuery":
      return await ctx.runQuery(r, {});
    case "runMutation":
      return await ctx.runMutation(r, {});
    case "runAction":
      return await ctx.runAction(r, {});
    case "runAfter":
      await ctx.scheduler.runAfter(0, r, {});
      return "scheduled";
    case "handle":
      return await createFunctionHandle(r);
    case "handleQuery":
      return await ctx.runQuery(await createFunctionHandle(r), {});
  }
  throw new Error(`unknown op ${op}`);
}

type Probe = { op: string; target: string; caught: boolean };

export const inAction = actionGeneric(async (ctx, { op, target, caught }: Probe) => {
  if (!caught) return { value: await run(ctx, op, target) };
  try {
    return { value: await run(ctx, op, target) };
  } catch (e) {
    return { caught: seen(e) };
  }
});

export const inMutation = mutationGeneric(async (ctx, { op, target, caught }: Probe) => {
  if (!caught) return { value: await run(ctx, op, target) };
  try {
    return { value: await run(ctx, op, target) };
  } catch (e) {
    return { caught: seen(e) };
  }
});

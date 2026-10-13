// The app of test/value-errors.test.ts: functions that return, or pass on, a value that is not a supported value.
import { actionGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";

class Point {
  x = 1;
}
const make: Record<string, () => unknown> = {
  set: () => new Set(["hello", "world"]),
  map: () => new Map([["a", 1]]),
  fn: () => () => 1,
  instance: () => new Point(),
  nested: () => ({ a: [1, new Set([1])] }),
};

export const q = queryGeneric(async (_ctx, { kind }: { kind: string }) => make[kind]!());
export const m = mutationGeneric(async (_ctx, { kind }: { kind: string }) => make[kind]!());
export const a = actionGeneric(async (_ctx, { kind }: { kind: string }) => make[kind]!());
export const echo = queryGeneric(async (_ctx, args: Record<string, unknown>) => args);
export const insert = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.db.insert("items", { v: make[kind]!() } as never);
});
export const runQueryWith = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});
export const runQueryCaught = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  try {
    await ctx.runQuery(makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
    return null;
  } catch (e) {
    return {
      name: (e as Error).name,
      frames: ((e as Error).stack ?? "").split("\n").filter((l) => /^\s+at /.test(l)).length > 0,
    };
  }
});

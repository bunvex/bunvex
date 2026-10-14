"use node";
// The "use node" side of test/value-errors.test.ts.
import { actionGeneric, makeFunctionReference } from "convex/server";

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

export const a = actionGeneric(async (_ctx, { kind }: { kind: string }) => make[kind]!());
export const runQueryWith = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});

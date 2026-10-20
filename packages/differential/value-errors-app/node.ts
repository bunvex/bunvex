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
  setEmpty: () => new Set(),
  setOne: () => new Set([1]),
  setMany: () => new Set([1, "two", null, [3], { four: 4n }]),
  mapEmpty: () => new Map(),
  mapOne: () => new Map([["a", 1]]),
  mapMany: () =>
    new Map<unknown, unknown>([
      ["a", 1],
      [2, [true]],
      [null, { b: "c" }],
    ]),
  inObject: () => ({ x: 1, m: new Map([["k", 1]]) }),
  inArray: () => [0, [new Set(["s"])]],
  setOfSets: () => new Set([new Set([1]), new Map([[1, 2]])]),
};

export const a = actionGeneric(async (_ctx, { kind }: { kind: string }) => make[kind]!());
export const runQueryWith = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});

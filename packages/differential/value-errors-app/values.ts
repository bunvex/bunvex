// The app of test/value-errors.test.ts: functions that return, or pass on, a value that is not a supported value.
import { actionGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

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
export const schedule = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.scheduler.runAfter(0, makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});
export const patch = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  const id = await ctx.db.insert("items", {});
  await ctx.db.patch(id, { v: make[kind]!() } as never);
});
export const replace = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  const id = await ctx.db.insert("items", {});
  await ctx.db.replace(id, { v: make[kind]!() } as never);
});
export const runMutationWith = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runMutation(makeFunctionReference<"mutation">("values:m"), { v: make[kind]!() } as never);
});
export const scheduleFromAction = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.scheduler.runAfter(0, makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});
export const validated = queryGeneric({
  args: { kind: v.string() },
  returns: v.string(),
  handler: async (_ctx, { kind }) => make[kind]!() as never,
});
export const tooLarge = queryGeneric(async () => ["x".repeat(9000000), "y".repeat(9000000), new Set([1])] as never);
export const tooDeep = queryGeneric(async () => {
  let v: unknown = { s: new Set([1]) };
  for (let i = 0; i < 70; i++) v = { a: v };
  return v as never;
});
export const scheduleAt = mutationGeneric(async (ctx) => {
  const at = Date.now() + 60000;
  const id = await ctx.scheduler.runAt(new Date(at), makeFunctionReference<"query">("values:echo"), {});
  return (await ctx.db.system.get(id))!.scheduledTime === at;
});
export const echoValidated = queryGeneric({ args: { v: v.number() }, handler: async () => null });
export const runQueryFromMutation = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), { v: make[kind]!() } as never);
});
export const runValidatedFromMutation = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echoValidated"), { v: make[kind]!() } as never);
});
export const runValidatedFromAction = actionGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echoValidated"), { v: make[kind]!() } as never);
});
export const nestedValidated = mutationGeneric(async (ctx, { kind }: { kind: string }) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:validated"), { kind });
});
export const argsNotObjectFromMutation = mutationGeneric(async (ctx) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), new Point() as never);
});
export const argsNotObjectFromAction = actionGeneric(async (ctx) => {
  await ctx.runQuery(makeFunctionReference<"query">("values:echo"), new Point() as never);
});

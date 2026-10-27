"use node";
// The "use node" callers of test/nested-arg-errors.test.ts.
import { actionGeneric, makeFunctionReference } from "convex/server";

const refs = {
  q: makeFunctionReference<"query">("calls:q"),
  m: makeFunctionReference<"mutation">("calls:m"),
  a: makeFunctionReference<"action">("calls:a"),
  r: makeFunctionReference<"query">("calls:r"),
};
// `q`, `m`, `a`: arguments their validator refuses; `qWide`, `mWide`, `aWide`: arguments that do not decode
// (an object of over 1024 fields), refused before any validator; `r`: a result its returns validator refuses.
const WIDE = { n: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`f${i}`, i])) };
// `qDeep`, `mDeep`, `aDeep`: arguments of 64 levels, too nested for the callee (a query's or mutation's `runUdf`
// takes them).
let DEEP: unknown = 1;
for (let i = 0; i < 63; i++) DEEP = i % 2 ? [DEEP] : { a: DEEP };
const run = (ctx: any, target: string) => {
  const args = target.endsWith("Wide") ? WIDE : target.endsWith("Deep") ? { n: DEEP } : { n: "x" };
  const kind = target[0];
  if (kind === "r") return ctx.runQuery(refs.r, {});
  return kind === "q"
    ? ctx.runQuery(refs.q, args)
    : kind === "m"
      ? ctx.runMutation(refs.m, args)
      : ctx.runAction(refs.a, args);
};

export const nodeCaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  try {
    await run(ctx, target);
    return null;
  } catch (e: any) {
    return { name: e.name, message: e.message };
  }
});
export const nodeUncaught = actionGeneric(async (ctx, { target }: { target: string }) => {
  await run(ctx, target);
});

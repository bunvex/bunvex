// Functions that log `n` lines (STUDY-186 A1): a query, a mutation and a V8 action, each against its own line limit.

import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const lines = (n: number) => {
  for (let i = 0; i < n; i++) console.log(i);
  return null;
};

export const q = queryGeneric({ args: { n: v.number() }, handler: (_ctx, { n }) => lines(n) });
export const m = mutationGeneric({ args: { n: v.number() }, handler: (_ctx, { n }) => lines(n) });
export const a = actionGeneric({ args: { n: v.number() }, handler: (_ctx, { n }) => lines(n) });

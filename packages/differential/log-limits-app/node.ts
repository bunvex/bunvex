"use node";
// A "use node" action that logs `n` lines (STUDY-186 A1): its limit is the one Convex sends its node executor.
import { actionGeneric } from "convex/server";
import { v } from "convex/values";

export const a = actionGeneric({
  args: { n: v.number() },
  handler: (_ctx, { n }) => {
    for (let i = 0; i < n; i++) console.log(i);
    return null;
  },
});

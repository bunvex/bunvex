"use node";
// The same cases from a "use node" action.
import { actionGeneric } from "convex/server";
import { v } from "convex/values";
import { actionCases } from "./frames";

export const nodeUncaught = actionGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    await actionCases[c]!(ctx);
  },
});
export const nodeCaught = actionGeneric({
  args: { c: v.string() },
  handler: async (ctx, { c }) => {
    try {
      await actionCases[c]!(ctx);
    } catch (e) {
      const err = e as Error;
      console.log(err);
      console.log(String(err.stack));
      return { name: err.name, message: err.message, stack: String(err.stack) };
    }
  },
});

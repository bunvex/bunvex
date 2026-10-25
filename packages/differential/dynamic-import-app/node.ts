"use node";
// Dynamic `import()` in a "use node" action (STUDY-188 §X14).
import { actionGeneric } from "convex/server";
import { v } from "convex/values";

export const sibling = actionGeneric({
  args: {},
  handler: async () => {
    const a = await import("./helpers");
    const b = await import("./helpers");
    return { fib: a.fibonacci(10), same: a === b };
  },
});

export const importSpec = actionGeneric({
  args: { spec: v.string() },
  handler: async (_ctx, { spec }) => {
    try {
      const ns = await import(spec);
      return { exports: Object.keys(ns).sort() };
    } catch (e) {
      const err = e as Error;
      return { rejected: { name: err?.name, message: err?.message, isError: e instanceof Error } };
    }
  },
});

export const throwsOnLoadCaught = actionGeneric({
  args: {},
  handler: async () => {
    try {
      await import("./thrower.lib");
      return "loaded";
    } catch (e) {
      const err = e as Error;
      return { caught: { name: err?.name, message: err?.message } };
    }
  },
});

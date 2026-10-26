"use node";
// The same calls from a "use node" action.
import { actionGeneric } from "convex/server";
import { run, seen } from "./probe";

export const inNode = actionGeneric(
  async (ctx, { op, target, caught }: { op: string; target: string; caught: boolean }) => {
    if (!caught) return { value: await run(ctx, op, target) };
    try {
      return { value: await run(ctx, op, target) };
    } catch (e) {
      return { caught: seen(e) };
    }
  },
);

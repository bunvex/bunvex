// What a component's `process.env` reads: its bindings, the app's names (never its), a name nobody set.
import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const NAMES = ["MODE", "KEY", "APPKEY", "SECRET", "NOPE"];
const read = () => Object.fromEntries(NAMES.map((n) => [n, process.env[n] ?? null]));

export const env = query({ args: {}, handler: async () => read() });
export const envMut = mutation({ args: {}, handler: async () => read() });

export const badName = query({
  args: {},
  handler: async () => {
    try {
      return { value: process.env["not a name"] ?? null };
    } catch (e) {
      return { threw: (e as Error).message };
    }
  },
});

/** A call through a handle (into another component, or back into the app): this component's reads around it. */
export const callHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const before = read();
    const inner = await ctx.runQuery(handle as FunctionHandle<"query">, {});
    return { before, inner, after: read() };
  },
});

export const callHandleMut = mutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const before = read();
    const inner = await ctx.runMutation(handle as FunctionHandle<"mutation">, {});
    return { before, inner, after: read() };
  },
});

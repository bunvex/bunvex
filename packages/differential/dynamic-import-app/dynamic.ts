// Dynamic `import()` (STUDY-188 §X14): an action imports a sibling module, a chunk only it reaches, a path that does
// not exist and a module that throws while loading; a query and a mutation are refused, an action's nested query too.
import { actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const described = (e: unknown) => {
  const err = e as Error;
  return {
    name: err?.name,
    message: err?.message,
    isError: e instanceof Error,
    isTypeError: e instanceof TypeError,
  };
};

/** `import(spec)` with a specifier the bundler cannot see: its export names, or what it rejected with. */
async function tryImport(spec: string) {
  try {
    const ns = await import(spec);
    return { exports: Object.keys(ns).sort() };
  } catch (e) {
    return { rejected: described(e) };
  }
}

export const sibling = actionGeneric({
  args: {},
  handler: async () => {
    const a = await import("./helpers");
    const b = await import("./helpers");
    return { fib: a.fibonacci(10), same: a === b };
  },
});

export const lazyChunk = actionGeneric({
  args: {},
  handler: async () => {
    const m = await import("./lazy.lib");
    return { value: m.lazy, loads: (globalThis as { lazyLoads?: number }).lazyLoads };
  },
});

export const importSpec = actionGeneric({
  args: { spec: v.string() },
  handler: async (_ctx, { spec }) => tryImport(spec),
});

export const throwsOnLoad = actionGeneric({
  args: {},
  handler: async () => {
    await import("./thrower.lib");
    return "loaded";
  },
});

export const throwsOnLoadCaught = actionGeneric({
  args: {},
  handler: async () => {
    try {
      await import("./thrower.lib");
      return "loaded";
    } catch (e) {
      return { caught: described(e) };
    }
  },
});

export const inQuery = queryGeneric({
  args: {},
  handler: async () => {
    const m = await import("./helpers");
    return m.fibonacci(10);
  },
});

export const inQueryCaught = queryGeneric({
  args: { spec: v.string() },
  handler: async (_ctx, { spec }) => tryImport(spec),
});

export const inMutation = mutationGeneric({
  args: {},
  handler: async () => {
    const m = await import("./helpers");
    return m.fibonacci(10);
  },
});

export const inMutationCaught = mutationGeneric({
  args: { spec: v.string() },
  handler: async (_ctx, { spec }) => tryImport(spec),
});

export const nestedQuery = actionGeneric({
  args: {},
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery("dynamic:inQueryCaught" as never, { spec: "./helpers" } as never),
});

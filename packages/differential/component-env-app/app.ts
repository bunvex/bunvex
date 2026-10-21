// The app's reads, and its calls into `envc` and `second` from a query, a mutation and an action; handles from one
// component into the other and back into the app.
import { createFunctionHandle } from "convex/server";
import { api, components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

const NAMES = ["MODE", "KEY", "APPKEY", "SECRET", "NOPE"];
const read = () => Object.fromEntries(NAMES.map((n) => [n, process.env[n] ?? null]));

export const appEnv = query({ args: {}, handler: async () => read() });
export const appEnvMut = mutation({ args: {}, handler: async () => read() });

export const appBadName = query({
  args: {},
  handler: async () => {
    try {
      return { value: process.env["not a name"] ?? null };
    } catch (e) {
      return { threw: (e as Error).message };
    }
  },
});

export const viaQuery = query({
  args: {},
  handler: async (ctx) => {
    const before = read();
    const envc = await ctx.runQuery(components.envc.lib.env, {});
    const second = await ctx.runQuery(components.second.lib.env, {});
    const bad = await ctx.runQuery(components.envc.lib.badName, {});
    return { before, envc, second, bad, after: read() };
  },
});

export const viaMutation = mutation({
  args: {},
  handler: async (ctx) => {
    const before = read();
    const envc = await ctx.runMutation(components.envc.lib.envMut, {});
    const second = await ctx.runQuery(components.second.lib.env, {});
    const stale = await ctx.runQuery(components.envc.lib.env, {}, { useStaleSnapshot: true } as never);
    return { before, envc, second, stale, after: read() };
  },
});

export const viaAction = action({
  args: {},
  handler: async (ctx) => {
    const envc = await ctx.runQuery(components.envc.lib.env, {});
    const second = await ctx.runMutation(components.second.lib.envMut, {});
    return { envc, second };
  },
});

export const componentToComponent = query({
  args: {},
  handler: async (ctx) => {
    const handle = await createFunctionHandle(components.second.lib.env);
    return await ctx.runQuery(components.envc.lib.callHandle, { handle });
  },
});

export const componentToComponentMut = mutation({
  args: {},
  handler: async (ctx) => {
    const handle = await createFunctionHandle(components.second.lib.envMut);
    return await ctx.runMutation(components.envc.lib.callHandleMut, { handle });
  },
});

export const componentToApp = query({
  args: {},
  handler: async (ctx) => {
    const handle = await createFunctionHandle(api.app.appEnv);
    return { before: read(), call: await ctx.runQuery(components.envc.lib.callHandle, { handle }), after: read() };
  },
});

export const componentToAppMut = mutation({
  args: {},
  handler: async (ctx) => {
    const handle = await createFunctionHandle(api.app.appEnvMut);
    return {
      before: read(),
      call: await ctx.runMutation(components.envc.lib.callHandleMut, { handle }),
      after: read(),
    };
  },
});

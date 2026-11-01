// The app of test/sign-jwt.test.ts (STUDY-192): `ctx.auth.signJwt` with the options as given, its result or its
// error caught (class, message), the component's token, and whether a query or an action has `signJwt`.
// biome-ignore-all lint/suspicious/noExplicitAny: the options and the component's api come untyped from the test
import { actionGeneric, componentsGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const signer = (componentsGeneric() as any).signer.lib;

export const sign = mutationGeneric({
  args: { options: v.any() },
  handler: async (ctx, { options }) => {
    try {
      return { token: await (ctx.auth as any).signJwt(options), now: Date.now() };
    } catch (e) {
      return { name: (e as Error).name, message: (e as Error).message, data: (e as any).data ?? null };
    }
  },
});

/** The same, uncaught: the error as the caller receives it. */
export const signUncaught = mutationGeneric({
  args: { options: v.any() },
  handler: async (ctx, { options }) => (ctx.auth as any).signJwt(options),
});

export const signInComponent = mutationGeneric({
  args: {},
  handler: async (ctx) => ctx.runMutation(signer.sign, {}),
});

export const queryHasIt = queryGeneric({ args: {}, handler: async (ctx) => typeof (ctx.auth as any).signJwt });
export const actionHasIt = actionGeneric({ args: {}, handler: async (ctx) => typeof (ctx.auth as any).signJwt });

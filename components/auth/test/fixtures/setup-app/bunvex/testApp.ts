// The test method bound to the real `setupAuth` (upstream's `server/setup.test.ts` app): its `createUser` owns no table
// and returns the account id as the user id.
import { componentsGeneric, internalMutation, makeFunctionReference } from "@bunvex/server";
import { v } from "@bunvex/values";
import type { ComponentApi } from "../../../../src/component/_generated/component.ts";
import type { CreateUserFn } from "../../../../src/lib/types.ts";
import { setupAuth } from "../../../../src/server/setup.ts";

const components = componentsGeneric() as unknown as { auth: ComponentApi };

export const createUser = internalMutation({
  args: { provider: v.object({ name: v.string(), accountId: v.string(), profile: v.any() }) },
  returns: v.string(),
  handler: async (_ctx, args) => args.provider.accountId,
});

const core = setupAuth({ component: components.auth });
const { authMutation } = core.bindProvider({
  name: "test-provider",
  createUser: makeFunctionReference<"mutation">("testApp:createUser") as unknown as CreateUserFn<
    "test-provider",
    unknown,
    "users"
  >,
});

export const signUp = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.bunvexAuth.completeSignUp({ providerAccountId: accountId, profile: {} }),
});

export const signIn = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.bunvexAuth.completeSignIn({ providerAccountId: accountId, profile: {} }),
});

export const revokeOtherSessions = authMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.bunvexAuth.revokeOtherSessions(),
});

// Tests only: it lets anyone sign any user out (`revokeAllSessions` checks no authorization).
export const revokeAllSessions = authMutation({
  args: { userId: v.string() },
  returns: v.number(),
  handler: async (ctx, { userId }) => await ctx.bunvexAuth.revokeAllSessions(userId),
});

export const resolveUserId = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) => await ctx.bunvexAuth.resolveUserId(accountId),
});

/** A user's session ids, as the core lists them. */
export const sessionIds = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) =>
    (await ctx.runQuery(components.auth.public.listSessions, { userId })).map((s) => s.sessionId),
});

export const { isAuthenticated, signOut, refreshSession } = core;

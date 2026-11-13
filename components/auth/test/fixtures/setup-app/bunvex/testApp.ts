// The test method bound to the real `setupAuth` (upstream's `server/setup.test.ts` app): its `createUser` owns no table
// and returns the profile's `id` as the user id, so a test chooses the user id of a sign-up. A second core, as the same
// app redeployed with a lower inactivity timeout, binds the same method name over the same component.
import { componentsGeneric, internalMutation, makeFunctionReference } from "@bunvex/server";
import { v } from "@bunvex/values";
import type { ComponentApi } from "../../../../src/component/_generated/component.ts";
import type { CreateUserFn } from "../../../../src/lib/types.ts";
import { setupAuth } from "../../../../src/server/setup.ts";

const components = componentsGeneric() as unknown as { auth: ComponentApi; authTest: object };

/** The component that authenticates the test method's users: the sessions record its path. */
const authenticatedBy = components.authTest;

export const createUser = internalMutation({
  args: { method: v.object({ name: v.string(), profile: v.any() }) },
  returns: v.string(),
  handler: async (_ctx, args) => args.method.profile.id,
});

const createUserRef = makeFunctionReference<"mutation">("testApp:createUser") as unknown as CreateUserFn<
  "testMethod",
  unknown,
  "users"
>;

const core = setupAuth({ component: components.auth });
const { authMutation } = core.bindMethod({ name: "testMethod", createUser: createUserRef });

export const signUp = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.bunvexAuth.completeSignUp({ profile: { id: accountId }, authenticatedBy }),
});

export const signIn = authMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.bunvexAuth.completeSignIn({ userId: accountId, profile: {}, authenticatedBy }),
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

/** A user's session ids, as the core lists them. */
export const sessionIds = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) =>
    (await ctx.runQuery(components.auth.public.listSessions, { userId })).map((s) => s.sessionId),
});

/** The lowered inactivity timeout of the redeployed app, in seconds. */
const SHORT_INACTIVITY_TIMEOUT_SECONDS = 60 * 60;

const shortTtlCore = setupAuth({
  component: components.auth,
  refreshInactivityTimeoutSeconds: SHORT_INACTIVITY_TIMEOUT_SECONDS,
});
const { authMutation: shortTtlAuthMutation } = shortTtlCore.bindMethod({
  name: "testMethod",
  createUser: createUserRef,
});

export const signInShortTtl = shortTtlAuthMutation({
  args: { accountId: v.string() },
  returns: v.any(),
  handler: async (ctx, { accountId }) =>
    await ctx.bunvexAuth.completeSignIn({ userId: accountId, profile: {}, authenticatedBy }),
});

export const revokeOtherSessionsShortTtl = shortTtlAuthMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => await ctx.bunvexAuth.revokeOtherSessions(),
});

export const { isAuthenticated, signOut, refreshSession } = core;

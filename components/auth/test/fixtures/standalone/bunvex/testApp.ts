// The app's callbacks for the core's suite (upstream's `testApp.fixture.ts`): `createUser` returns `user<n>`, the n-th
// it made in this deployment; `onSignIn` returns null; `onSignInThatThrows` refuses every sign-in. Each logs its call.
import { internalMutation, internalQuery } from "@bunvex/server";
import { v } from "@bunvex/values";

const vProvider = v.object({ name: v.string(), accountId: v.string(), profile: v.any() });

export const createUser = internalMutation({
  args: { provider: vProvider },
  returns: v.string(),
  handler: async (ctx, args) => {
    await ctx.db.insert("callbackCalls", { kind: "createUser", args });
    const made = await ctx.db
      .query("callbackCalls")
      .filter((q) => q.eq(q.field("kind"), "createUser"))
      .collect();
    return `user${made.length}`;
  },
});

export const onSignIn = internalMutation({
  args: { provider: vProvider, userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("callbackCalls", { kind: "onSignIn", args });
    return null;
  },
});

export const onSignInThatThrows = internalMutation({
  args: { provider: vProvider, userId: v.string() },
  returns: v.null(),
  handler: async () => {
    throw new Error("no sign-ins for you");
  },
});

/** The callbacks' calls of `kind`, in order. */
export const calls = internalQuery({
  args: { kind: v.union(v.literal("createUser"), v.literal("onSignIn")) },
  handler: async (ctx, { kind }) =>
    (await ctx.db.query("callbackCalls").collect()).filter((c) => c.kind === kind).map((c) => c.args),
});

/** The deployment's origin: the access tokens' `iss` for functions of the app. */
export const cloudUrl = internalQuery({ args: {}, handler: async () => process.env.BUNVEX_CLOUD_URL ?? null });

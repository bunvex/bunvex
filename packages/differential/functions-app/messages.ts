// The app of the dashboard's Functions and runner tests (STUDY-149 PR 4): each kind and visibility, a function
// declared without arguments, one with a returns validator, a default export, and one that reads the caller's
// identity (the runner's "act as a user").
import { actionGeneric, internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const list = queryGeneric({
  args: {},
  handler: async (ctx) => {
    console.log("listing");
    return (await ctx.db.query("messages").collect()).map((m) => m.body);
  },
});

export const send = mutationGeneric({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    console.info("sending", body);
    await ctx.db.insert("messages", { body });
    return body.length;
  },
});

export const whoami = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.auth.getUserIdentity();
    return user && { subject: user.subject, issuer: user.issuer, name: user.name ?? null };
  },
});

export const secret = internalQueryGeneric({
  args: { n: v.int64() },
  returns: v.int64(),
  handler: async (_ctx, { n }) => n,
});

export const loose = queryGeneric(async () => 1);

export const act = actionGeneric({
  args: { x: v.optional(v.number()) },
  handler: async (_ctx, { x }) => {
    console.warn("acting");
    return x ?? null;
  },
});

export default queryGeneric({ args: {}, handler: async () => "default" });

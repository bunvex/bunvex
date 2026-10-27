import { action, internalMutation, makeFunctionReference, mutation, query } from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";

const sendRef = makeFunctionReference<"mutation">("messages:send");

export const list = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("messages").collect()).map((m) => `${m.author}: ${m.body}`),
});

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const user = await ctx.auth.getUserIdentity();
    await ctx.db.insert("messages", { body, author: user?.name ?? user?.subject ?? "anonymous" });
  },
});

export const sendLater = mutation({
  args: { body: v.string(), delayMs: v.number() },
  handler: async (ctx, { body, delayMs }) => {
    await ctx.scheduler.runAfter(delayMs, sendRef, { body });
  },
});

export const wipe = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const m of await ctx.db.query("messages").collect()) await ctx.db.delete(m._id);
  },
});

export const greeting = query({ args: {}, handler: async () => process.env.GREETING ?? null });

export const sendTwice = action({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    await ctx.runMutation(sendRef, { body });
    await ctx.runMutation(sendRef, { body });
  },
});

export const reject = mutation({
  args: {},
  handler: async () => {
    throw new Error("rejected on purpose");
  },
});

export const requestMeta = mutation({
  args: {},
  handler: async (ctx) => {
    const { ip, userAgent } = await ctx.meta.getRequestMetadata();
    return { ip, userAgent };
  },
});

export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("ticks", { at: Date.now() });
  },
});

export const ticks = query({ args: {}, handler: async (ctx) => (await ctx.db.query("ticks").collect()).length });

/** An application error, with data, as a function throws it. */
export const refuse = mutation({
  args: { reason: v.string() },
  handler: async (_ctx, { reason }) => {
    throw new BunvexError({ code: "refused", reason });
  },
});

import { v } from "bunvex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

/** Every message, oldest first. */
export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

/** Post a message that stays. */
export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, { body, author }) => {
    await ctx.db.insert("messages", { body, author });
  },
});

const withCountdown = (body: string, secondsLeft: number) => `${body} (disappears in ${secondsLeft}s)`;

/**
 * Post a message that counts down, then deletes itself. Each step is a scheduled run of `tick`, `tickMs`
 * apart (one second by default): nothing polls, the scheduler runs `tick` and every page showing the list
 * updates.
 */
export const sendExpiring = mutation({
  args: {
    body: v.string(),
    author: v.string(),
    seconds: v.optional(v.number()),
    tickMs: v.optional(v.number()),
  },
  handler: async (ctx, { body, author, seconds = 5, tickMs = 1000 }) => {
    const messageId = await ctx.db.insert("messages", { body: withCountdown(body, seconds), author });
    await ctx.scheduler.runAfter(tickMs, internal.messages.tick, {
      messageId,
      body,
      secondsLeft: seconds - 1,
      tickMs,
    });
  },
});

/** One step of the countdown: rewrite the message and schedule the next step, or delete it at zero. */
export const tick = internalMutation({
  args: { messageId: v.id("messages"), body: v.string(), secondsLeft: v.number(), tickMs: v.number() },
  handler: async (ctx, { messageId, body, secondsLeft, tickMs }) => {
    if (secondsLeft <= 0) {
      await ctx.db.delete(messageId);
      return;
    }
    await ctx.db.patch(messageId, { body: withCountdown(body, secondsLeft) });
    await ctx.scheduler.runAfter(tickMs, internal.messages.tick, {
      messageId,
      body,
      secondsLeft: secondsLeft - 1,
      tickMs,
    });
  },
});

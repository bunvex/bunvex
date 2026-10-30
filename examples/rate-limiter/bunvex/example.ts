// The rate limiter's API, after Convex's example of `@convex-dev/rate-limiter` (`example/convex/example.ts`):
// limits named once in the constructor, a hook API for `useRateLimit`, a mutation that spends tokens, and internal
// functions that walk through `limit`, `check`, `reset`, `throws` and an inline config. The e2e test runs them.
import { HOUR, isRateLimitError, MINUTE, type RateLimitConfig, RateLimiter, SECOND } from "@bunvex/rate-limiter";
import { v } from "@bunvex/values";
import { components } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation } from "./_generated/server.js";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  /** Per user: one message every 6 s on average, up to 3 in a row after a quiet spell. */
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  /** One limit for everyone: 100 sign-ups an hour. */
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  /** The page's demo: 10 tokens a minute, 10 at most. */
  demoLimit: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 10 },
});

/** The signed-in user's subject, or one shared key for visitors. */
const keyOf = async (ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> } }) =>
  (await ctx.auth.getUserIdentity())?.subject ?? "anonymous";

// `useRateLimit(api.example.getRateLimit, { getServerTimeMutation: api.example.getServerTime })` in the page.
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("demoLimit", { key: (ctx) => keyOf(ctx) });

/** Spend `count` tokens (1 by default) of the caller's demo limit. */
export const consumeTokens = mutation({
  args: { count: v.optional(v.number()) },
  handler: async (ctx, { count }) => rateLimiter.limit(ctx, "demoLimit", { count: count || 1, key: await keyOf(ctx) }),
});

/** Three messages pass, the fourth throws a rate limit error. */
export const sendMessages = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    for (let i = 0; i < 3; i++) {
      const status = await rateLimiter.limit(ctx, "sendMessage", { key, throws: true });
      assert(status.ok && status.retryAfter === undefined, `message ${i + 1} passes`);
    }
    try {
      await rateLimiter.limit(ctx, "sendMessage", { key, throws: true });
    } catch (e) {
      assert(isRateLimitError(e), "the fourth throws a rate limit error");
      return e.data;
    }
    throw new Error("the fourth message should have thrown");
  },
});

/** Whether `key` could send a message now, without spending a token. */
export const check = internalQuery({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, { key }) => rateLimiter.check(ctx, "sendMessage", { key }),
});

/** An inline config, either kind: one token passes, `check` then refuses, and `reset` lets it pass again. */
export const inlineConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    const limiter = new RateLimiter(components.rateLimiter);
    for (const kind of ["token bucket", "fixed window"] as const) {
      const config: RateLimitConfig = { kind, rate: 1, period: SECOND };
      const name = `inline ${kind}`;
      const first = await limiter.limit(ctx, name, { config });
      assert(first.ok && first.retryAfter === undefined, `${kind}: the first token passes`);
      const after = await limiter.check(ctx, name, { config });
      assert(!after.ok && after.retryAfter > 0, `${kind}: none left`);
      await limiter.reset(ctx, name);
      const reset = await limiter.check(ctx, name, { config });
      assert(reset.ok && reset.retryAfter === undefined, `${kind}: reset`);
    }
    return "ok";
  },
});

/** The component's functions called directly, without the client class. */
export const direct = internalMutation({
  args: {},
  handler: async (ctx) => {
    const lib = components.rateLimiter.lib;
    for (const kind of ["token bucket", "fixed window"] as const) {
      const config: RateLimitConfig = { kind, rate: 1, period: SECOND };
      const name = `direct ${kind}`;
      const first = await ctx.runMutation(lib.rateLimit, { name, config });
      assert(first.ok && first.retryAfter === undefined, `${kind}: the first token passes`);
      const after = await ctx.runQuery(lib.checkRateLimit, { name, config });
      assert(!after.ok && after.retryAfter > 0, `${kind}: none left`);
      await ctx.runMutation(lib.resetRateLimit, { name });
      const reset = await ctx.runQuery(lib.checkRateLimit, { name, config });
      assert(reset.ok && reset.retryAfter === undefined, `${kind}: reset`);
    }
    return "ok";
  },
});

function assert(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`Expected: ${what}`);
}

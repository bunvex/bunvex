// The app's side of upstream's client tests (`src/client/index.test.ts`): one `RateLimiter` with a transactional
// limit (`strict`) and an asynchronous one (`async`), the app's functions that call its methods, an inline
// asynchronous config, and `hookAPI`'s query.
import { isRateLimitError, RateLimiter } from "@bunvex/rate-limiter";
import type { ComponentApi } from "@bunvex/rate-limiter/_generated/component.js";
import { componentsGeneric, mutationGeneric, queryGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

const HOUR = 60 * 60 * 1000;
const rateLimiterComponent = (componentsGeneric() as unknown as { rateLimiter: ComponentApi }).rateLimiter;

const rateLimiter = new RateLimiter(rateLimiterComponent, {
  strict: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
  async: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3, applyUpdates: "asynchronously" },
});

new RateLimiter(rateLimiterComponent, {
  // @ts-expect-error an asynchronous limit can't be sharded
  bad: { kind: "token bucket", rate: 10, period: HOUR, applyUpdates: "asynchronously", shards: 4 },
});

const INLINE_ASYNC = { kind: "token bucket", rate: 100, period: HOUR, applyUpdates: "asynchronously" } as const;

export const badInline = mutationGeneric({
  args: {},
  handler: async (ctx) =>
    rateLimiter.limit(ctx, "badInline", {
      // @ts-expect-error an asynchronous limit can't be sharded
      config: { ...INLINE_ASYNC, rate: 1, shards: 2 },
    }),
});

const vLimit = v.union(v.literal("strict"), v.literal("async"));

export const consume = mutationGeneric({
  args: {
    limit: vLimit,
    key: v.optional(v.string()),
    count: v.optional(v.number()),
    throws: v.optional(v.boolean()),
    reserve: v.optional(v.boolean()),
  },
  handler: async (ctx, { limit, key, count, throws, reserve }) =>
    rateLimiter.limit(ctx, limit, { key, count, throws, reserve }),
});

export const check = queryGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) => rateLimiter.check(ctx, limit, { key }),
});

export const value = queryGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) => rateLimiter.getValue(ctx, limit, { key }),
});

export const reset = mutationGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) => rateLimiter.reset(ctx, limit, { key }),
});

export const inlineAsync = mutationGeneric({
  args: { count: v.number() },
  handler: async (ctx, { count }) => rateLimiter.limit(ctx, "inline", { count, config: INLINE_ASYNC }),
});

export const resetInlineAsync = mutationGeneric({
  args: {},
  handler: async (ctx) => rateLimiter.reset(ctx, "inline", { config: INLINE_ASYNC }),
});

export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("async", { key: "u" });

/** The app catching a limit's error itself: `isRateLimitError` in the app's own code, as an app uses it. */
export const consumeAndCatch = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    try {
      await rateLimiter.limit(ctx, "strict", { count: 3, throws: true });
      await rateLimiter.limit(ctx, "strict", { throws: true });
      return "not limited";
    } catch (e) {
      return { isRateLimitError: isRateLimitError(e), data: (e as { data?: unknown }).data ?? null };
    }
  },
});

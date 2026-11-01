// The playground behind the page's controls: one limit, `demo`, whose config the page sends with every call, so
// changing a control changes the limit at once.
import { RateLimiter } from "@bunvex/rate-limiter";
import { v } from "@bunvex/values";
import { components } from "./_generated/api.js";
import { mutation } from "./_generated/server.js";

const rateLimiter = new RateLimiter(components.rateLimiter);

// The page reads the limit with the config it holds (`useRateLimit`'s `config`); this one is the default.
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("demo", {
  config: { kind: "token bucket", rate: 1, period: 2_000, capacity: 3 },
});

const vConfig = v.object({
  kind: v.union(v.literal("token bucket"), v.literal("fixed window")),
  rate: v.number(),
  period: v.number(),
  capacity: v.optional(v.number()),
  maxReserved: v.optional(v.number()),
  shards: v.optional(v.number()),
});

/** Spend `count` tokens of `demo` under `config`, or reserve them. */
export const consumeRateLimit = mutation({
  args: { config: vConfig, count: v.number(), reserve: v.boolean() },
  handler: async (ctx, { config, count, reserve }) => rateLimiter.limit(ctx, "demo", { config, count, reserve }),
});

export const resetRateLimit = mutation({
  args: {},
  handler: async (ctx) => rateLimiter.reset(ctx, "demo"),
});

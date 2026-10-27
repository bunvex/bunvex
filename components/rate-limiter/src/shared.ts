// What the component, the client and the React hook share (STUDY-197 §1.1, §1.2): the config, argument and result
// validators, the pending update of the asynchronous mode, and `calculateRateLimit`, the math both kinds of limit
// follow (run by the component, and by the hook in the browser). Names, shapes and math are those of Convex's
// `@convex-dev/rate-limiter` 0.4.2.
import { type Infer, v } from "@bunvex/values";

/**
 * A token bucket: `rate` tokens are added per `period`, continuously, up to `capacity` (the rate by default). A
 * request consumes its tokens; with `reserve`, up to `maxReserved` may be taken ahead of time.
 */
export const tokenBucketValidator = v.object({
  kind: v.literal("token bucket"),
  rate: v.number(),
  period: v.number(),
  capacity: v.optional(v.number()),
  maxReserved: v.optional(v.number()),
  shards: v.optional(v.number()),
  applyUpdates: v.optional(v.union(v.literal("transactionally"), v.literal("asynchronously"))),
  start: v.optional(v.null()),
});

/**
 * A fixed window: `rate` tokens are added at the start of each window of `period`, up to `capacity`. Windows start at
 * `start` (UTC ms); without it, at a random phase within the period.
 */
export const fixedWindowValidator = v.object({
  kind: v.literal("fixed window"),
  rate: v.number(),
  period: v.number(),
  capacity: v.optional(v.number()),
  maxReserved: v.optional(v.number()),
  shards: v.optional(v.number()),
  applyUpdates: v.optional(v.union(v.literal("transactionally"), v.literal("asynchronously"))),
  start: v.optional(v.number()),
});

export const configValidator = v.union(tokenBucketValidator, fixedWindowValidator);

/** One rate limit's configuration: sharded and transactional, or applied asynchronously and never sharded. */
export type RateLimitConfig =
  | (TokenBucketConfig & ShardedConfig)
  | (TokenBucketConfig & AsyncConfig)
  | (FixedWindowConfig & ShardedConfig)
  | (FixedWindowConfig & AsyncConfig);

type ShardedConfig = { shards?: number; applyUpdates?: "transactionally" };
type AsyncConfig = { applyUpdates?: "asynchronously"; shards?: never };
type TokenBucketConfig = {
  kind: "token bucket";
  rate: number;
  period: number;
  capacity?: number;
  maxReserved?: number;
  start?: null;
};
type FixedWindowConfig = {
  kind: "fixed window";
  rate: number;
  period: number;
  capacity?: number;
  maxReserved?: number;
  start?: number;
};

/** The arguments of `rateLimit` and `checkRateLimit`. */
export const rateLimitArgs = {
  name: v.string(),
  key: v.optional(v.string()),
  count: v.optional(v.number()),
  reserve: v.optional(v.boolean()),
  throws: v.optional(v.boolean()),
  config: configValidator,
};

export type RateLimitArgs = {
  /** The rate limit's name. */
  name: string;
  /** Whose limit this is; without one, the limit is a single shared value. */
  key?: string;
  /** How many tokens to consume: 1 by default. */
  count?: number;
  /** Take the tokens ahead of time, going negative up to `maxReserved`. */
  reserve?: boolean;
  /** Throw a `RateLimited` error instead of answering `{ ok: false, retryAfter }`. */
  throws?: boolean;
  /** The limit's configuration. */
  config: Infer<typeof configValidator>;
};

export const rateLimitReturns = v.union(
  v.object({ ok: v.literal(true), retryAfter: v.optional(v.number()) }),
  v.object({ ok: v.literal(false), retryAfter: v.number() }),
);
export type RateLimitReturns = Infer<typeof rateLimitReturns>;

/** The `data` of the error a limit throws with `throws: true`. */
export type RateLimitError = {
  kind: "RateLimited";
  name: string;
  retryAfter: number;
};

export const getValueArgs = v.object({
  name: v.optional(v.string()),
  key: v.optional(v.string()),
  sampleShards: v.optional(v.number()),
  config: v.optional(configValidator),
});
export type GetValueArgs = Infer<typeof getValueArgs>;

export const getValueReturns = v.object({
  value: v.number(),
  ts: v.number(),
  shard: v.number(),
  config: configValidator,
});
export type GetValueReturns = Infer<typeof getValueReturns>;

/** The one shard of a limit applied asynchronously (such a limit is never sharded). */
export const SINGLETON_SHARD = 0;

/** An update the asynchronous mode queues for the worker: a consumption at `ts`, or a reset. */
export const vPendingUpdate = v.union(
  v.object({
    kind: v.literal("consume"),
    name: v.string(),
    key: v.optional(v.string()),
    count: v.number(),
    config: configValidator,
    ts: v.number(),
  }),
  v.object({
    kind: v.literal("reset"),
    name: v.string(),
    key: v.optional(v.string()),
  }),
);
export type PendingUpdate = Infer<typeof vPendingUpdate>;

/**
 * A limit's state at `now` after consuming `count`, from its stored state (`null`: a new, full limit):
 * the new `value` and `ts`, how long until it would be non-negative (`retryAfter`, when negative) and, for a fixed
 * window, the start of the window the state was in (`windowStart`).
 */
export function calculateRateLimit(
  existing: { value: number; ts: number } | null,
  config: Infer<typeof configValidator>,
  now: number = Date.now(),
  count: number = 0,
) {
  const max = config.capacity ?? config.rate;
  // A fixed window without a `start` begins at a random phase of its period.
  const state = existing ?? {
    value: max,
    ts: config.kind === "fixed window" ? (config.start ?? now - Math.floor(Math.random() * config.period)) : now,
  };

  let value: number;
  let ts: number;
  let retryAfter: number | undefined;
  let windowStart: number | undefined;
  if (config.kind === "token bucket") {
    const perMs = config.rate / config.period;
    value = Math.min(state.value + (now - state.ts) * perMs, max) - count;
    ts = now;
    if (value < 0) retryAfter = -value / perMs;
  } else {
    windowStart = state.ts;
    const windows = Math.floor((now - state.ts) / config.period);
    value = Math.min(state.value + config.rate * windows, max) - count;
    ts = state.ts + windows * config.period;
    if (value < 0) retryAfter = ts + config.period * Math.ceil(-value / config.rate) - now;
  }
  return { value, ts, retryAfter, windowStart };
}

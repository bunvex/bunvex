// The app of test/rate-limiter.test.ts (STUDY-197): one `RateLimiter` whose limits barely refill (so results do not
// depend on when each backend runs the call), the client's methods and the component's functions called as an app
// calls them, bad arguments included. On bunvex the harness renames `@convex-dev/rate-limiter` to
// `@bunvex/rate-limiter`.
// biome-ignore-all lint/suspicious/noExplicitAny: the calls are built from the test's arguments
import { isRateLimitError, RateLimiter } from "@convex-dev/rate-limiter";
import { componentsGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const YEAR = 365 * 24 * 60 * 60 * 1000;
const component = (componentsGeneric() as any).rateLimiter;

const rateLimiter = new RateLimiter(component, {
  bucket: { kind: "token bucket", rate: 3, period: YEAR },
  window: { kind: "fixed window", rate: 3, period: YEAR, start: 0 },
  reserved: { kind: "token bucket", rate: 3, period: YEAR, maxReserved: 2 },
  sharded: { kind: "token bucket", rate: 30, period: YEAR, shards: 10 },
  queued: { kind: "token bucket", rate: 3, period: YEAR, applyUpdates: "asynchronously" },
});

type Name = "bucket" | "window" | "reserved" | "sharded" | "queued";

/** A run of `limit` calls on one name, each as `{ ok }` or the error's `data` and whether `isRateLimitError` says so. */
export const limit = mutationGeneric({
  args: { name: v.string(), calls: v.array(v.any()) },
  handler: async (ctx, { name, calls }) => {
    const out: unknown[] = [];
    for (const options of calls) {
      try {
        const status = await rateLimiter.limit(ctx, name as Name, options);
        out.push({ ok: status.ok, retryAfter: status.retryAfter === undefined ? "none" : "some" });
      } catch (e) {
        // `retryAfter` counts from each backend's own instant of the call: compared by its presence.
        const data = (e as any).data ?? null;
        out.push({
          isRateLimitError: isRateLimitError(e),
          data: data && { ...data, retryAfter: typeof data.retryAfter },
          error: (e as Error).message.split("\n")[0].replace(/"retryAfter":[0-9.e+-]+/, '"retryAfter":<n>'),
        });
      }
    }
    return out;
  },
});

export const reset = mutationGeneric({
  args: { name: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, { name, key }) => rateLimiter.reset(ctx, name as Name, { key }),
});

/** `getValue` without the parts that depend on time. */
export const value = queryGeneric({
  args: { name: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, { name, key }) => {
    const { value: n, shard, config } = await rateLimiter.getValue(ctx, name as Name, { key });
    return { value: Math.round(n * 1e6) / 1e6, shard, config };
  },
});

/** A component function called with `args` as given: its result, or its error's first line. */
export const call = mutationGeneric({
  args: { fn: v.string(), args: v.any() },
  handler: async (ctx, { fn, args }) => {
    const ref = component.lib[fn];
    const isQuery = fn === "checkRateLimit" || fn === "getValue";
    try {
      return { ok: isQuery ? await ctx.runQuery(ref, args) : await ctx.runMutation(ref, args) };
    } catch (e) {
      return { error: (e as Error).message.split("\n")[0] };
    }
  },
});

/** The client's own refusals. */
export const clientError = mutationGeneric({
  args: { which: v.string() },
  handler: async (ctx, { which }) => {
    try {
      if (which === "undefined") await rateLimiter.limit(ctx, "nope" as any);
      else
        await rateLimiter.limit(ctx, "inline" as any, {
          config: { kind: "token bucket", rate: 1, period: YEAR, applyUpdates: "asynchronously", shards: 2 } as any,
        });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  },
});

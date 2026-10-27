// The rate limiter's client (STUDY-197 §1.6), with the API of Convex's `@convex-dev/rate-limiter` 0.4.2: the
// `RateLimiter` class (`check`, `limit`, `reset`, `getValue`, `hookAPI`), `isRateLimitError`, the time constants and
// `calculateRateLimit`. A limit whose `applyUpdates` is `"asynchronously"` is checked at the transaction's start
// snapshot when called from a mutation, and its consumption and resets are queued for the component's worker.
//
// The error a limit throws is a `BunvexError` with Convex's `data` (DV-538); `isRateLimitError` tests for it.
import {
  type Expand,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  mutationGeneric,
  queryGeneric,
} from "@bunvex/server";
import { BunvexError, v } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import type { GetValueReturns, RateLimitArgs, RateLimitConfig, RateLimitError, RateLimitReturns } from "../shared.ts";
import { getValueArgs, getValueReturns } from "../shared.ts";

export { calculateRateLimit } from "../shared.ts";
export type { RateLimitArgs, RateLimitConfig, RateLimitError, RateLimitReturns };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Whether `error` is the error a rate limit throws with `throws: true`. */
export function isRateLimitError(error: unknown): error is { data: RateLimitError } {
  return error instanceof BunvexError && (error.data as Record<string, unknown>).kind === "RateLimited";
}

/**
 * Named rate limits, typed by their names.
 *
 * ```ts
 * import { MINUTE, HOUR, RateLimiter } from "@bunvex/rate-limiter";
 * import { components } from "./_generated/api";
 *
 * const rateLimiter = new RateLimiter(components.rateLimiter, {
 *   // Per user: one about every 6 seconds, up to 3 at once after a quiet spell.
 *   sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
 *   // One shared limit.
 *   freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
 * });
 * await rateLimiter.limit(ctx, "sendMessage", { key: userId, throws: true });
 * ```
 *
 * A name not given here needs its `config` inline at each call.
 */
export class RateLimiter<Limits extends Record<string, RateLimitConfig> = Record<never, never>> {
  constructor(
    public component: ComponentApi,
    public limits?: Limits,
  ) {}

  /**
   * Whether a request would be allowed now, taking no tokens: `{ ok, retryAfter }`, `retryAfter` in ms. With
   * `reserve`, `ok` with a `retryAfter` means the tokens can be reserved, and the work must wait that long.
   */
  async check<Name extends string = keyof Limits & string>(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [WithKnownNameOrInlinedConfig<Limits, Name, RateLimitArgs>?]
      : [WithKnownNameOrInlinedConfig<Limits, Name, RateLimitArgs>]
  ): Promise<RateLimitReturns> {
    const config = this.getConfig(options[0], name);
    const args = { ...options[0], name, config };
    return config.applyUpdates === "asynchronously"
      ? runStaleQuery(ctx, this.component.lib.checkRateLimit, args)
      : calls(ctx).runQuery(this.component.lib.checkRateLimit, args);
  }

  /** Check a request and, if allowed, take its tokens: `{ ok, retryAfter }`, as {@link check}. */
  async limit<Name extends string = keyof Limits & string>(
    ctx: MutationCtx | ActionCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [WithKnownNameOrInlinedConfig<Limits, Name, RateLimitArgs>?]
      : [WithKnownNameOrInlinedConfig<Limits, Name, RateLimitArgs>]
  ): Promise<RateLimitReturns> {
    const config = this.getConfig(options[0], name);
    const args = { ...options[0], name, config };
    if (config.applyUpdates !== "asynchronously") return calls(ctx).runMutation(this.component.lib.rateLimit, args);
    const status = await runStaleQuery(ctx, this.component.lib.checkRateLimit, args);
    if (!status.ok) return status;
    const { key, count } = args as RateLimitArgs;
    await calls(ctx).runMutation(this.component.lib.enqueueUpdates, {
      updates: [{ kind: "consume", name, key, count: count ?? 1, config, ts: Date.now() }],
    });
    return status;
  }

  /**
   * Remove a limit (one `key`'s, or the shared value), so the next request starts afresh. A fixed window with no
   * `start` then begins at a new random phase.
   */
  async reset<Name extends string = keyof Limits & string>(
    ctx: MutationCtx | ActionCtx,
    name: Name,
    args?: { key?: string; config?: RateLimitConfig },
  ): Promise<void> {
    const config = args?.config ?? this.limits?.[name];
    const resetArgs = { key: args?.key, name };
    if (config?.applyUpdates === "asynchronously") {
      await calls(ctx).runMutation(this.component.lib.enqueueUpdates, { updates: [{ kind: "reset", ...resetArgs }] });
    } else {
      await calls(ctx).runMutation(this.component.lib.resetRateLimit, resetArgs);
    }
  }

  /** A limit's stored value, `ts`, shard and config, taking nothing. */
  async getValue<Name extends string = keyof Limits & string>(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [WithKnownNameOrInlinedConfig<Limits, Name, { key?: string; sampleShards?: number }>?]
      : [WithKnownNameOrInlinedConfig<Limits, Name, { key?: string; sampleShards?: number }>]
  ): Promise<GetValueReturns> {
    const config = this.getConfig(options[0], name);
    const args = { ...options[0], name, config };
    return config.applyUpdates === "asynchronously"
      ? runStaleQuery(ctx, this.component.lib.getValue, args)
      : calls(ctx).runQuery(this.component.lib.getValue, args);
  }

  /**
   * A public query and mutation for the app to export, for `useRateLimit` in the browser:
   *
   * ```ts
   * export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("sendMessage", { key: (ctx) => userIdOf(ctx) });
   * ```
   *
   * A key sent by the browser is used only through a `key` function, which receives it.
   */
  hookAPI<DataModel extends GenericDataModel, Name extends string = keyof Limits & string>(
    name: Name,
    ...options: Name extends keyof Limits
      ? [WithKnownNameOrInlinedConfig<Limits, Name, HookOpts<DataModel>>?]
      : [WithKnownNameOrInlinedConfig<Limits, Name, HookOpts<DataModel>>]
  ) {
    return {
      getRateLimit: queryGeneric({
        args: getValueArgs,
        returns: getValueReturns,
        handler: async (ctx, args): Promise<GetValueReturns> => {
          const finalName = args.name ?? name;
          const { key: keyOrFn, ...rest } = options[0] ?? {};
          if (args.key && !keyOrFn) {
            throw new Error("To allow client-provided key, provide a `key` function in the hook options.");
          }
          let key: string | undefined;
          if (typeof keyOrFn === "function") key = await keyOrFn(ctx as GenericQueryCtx<DataModel>, args.key);
          else if (keyOrFn !== undefined) key = keyOrFn;
          return calls(ctx).runQuery(this.component.lib.getValue, {
            ...rest,
            ...args,
            key,
            name: finalName,
            config: args.config ?? this.getConfig(options[0], finalName),
          });
        },
      }),
      getServerTime: mutationGeneric({
        args: {},
        returns: v.number(),
        handler: async () => Date.now(),
      }),
    };
  }

  private getConfig<Name extends string, Args>(
    args: WithKnownNameOrInlinedConfig<Limits, Name, Args> | undefined,
    name: Name,
  ): RateLimitConfig {
    const config = (args && "config" in args && args.config) || this.limits?.[name];
    if (!config) {
      throw new Error(
        `Rate limit ${name} not defined. You must provide a config inline or define it in the constructor.`,
      );
    }
    if (config.applyUpdates === "asynchronously" && config.shards !== undefined) {
      throw new Error(`Rate limit ${name} applies updates asynchronously and can't be sharded.`);
    }
    return config as RateLimitConfig;
  }
}

export default RateLimiter;

/** The query, at the transaction's start snapshot when called from a mutation. */
async function runStaleQuery<Query extends FunctionReference<"query", "internal">>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  query: Query,
  args: FunctionArgs<Query>,
): Promise<FunctionReturnType<Query>> {
  const { type } = await ctx.meta.getFunctionMetadata();
  return type === "mutation"
    ? calls(ctx).runQuery(query, args, { useStaleSnapshot: true })
    : calls(ctx).runQuery(query, args);
}

/**
 * The calls the client makes on a context, by reference. bunvex's contexts also take a function by its name (an
 * overload), and TypeScript cannot call an overloaded method through a union of context types.
 */
type Calls = {
  runQuery<Q extends FunctionReference<"query", "internal">>(
    query: Q,
    args: FunctionArgs<Q>,
    options?: { useStaleSnapshot?: boolean },
  ): Promise<FunctionReturnType<Q>>;
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
};
const calls = (ctx: unknown) => ctx as Calls;

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery" | "meta">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation" | "meta">;
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction" | "meta">;

type WithKnownNameOrInlinedConfig<Limits extends Record<string, RateLimitConfig>, Name extends string, Args> = Expand<
  Omit<Args, "name" | "config"> &
    (Name extends keyof Limits
      ? object
      : {
          /** The limit's configuration, for a name not given to the constructor. */
          config: RateLimitConfig;
        })
>;

type HookOpts<DataModel extends GenericDataModel> = {
  key?: string | ((ctx: GenericQueryCtx<DataModel>, keyFromClient?: string) => string | Promise<string>);
  sampleShards?: number;
};

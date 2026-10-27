// `useRateLimit` (STUDY-197 §1.6), as Convex's package's `./react`: it subscribes to the app's `getRateLimit` query
// (from `RateLimiter.hookAPI`), measures the browser's clock skew once through `getServerTime`, and computes the
// limit's status locally with `calculateRateLimit`, re-rendering when `retryAt` passes. bunvex's `useBunvex` stands
// for Convex's `useConvex`.
import { useBunvex, useQuery } from "@bunvex/react";
import type { FunctionReference } from "@bunvex/server";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { calculateRateLimit, type GetValueArgs, type GetValueReturns, type RateLimitConfig } from "../shared.ts";

export type UseRateLimitOptions = {
  name?: string;
  key?: string;
  count?: number;
  sampleShards?: number;
  getServerTimeMutation?: GetServerTimeMutation;
  config?: RateLimitConfig;
};

export type GetRateLimitValueQuery = FunctionReference<"query", "public", GetValueArgs, GetValueReturns>;
export type GetServerTimeMutation = FunctionReference<"mutation", "public", Record<string, never>, number>;

/**
 * A rate limit's status in a React component.
 *
 * @returns `status`: `{ ok: true }`, or `{ ok: false, retryAt }` (the browser's time when `count`, 1 by default,
 *   fits), undefined until the query answers; and `check(ts?, count?)`, the limit's value at another time or count.
 */
export function useRateLimit(getRateLimitValueQuery: GetRateLimitValueQuery, opts?: UseRateLimitOptions) {
  // clientTime + timeOffset = serverTime
  const [timeOffset, setTimeOffset] = useState(0);
  const refresh = useForceUpdate();
  const client = useBunvex();
  const { getServerTimeMutation, count, ...args } = opts ?? {};

  // biome-ignore lint/correctness/useExhaustiveDependencies: measured once per client, as Convex's hook does
  useEffect(() => {
    if (!getServerTimeMutation) return;
    const clientTime = Date.now();
    void client.mutation(getServerTimeMutation, {}).then((serverTime: number) => {
      const latency = Date.now() - clientTime;
      setTimeOffset(serverTime - clientTime - latency / 2);
    });
  }, [client, !!getServerTimeMutation]);

  const rateLimitData = useQuery(getRateLimitValueQuery, {
    name: args.name,
    key: args.key,
    sampleShards: args.sampleShards,
    config: args.config,
  });

  // Takes and returns the browser's time; computes on the server's.
  const check = useCallback(
    (ts?: number, count?: number) => {
      if (!rateLimitData) return undefined;
      const clientTime = ts ?? Date.now();
      const serverTime = clientTime + timeOffset;
      const value = calculateRateLimit(rateLimitData, rateLimitData.config, serverTime, count);
      return {
        value: value.value,
        ts: value.ts - timeOffset,
        config: rateLimitData.config,
        shard: rateLimitData.shard,
        ok: value.value >= 0,
        retryAt: value.retryAfter ? serverTime + value.retryAfter - timeOffset : undefined,
      };
    },
    [rateLimitData, timeOffset],
  );

  const current = check(Date.now(), count ?? 1);
  const ret = useMemo(() => {
    if (!current) return { status: undefined, check };
    if (current.value < 0) return { status: { ok: false as const, retryAt: current.retryAt! }, check };
    return { status: { ok: true as const, retryAt: undefined }, check };
  }, [current, check]);

  useEffect(() => {
    if (ret?.status?.ok !== false) return;
    const timer = setTimeout(refresh, ret.status.retryAt - Date.now());
    return () => clearTimeout(timer);
  }, [ret?.status?.ok, ret?.status?.retryAt, refresh]);

  return ret;
}

function useForceUpdate() {
  return useReducer((c: number) => c + 1, 0)[1];
}

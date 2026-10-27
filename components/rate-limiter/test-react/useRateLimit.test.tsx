// Upstream's `src/react/index.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported: `useRateLimit` with
// `@bunvex/react`'s `useQuery` and `useBunvex` mocked (upstream mocks `convex/react`'s `useQuery` and `useConvex`),
// rendered under happy-dom.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { GetValueReturns } from "../src/shared.ts";

let queryResult: GetValueReturns | undefined;
mock.module("@bunvex/react", () => ({
  useQuery: () => queryResult,
  useBunvex: () => ({ mutation: async () => Date.now() }),
}));
const { act, renderHook } = await import("@testing-library/react");
const { useRateLimit } = await import("../src/react/index.ts");
type Query = Parameters<typeof useRateLimit>[0];
const query = {} as Query;

const tokenBucket = { kind: "token bucket" as const, rate: 10, period: 60_000 };

describe("useRateLimit", () => {
  beforeEach(() => {
    queryResult = undefined;
  });
  afterEach(() => {
    setSystemTime();
  });

  test("the status when tokens are available", () => {
    queryResult = { value: 8, ts: Date.now(), shard: 0, config: tokenBucket };
    const { result } = renderHook(() => useRateLimit(query));
    expect(result.current.status?.ok).toBe(true);
    expect(result.current.status?.retryAt).toBeUndefined();
    expect(result.current.check()?.value).toBeCloseTo(8, 1);
  });

  test("the status when the limit is exceeded", () => {
    queryResult = { value: 0, ts: Date.now(), shard: 0, config: tokenBucket };
    const { result } = renderHook(() => useRateLimit(query));
    expect(result.current.status?.ok).toBe(false);
    expect(result.current.status?.retryAt).toBeDefined();
    expect(result.current.check()?.value).toBeCloseTo(0, 1);
  });

  test("a server clock ahead of the browser's", () => {
    setSystemTime(new Date(1_765_432_101_234));
    // The server is 5 seconds ahead.
    const serverTime = Date.now() + 5000;
    queryResult = { value: 5, ts: serverTime, shard: 0, config: tokenBucket };
    const { result } = renderHook(() => useRateLimit(query));
    act(() => {});
    expect(result.current.status?.ok).toBe(true);
    const checked = result.current.check(undefined, 6);
    expect(checked?.retryAt).toBeDefined();
    expect(checked?.retryAt).toBeCloseTo(serverTime + (6 - 5) / (10 / 60_000), -2);
  });

  test("a fixed window: retryAt is the next window's start", () => {
    const windowStart = Date.now() - 30_000;
    queryResult = { value: 2, ts: windowStart, shard: 0, config: { kind: "fixed window", rate: 10, period: 60_000 } };
    const { result } = renderHook(() => useRateLimit(query));
    expect(result.current.status?.ok).toBe(true);
    const checked = result.current.check(undefined, 12);
    expect(checked?.retryAt).toBeCloseTo(windowStart + 60_000, -2);
  });

  test("before the query answers, no status", () => {
    const { result } = renderHook(() => useRateLimit(query));
    expect(result.current.status).toBeUndefined();
    expect(result.current.check()).toBeUndefined();
  });
});

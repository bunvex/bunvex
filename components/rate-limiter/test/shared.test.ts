// Upstream's `src/shared.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7): the config type against its
// validator, and `calculateRateLimit` for both kinds, with no state, a state, a consumption and an over-consumption.
import { describe, expect, test } from "bun:test";
import type { Infer } from "@bunvex/values";
import { calculateRateLimit, type configValidator, type RateLimitConfig } from "../src/shared.ts";

type Assert<T extends true> = T;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe("RateLimitConfig", () => {
  test("every config is one the validator accepts, and has every field the validator has", () => {
    type _Accepted = Assert<RateLimitConfig extends Infer<typeof configValidator> ? true : false>;
    type _AllFields = Assert<keyof Infer<typeof configValidator> extends keyof RateLimitConfig ? true : false>;
  });
});

describe("calculateRateLimit: token bucket", () => {
  const config = { kind: "token bucket" as const, rate: 10, period: MINUTE, capacity: 10 };
  const now = Date.now();
  const halfFull = { value: 5, ts: now - 30 * SECOND };

  test("no state: full, now", () => {
    expect(calculateRateLimit(null, config, now)).toEqual({
      value: 10,
      ts: now,
      retryAfter: undefined,
      windowStart: undefined,
    });
  });

  test("a state refills by the time elapsed, up to the capacity", () => {
    expect(calculateRateLimit(halfFull, config, now)).toMatchObject({ value: 10, ts: now, retryAfter: undefined });
  });

  test("a consumption", () => {
    expect(calculateRateLimit(halfFull, config, now, 8)).toMatchObject({ value: 2, ts: now, retryAfter: undefined });
  });

  test("an over-consumption waits for the missing tokens at the rate", () => {
    // 5 tokens short at 10 a minute: half a minute.
    expect(calculateRateLimit(halfFull, config, now, 15)).toMatchObject({
      value: -5,
      ts: now,
      retryAfter: 30 * SECOND,
    });
  });
});

describe("calculateRateLimit: fixed window", () => {
  const config = { kind: "fixed window" as const, rate: 10, period: MINUTE };

  test("no state: full, in a window of a random phase", () => {
    const now = Date.now();
    const result = calculateRateLimit(null, config, now);
    expect(result.value).toBe(10);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeGreaterThan(now - MINUTE);
    expect(result.windowStart).toBeLessThanOrEqual(now);
    expect(result.ts).toBe(result.windowStart!);
  });

  test("in the same window: nothing added", () => {
    const windowStart = Date.now() - 30 * SECOND;
    expect(calculateRateLimit({ value: 5, ts: windowStart }, config, windowStart + 45 * SECOND)).toEqual({
      value: 5,
      ts: windowStart,
      retryAfter: undefined,
      windowStart,
    });
  });

  test("in the next window: the rate added once, up to the capacity, and the window moved", () => {
    const windowStart = Date.now() - 90 * SECOND;
    expect(calculateRateLimit({ value: 5, ts: windowStart }, config, windowStart + 90 * SECOND)).toEqual({
      value: 10,
      ts: windowStart + MINUTE,
      retryAfter: undefined,
      windowStart,
    });
  });

  test("a consumption", () => {
    const windowStart = Date.now() - 30 * SECOND;
    expect(calculateRateLimit({ value: 5, ts: windowStart }, config, windowStart + 45 * SECOND, 3)).toMatchObject({
      value: 2,
      ts: windowStart,
    });
  });

  test("an over-consumption waits for the next window", () => {
    const windowStart = Date.now() - 30 * SECOND;
    // 15 seconds left in this window.
    expect(calculateRateLimit({ value: 5, ts: windowStart }, config, windowStart + 45 * SECOND, 8)).toMatchObject({
      value: -3,
      ts: windowStart,
      retryAfter: 15 * SECOND,
      windowStart,
    });
  });
});

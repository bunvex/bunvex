// The network-error retry (STUDY-201 §3.4), upstream's `browser/retry.test.ts` ported. Vitest's fake timers become a
// `setTimeout` that records each wait and fires at once, with `Math.random` pinned so the waits are exactly 550 ms and
// 2050 ms (each backoff plus half the jitter).
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { retryOnNetworkError } from "../src/browser/retry.ts";

/** A fetch failing on the network, as Chromium words it. */
const networkError = () => new TypeError("Failed to fetch");

let waits: number[];
let restore: (() => void)[] = [];
beforeEach(() => {
  waits = [];
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    queueMicrotask(fn);
    return 0;
  }) as never);
  restore = [() => random.mockRestore(), () => timeout.mockRestore()];
});
afterEach(() => {
  for (const r of restore) r();
});

describe("retryOnNetworkError", () => {
  test("returns the first attempt's result without sleeping", async () => {
    const fn = mock(async () => "ok");
    expect(await retryOnNetworkError(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  test("retries network errors with backoff and succeeds on the last attempt", async () => {
    const fn = mock()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce("ok");
    const log = mock();
    expect(await retryOnNetworkError(fn, log)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([550, 2050]);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "network error, retry 1 in 550ms",
      "network error, retry 2 in 2050ms",
    ]);
  });

  test("rethrows a non-network error immediately", async () => {
    const fn = mock().mockRejectedValue(new Error("boom"));
    await expect(retryOnNetworkError(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  test("throws the last network error with no sleep after the final attempt", async () => {
    const fn = mock().mockRejectedValue(networkError());
    await expect(retryOnNetworkError(fn)).rejects.toThrow("Failed to fetch");
    expect(fn).toHaveBeenCalledTimes(3);
    // Two backoffs, none after the last attempt.
    expect(waits).toEqual([550, 2050]);
  });
});

// withTimeout: the client-side timeout the remote drivers put on every database call (STUDY-25 L3). The
// drivers themselves are checked against real stores behind a frozen proxy by the conformance suite (K20).
import { describe, expect, test } from "bun:test";
import { DatabaseTimeoutError, withTimeout } from "../src/persistence/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => {});

describe("withTimeout (STUDY-25 L3)", () => {
  test("a call that never answers fails with DatabaseTimeoutError after the timeout, and drops its connection", async () => {
    let dropped = 0;
    const t0 = performance.now();
    const err = await withTimeout("Test", 80, never, () => dropped++).catch((e) => e);
    const took = performance.now() - t0;
    expect(err).toBeInstanceOf(DatabaseTimeoutError);
    expect(err.message).toBe("Database Timeout (Test): no answer within 80 ms");
    expect(took).toBeGreaterThanOrEqual(75);
    expect(took).toBeLessThan(300);
    expect(dropped).toBe(1);
  });

  test("a call that answers in time returns its result, and its errors as they are", async () => {
    let dropped = 0;
    expect(
      await withTimeout(
        "Test",
        200,
        async () => (await sleep(10), 42),
        () => dropped++,
      ),
    ).toBe(42);
    const boom = new Error("boom");
    expect(await withTimeout("Test", 200, () => Promise.reject(boom)).catch((e) => e)).toBe(boom);
    expect(dropped).toBe(0);
  });

  test("progress re-arms the timer: each round trip of a multi-step call has the whole timeout", async () => {
    const r = await withTimeout("Test", 100, async (progress) => {
      for (let i = 0; i < 4; i++) {
        await sleep(60); // 240 ms in all, more than the timeout, but no step takes 100 ms
        progress();
      }
      return "done";
    });
    expect(r).toBe("done");
    const err = await withTimeout("Test", 100, async (progress) => {
      await sleep(60);
      progress();
      await never(); // the second step hangs
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseTimeoutError);
  });

  test("an answer that arrives after the timeout is ignored", async () => {
    const err = await withTimeout("Test", 30, async () => (await sleep(80), "late")).catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseTimeoutError);
    await sleep(80); // the late answer settles nothing and throws nothing
  });

  test("0 or Infinity disables the timeout", async () => {
    expect(await withTimeout("Test", 0, async () => (await sleep(30), 1))).toBe(1);
    expect(await withTimeout("Test", Infinity, async () => 2)).toBe(2);
  });
});

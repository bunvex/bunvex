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

  test("a call that timed out issues nothing more: its next progress() throws (STUDY-25 §3.5)", async () => {
    // A driver calls progress() before each statement of a multi-step call. Once the call has timed out, the
    // caller has moved on (the committer retries the flush): the abandoned attempt must not send its next
    // statement, let alone a COMMIT that would race the retry.
    const sent: string[] = [];
    let answer: () => void = () => {};
    let thrown: unknown = null;
    const call = withTimeout("Test", 40, async (progress) => {
      sent.push("fence");
      await new Promise<void>((r) => {
        answer = r; // its answer comes after the timeout
      });
      try {
        progress();
      } catch (e) {
        thrown = e;
        throw e;
      }
      sent.push("insert", "commit");
    });
    expect(await call.catch((e) => e)).toBeInstanceOf(DatabaseTimeoutError);
    answer();
    await sleep(10);
    expect(sent).toEqual(["fence"]);
    expect(thrown).toBeInstanceOf(DatabaseTimeoutError);
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

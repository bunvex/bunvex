// Flush retries (STUDY-25 L4, as Convex's write batcher): a flush that fails with an error the driver calls
// transient is retried with backoff until it lands; anything else stops the committer at once. The drivers
// themselves are checked against real stores by the conformance suite (K20, K21).
import { describe, expect, test } from "bun:test";
import { v } from "@bunvex/values";
import { CommitterStoppedError } from "../src/committer.ts";
import { Engine } from "../src/engine.ts";
import { LeaseLostError, type Persistence, retryOnce, UnsureCommitError } from "../src/persistence/index.ts";
import { MemoryPersistence } from "../src/persistence/memory.ts";
import { defineSchema, defineTable } from "../src/schema.ts";

const schema = defineSchema({ items: defineTable(v.any()).index("by_n", ["n"]) });

class Transient extends Error {}

/** A store whose flushes after `init()` fail as scripted, before reaching the real one (which keeps the
 *  group). */
async function scripted(script: unknown[]) {
  const failures: unknown[] = [];
  const inner = await MemoryPersistence.open(null, { durable: false });
  const store: Persistence = Object.create(inner);
  let flushes = 0;
  store.flush = async () => {
    flushes++;
    const f = failures.shift();
    if (f) throw f;
    return inner.flush();
  };
  store.isTransient = (e) => e instanceof Transient;
  const delays: number[] = [];
  const e = await new Engine(schema, store, {
    flushRetry: { initialBackoffMs: 10, maxBackoffMs: 40, onRetry: (_e, _n, d) => delays.push(d) },
  }).init();
  const fatal: CommitterStoppedError[] = [];
  e.committer.onFatal((err) => fatal.push(err));
  failures.push(...script);
  flushes = 0;
  return { e, delays, fatal, flushes: () => flushes };
}
const count = (e: Engine) => e.query((db) => db.query("items").collect()).then((r) => r.length);

describe("flush retries (STUDY-25 L4)", () => {
  test("transient failures are retried with capped, jittered backoff; the commit is acknowledged once", async () => {
    const failures = [new Transient("reset"), new Transient("timeout"), new Transient("x"), new Transient("y")];
    const s = await scripted(failures);
    await s.e.mutation((db) => db.insert("items", { n: 1 }));
    expect(s.flushes()).toBe(5);
    expect(s.delays).toHaveLength(4);
    // Full jitter over min(10 · 2^n, 40): attempt n waits at most its cap.
    s.delays.forEach((d, n) => {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(10 * 2 ** n, 40));
    });
    expect(s.e.committer.flushFailures).toBe(4);
    expect(s.e.committer.stopped).toBeNull();
    expect(s.fatal).toHaveLength(0);
    expect(await count(s.e)).toBe(1);
  });

  test("a failure that is not transient stops the committer at once, as an unsure write", async () => {
    const { e, delays, fatal } = await scripted([new Error("syntax error")]);
    const err = await e.mutation((db) => db.insert("items", { n: 1 })).catch((x) => x);
    expect(err).toBeInstanceOf(CommitterStoppedError);
    expect(err.message).toContain("write failed, unsure if the group committed to disk: syntax error");
    expect(delays).toHaveLength(0);
    expect(fatal).toHaveLength(1);
  });

  test("an UnsureCommitError on a retry (the first attempt did commit) is fail-stop", async () => {
    const { e, delays, fatal } = await scripted([new Transient("answer lost"), new UnsureCommitError("found it")]);
    const err = await e.mutation((db) => db.insert("items", { n: 1 })).catch((x) => x);
    expect(err).toBeInstanceOf(CommitterStoppedError);
    expect((err as Error).cause).toBeInstanceOf(UnsureCommitError);
    expect(delays).toHaveLength(1);
    expect(fatal).toHaveLength(1);
  });

  test("a LeaseLostError is not transient", async () => {
    const { e, delays } = await scripted([new LeaseLostError()]);
    const err = await e.mutation((db) => db.insert("items", { n: 1 })).catch((x) => x);
    expect((err as Error).cause).toBeInstanceOf(LeaseLostError);
    expect(delays).toHaveLength(0);
  });

  test("a committer stopped from outside (a lost lease) during the backoff stops retrying at once", async () => {
    const inner = await MemoryPersistence.open(null, { durable: false });
    const store: Persistence = Object.create(inner);
    let attempts = 0;
    store.isTransient = (x) => x instanceof Transient;
    let down = false;
    store.flush = async () => {
      if (!down) return inner.flush();
      attempts++;
      throw new Transient("down");
    };
    const e = await new Engine(schema, store, {
      flushRetry: { initialBackoffMs: 60_000, maxBackoffMs: 60_000, onRetry: () => {} },
    }).init();
    down = true;
    const pending = e.mutation((db) => db.insert("items", { n: 1 })).catch((x) => x);
    while (attempts === 0) await new Promise((r) => setTimeout(r, 1));
    const t0 = performance.now();
    e.committer.fail(new LeaseLostError());
    const err = await pending;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(err).toBeInstanceOf(CommitterStoppedError);
    expect((err as Error).cause).toBeInstanceOf(LeaseLostError);
    expect(attempts).toBeLessThanOrEqual(2);
  });

  test("the embedded drivers call nothing transient: every flush failure is fail-stop", async () => {
    const inner: Persistence = await MemoryPersistence.open(null, { durable: false });
    expect(inner.isTransient).toBeUndefined();
  });
});

describe("retryOnce (STUDY-25 L5)", () => {
  test("a retryable failure runs the call once more; a second failure surfaces", async () => {
    let calls = 0;
    let fresh = 0;
    const flaky = (fails: number) => async () => {
      if (calls++ < fails) throw new Transient(`fail ${calls}`);
      return "ok";
    };
    const retryable = (e: unknown) => e instanceof Transient;
    expect(await retryOnce(flaky(1), retryable, () => fresh++)).toBe("ok");
    expect([calls, fresh]).toEqual([2, 1]);
    calls = 0;
    const err = await retryOnce(flaky(2), retryable, () => fresh++).catch((e) => e);
    expect(err.message).toBe("fail 2");
    expect([calls, fresh]).toEqual([2, 2]);
    calls = 0;
    const boom = new Error("not transient");
    expect(
      await retryOnce(() => {
        calls++;
        return Promise.reject(boom);
      }, retryable).catch((e) => e),
    ).toBe(boom);
    expect(calls).toBe(1);
  });
});

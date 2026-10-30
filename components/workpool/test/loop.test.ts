// Upstream's `src/component/loop.test.ts` (get-convex/workpool 0.4.14, STUDY-199 §1.19), ported: the loop driven by
// hand, as the batch worker drives it (`getBatch`, then `run` with the batch), observed through `status`, the queues
// and `internalState.running`. The deprecated forwarders' cases (`loop:main`, `loop:updateRunStatus`) are not ported:
// those functions are not built (DV-539). Where upstream schedules the legacy `runActionWrapper` to get a running
// job's scheduled id, a pending `testing:noop` stands in.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import { RECOVERY_PERIOD_SEGMENTS, SATURATED_STATUS_COOLDOWN, STATUS_COOLDOWN } from "../src/component/loop.ts";
import { fromSegment, toSegment, WORKER_NAME } from "../src/component/shared.ts";
import {
  api,
  enqueueWork,
  initialize,
  MINUTE,
  observe,
  runLoop,
  setupTest,
  simulateCompletion,
  statusOf,
} from "./helpers.ts";

setDefaultTimeout(30_000);

let t: ReturnType<typeof setupTest>;
beforeEach(() => {
  t = setupTest();
});
const segmentNow = () => toSegment(t.now());

describe("forward progress", () => {
  it("starts a pending work item when the loop runs", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await runLoop(t);
    const o = await observe(t);
    expect(o.pendingStart).toHaveLength(0);
    expect(o.running.map((r) => r.workId)).toEqual([workId]);
    expect(await statusOf(t, workId)).toMatchObject({ state: "running" });
  });

  it("removes work from running once a successful completion is processed", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "success", returnValue: null }, 0);
    await runLoop(t);
    const o = await observe(t);
    expect(o.running).toHaveLength(0);
    expect(o.pendingCompletion).toHaveLength(0);
    expect(await statusOf(t, workId)).toMatchObject({ state: "finished" });
  });

  it("treats a final failure (no retry policy) as terminal", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "failed", error: "boom" }, 0);
    await runLoop(t);
    expect((await observe(t)).running).toHaveLength(0);
    expect(await statusOf(t, workId)).toMatchObject({ state: "finished" });
  });

  it("processes multiple work items concurrently within capacity", async () => {
    await initialize(t, { maxParallelism: 5 });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await enqueueWork(t));
    await runLoop(t);
    const o = await observe(t);
    expect(o.running).toHaveLength(3);
    expect(new Set(o.running.map((r) => r.workId))).toEqual(new Set(ids));
  });

  it("starts action and query work through one batch action wrapper", async () => {
    await initialize(t, { maxParallelism: 5 });
    const actionId = await enqueueWork(t, { fnType: "action" });
    const queryId = await enqueueWork(t, { fnType: "query" });
    const mutationId = await enqueueWork(t, { fnType: "mutation" });
    await runLoop(t);
    const o = await observe(t);
    const find = (id: Id<"work">) => o.running.find((r) => r.workId === id)!;
    expect(find(actionId).scheduledId).toBe(find(queryId).scheduledId);
    expect(find(mutationId).scheduledId).not.toBe(find(actionId).scheduledId);
  });

  it("chunks action and query starts into batches of 32", async () => {
    await initialize(t, { maxParallelism: 64 });
    for (let i = 0; i < 33; i++) await enqueueWork(t, { fnType: i % 2 === 0 ? "action" : "query" });
    await runLoop(t);
    const o = await observe(t);
    expect(o.running).toHaveLength(33);
    const counts = new Map<string, number>();
    for (const { scheduledId } of o.running) counts.set(scheduledId, (counts.get(scheduledId) ?? 0) + 1);
    expect([...counts.values()].sort((a, b) => a - b)).toEqual([1, 32]);
  });
});

describe("capacity", () => {
  it("never starts more than maxParallelism in one iteration", async () => {
    await initialize(t, { maxParallelism: 3 });
    for (let i = 0; i < 7; i++) await enqueueWork(t);
    await runLoop(t);
    const o = await observe(t);
    expect(o.running).toHaveLength(3);
    expect(o.pendingStart).toHaveLength(7 - 3);
  });

  it("picks up overflow on subsequent iterations as slots free", async () => {
    await initialize(t, { maxParallelism: 2 });
    for (let i = 0; i < 4; i++) await enqueueWork(t);
    await runLoop(t);
    let o = await observe(t);
    expect(o.running).toHaveLength(2);
    expect(o.pendingStart).toHaveLength(2);
    const finished = o.running[0]!.workId;
    await simulateCompletion(t, finished, { kind: "success", returnValue: null }, 0);
    await runLoop(t);
    o = await observe(t);
    expect(o.running).toHaveLength(2);
    expect(o.pendingStart).toHaveLength(1);
    expect(o.running.map((r) => r.workId)).not.toContain(finished);
  });

  it("does not start new work when running.length already exceeds maxParallelism", async () => {
    // maxParallelism lowered while jobs were running.
    await initialize(t, { maxParallelism: 2 });
    const running: Doc<"internalState">["running"] = [];
    for (let i = 0; i < 4; i++) {
      running.push(
        await t.run(async (ctx: any) => {
          const workId = await ctx.db.insert("work", {
            fnType: "action",
            fnHandle: "h",
            fnName: "h",
            fnArgs: {},
            attempts: 0,
          });
          const scheduledId = await ctx.scheduler.runAfter(0, api.testing.noop, {});
          return { workId, scheduledId, started: Date.now() };
        }),
      );
    }
    await t.run(async (ctx: any) => {
      const s = await ctx.db.query("internalState").unique();
      await ctx.db.patch("internalState", s._id, { running });
    });
    await enqueueWork(t);
    await runLoop(t);
    const o = await observe(t);
    expect(o.running).toHaveLength(4);
    expect(o.pendingStart).toHaveLength(1);
  });
});

describe("retry", () => {
  it("re-enqueues a failed job that has a retry policy with attempts left", async () => {
    await initialize(t);
    const workId = await enqueueWork(t, { retryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 } });
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "failed", error: "boom" }, 0);
    await runLoop(t);
    const o = await observe(t);
    expect(o.pendingStart).toHaveLength(1);
    expect(o.pendingStart[0]!.workId).toBe(workId);
    expect(await statusOf(t, workId)).toMatchObject({ state: "pending", previousAttempts: 1 });
  });

  it("does NOT re-enqueue a failed job that was canceled before retry processed", async () => {
    await initialize(t);
    const workId = await enqueueWork(t, { retryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 } });
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "failed", error: "boom" }, 0);
    await t.mutation(api.lib.cancel, { id: workId });
    await runLoop(t);
    expect((await observe(t)).pendingStart).toHaveLength(0);
    expect((await t.run((ctx: any) => ctx.db.get("work", workId)))?.canceled).toBe(true);
  });

  // More: the backoff is `initialBackoffMs * base^(attempts - 1)`, times a jitter in [0.5, 1.5).
  it("waits the backoff, with jitter, before the retry", async () => {
    await initialize(t);
    const workId = await enqueueWork(t, {
      attempts: 2,
      retryBehavior: { maxAttempts: 5, initialBackoffMs: 1000, base: 3 },
    });
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "failed", error: "boom" }, 2);
    const before = t.now();
    await runLoop(t);
    const [start] = (await observe(t)).pendingStart;
    // attempts is 3 after this failure: 1000 * 3^2 = 9000 ms, times [0.5, 1.5).
    const delay = fromSegment(start!.segment) - before;
    expect(delay).toBeGreaterThanOrEqual(4500 - 100);
    expect(delay).toBeLessThan(13_500 + 100);
  });
});

describe("cancellation", () => {
  it("removes a pendingStart cancellation before the work runs", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await t.mutation(api.lib.cancel, { id: workId });
    await runLoop(t);
    const o = await observe(t);
    expect(o.pendingStart).toHaveLength(0);
    expect(o.running).toHaveLength(0);
    expect((await t.run((ctx: any) => ctx.db.get("work", workId)))?.canceled).toBe(true);
  });

  it("marks an already-running work as canceled", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await runLoop(t);
    expect((await observe(t)).running).toHaveLength(1);
    await t.mutation(api.lib.cancel, { id: workId });
    await runLoop(t);
    expect((await t.run((ctx: any) => ctx.db.get("work", workId)))?.canceled).toBe(true);
  });

  it("is a graceful no-op for already-finished work", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    await runLoop(t);
    await simulateCompletion(t, workId, { kind: "success", returnValue: null }, 0);
    await runLoop(t);
    await t.mutation(api.lib.cancel, { id: workId });
    expect((await observe(t)).pendingCancelation).toHaveLength(0);
  });
});

describe("getBatch", () => {
  const getBatch = () => t.query(api.loop.getBatch, { name: WORKER_NAME }) as Promise<any>;

  it("returns idle when there's nothing to do", async () => {
    await initialize(t);
    const result = await getBatch();
    expect(result.kind).toBe("idle");
    expect(result.timeoutMs).toBeUndefined();
    expect(result.cooldownMs).toBe(STATUS_COOLDOWN);
  });

  it("uses a longer idle cooldown while saturated", async () => {
    await initialize(t, { maxParallelism: 1 });
    await enqueueWork(t);
    await runLoop(t);
    const result = await getBatch();
    expect(result.kind).toBe("idle");
    expect(result.cooldownMs).toBe(SATURATED_STATUS_COOLDOWN);
  });

  it("uses the normal idle cooldown while capacity remains", async () => {
    await initialize(t, { maxParallelism: 2 });
    await enqueueWork(t);
    await runLoop(t);
    const result = await getBatch();
    expect(result.kind).toBe("idle");
    expect(result.cooldownMs).toBe(STATUS_COOLDOWN);
  });

  it("returns a work batch when a pending start is ready", async () => {
    await initialize(t);
    const workId = await enqueueWork(t);
    const result = await getBatch();
    expect(result.kind).toBe("work");
    expect(result.batch.starts.map((s: any) => s.workId)).toEqual([workId]);
    expect(result.batch.recovery).toBe(false);
  });

  it("idles with a timeoutMs when only future-scheduled work remains", async () => {
    await initialize(t);
    await enqueueWork(t, {}, segmentNow() + 1000n);
    const result = await getBatch();
    expect(result.kind).toBe("idle");
    expect(result.timeoutMs).toBeGreaterThan(0);
  });

  it("idles with a timeoutMs for the next recovery scan when that's sooner than future work", async () => {
    await initialize(t);
    await enqueueWork(t);
    await runLoop(t);
    await enqueueWork(t, {}, segmentNow() + toSegment(5 * MINUTE));
    const result = await getBatch();
    expect(result.kind).toBe("idle");
    const { lastRecovery } = await observe(t);
    const untilNextRecovery = fromSegment(lastRecovery + RECOVERY_PERIOD_SEGMENTS) - t.now();
    expect(result.timeoutMs).toBeDefined();
    expect(Math.abs(result.timeoutMs - untilNextRecovery)).toBeLessThan(10);
    expect(result.timeoutMs).toBeLessThan(5 * MINUTE);
  });

  // More: the shape `run` gets, and the idle hints' exact values.
  it("hands run each item's id, work, segment and, for completions, result and retry", async () => {
    await initialize(t);
    const a = await enqueueWork(t);
    await runLoop(t);
    await simulateCompletion(t, a, { kind: "success", returnValue: { big: "value" } }, 0);
    const b = await enqueueWork(t, { fnArgs: { x: 1 } });
    await t.mutation(api.lib.cancel, { id: b });
    const result = await getBatch();
    expect(Object.keys(result).sort()).toEqual(["batch", "kind"]);
    expect(Object.keys(result.batch).sort()).toEqual(["cancelations", "completions", "recovery", "segment", "starts"]);
    expect(result.batch.completions).toEqual([
      {
        _id: expect.any(String),
        workId: a,
        runResult: { kind: "success", returnValue: null },
        retry: false,
        segment: expect.any(BigInt),
      },
    ]);
    expect(result.batch.cancelations).toEqual([{ _id: expect.any(String), workId: b, segment: expect.any(BigInt) }]);
    // A canceled job's start is left out of the batch.
    expect(result.batch.starts).toEqual([]);
  });

  it("idles with only the hints it has: a 200 ms poll, and no timeout when nothing waits", async () => {
    await initialize(t);
    expect(await getBatch()).toEqual({ kind: "idle", cooldownMs: STATUS_COOLDOWN, pollIntervalMs: 200 });
  });
});

describe("recovery", () => {
  it("flags a recovery iteration and advances lastRecovery for silent workers", async () => {
    await initialize(t);
    const workId = await t.run(async (ctx: any) => {
      const wid = await ctx.db.insert("work", {
        fnType: "action",
        fnHandle: "h",
        fnName: "h",
        fnArgs: {},
        attempts: 0,
      });
      const scheduledId = await ctx.scheduler.runAfter(0, api.testing.noop, {});
      const s = await ctx.db.query("internalState").unique();
      await ctx.db.patch("internalState", s._id, {
        running: [{ workId: wid, scheduledId, started: Date.now() - 10 * MINUTE }],
        lastRecovery: 0n,
      });
      return wid;
    });
    const batch = (await t.query(api.loop.getBatch, { name: WORKER_NAME })) as any;
    expect(batch.kind).toBe("work");
    expect(batch.batch.recovery).toBe(true);
    await runLoop(t);
    const after = await observe(t);
    expect(after.lastRecovery).toBeGreaterThan(0n);
    expect(after.running.map((r) => r.workId)).toContain(workId);
  });

  // More: a running job whose work and completion are both gone leaves `running` at the recovery iteration.
  it("drops a running job whose work is gone, and keeps one with a pending completion", async () => {
    await initialize(t);
    const [gone, completing] = await t.run(async (ctx: any) => {
      const ids = [];
      for (let i = 0; i < 2; i++)
        ids.push(await ctx.db.insert("work", { fnType: "action", fnHandle: "h", fnName: "h", attempts: 0 }));
      const scheduledId = await ctx.scheduler.runAfter(MINUTE, api.testing.noop, {});
      const s = await ctx.db.query("internalState").unique();
      await ctx.db.patch("internalState", s._id, {
        running: ids.map((workId) => ({ workId, scheduledId, started: Date.now() - 10 * MINUTE })),
      });
      for (const id of ids) await ctx.db.delete("work", id);
      // The completion is in a future segment, so the loop's completion scan does not take it this iteration.
      await ctx.db.insert("pendingCompletion", {
        workId: ids[1],
        segment: 10n ** 12n,
        runResult: { kind: "success", returnValue: null },
        retry: false,
      });
      return ids;
    });
    // The completion pages from segment 0 at a recovery iteration, and would be taken: lower the limit to keep it.
    await t.run(async (ctx: any) => {
      const g = await ctx.db.query("globals").unique();
      await ctx.db.patch("globals", g._id, { maxParallelism: 0 });
    });
    await runLoop(t);
    const after = await observe(t);
    expect(after.running.map((r) => r.workId)).toEqual([completing]);
    expect(after.running.map((r) => r.workId)).not.toContain(gone);
  });
});

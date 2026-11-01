// Upstream's `src/component/complete.test.ts` (get-convex/workpool 0.4.14, STUDY-199 §1.19), ported: `complete` on its
// own, through `completeHandler` called inline (`t.run`, in the test's realm, where spies on its ctx work as
// upstream's `vi.fn` do).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import type { Id } from "../src/component/_generated/dataModel.ts";
import { completeHandler } from "../src/component/complete.ts";
import { api, emptyReport, MINUTE, setupTest, workerStatus } from "./helpers.ts";

setDefaultTimeout(30_000);

let t: ReturnType<typeof setupTest>;
beforeEach(async () => {
  t = setupTest();
  await t.run((ctx: any) => ctx.db.insert("globals", { maxParallelism: 10, logLevel: "WARN" }));
});
const retryBehavior = { maxAttempts: 3, initialBackoffMs: 100, base: 2 };
const enqueue = (over: Record<string, unknown> = {}) =>
  t.mutation(api.lib.enqueue, {
    fnHandle: "testHandle",
    fnName: "testFunction",
    fnArgs: { test: "data" },
    fnType: "mutation",
    runAt: t.now(),
    config: { maxParallelism: 10, logLevel: "WARN" },
    ...over,
  }) as Promise<Id<"work">>;
const complete = (jobs: any[]) => t.run((ctx: any) => completeHandler(ctx, { jobs }));
const getWork = (id: Id<"work">) => t.run((ctx: any) => ctx.db.get("work", id)) as Promise<any>;
const completionsOf = (workId: Id<"work">) =>
  t.run((ctx: any) =>
    ctx.db
      .query("pendingCompletion")
      .withIndex("workId", (q: any) => q.eq("workId", workId))
      .collect(),
  ) as Promise<any[]>;

async function seedSaturatedRunningWork(retry?: typeof retryBehavior) {
  return t.run(async (ctx: any) => {
    const globals = await ctx.db.query("globals").unique();
    await ctx.db.patch("globals", globals._id, { maxParallelism: 1 });
    const workId = await ctx.db.insert("work", {
      fnType: "mutation",
      fnHandle: "testHandle",
      fnName: "testFunction",
      fnArgs: { test: "data" },
      attempts: 0,
      ...(retry ? { retryBehavior: retry } : {}),
    });
    const scheduledId = await ctx.scheduler.runAfter(MINUTE, api.worker.runMutationWrapper, {
      workId,
      fnHandle: "testHandle",
      fnArgs: { test: "data" },
      fnType: "mutation",
      logLevel: "WARN",
      attempt: 0,
    });
    await ctx.db.insert("internalState", {
      generation: 0n,
      segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
      lastRecovery: 0n,
      report: emptyReport(Date.now()),
      running: [{ workId, scheduledId, started: Date.now() }],
    });
    return workId as Id<"work">;
  });
}

describe("completeHandler", () => {
  it("should process a successful job and delete the work", async () => {
    const workId = await enqueue();
    await complete([{ workId, runResult: { kind: "success", returnValue: "test result" }, attempt: 0 }]);
    expect(await getWork(workId)).toBeNull();
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult).toEqual({ kind: "success", returnValue: null });
    expect(completions[0].retry).toBe(false);
  });

  it("completes work whose stored payload is already gone", async () => {
    // A missing payload must not fail the completion, or one bad job would wedge every batch it is in.
    const workId = await enqueue({ fnArgs: { filler: "x".repeat(10_000) }, fnType: "action" });
    await t.run(async (ctx: any) => {
      const work = await ctx.db.get("work", workId);
      expect(work.payloadId).toBeDefined();
      await ctx.db.delete("payload", work.payloadId);
    });
    await complete([{ workId, runResult: { kind: "failed", error: "poisoned" }, attempt: 0 }]);
    expect(await getWork(workId)).toBeNull();
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult.kind).toBe("failed");
  });

  it("should process a failed job with retry behavior", async () => {
    const workId = await enqueue({ retryBehavior });
    await complete([{ workId, runResult: { kind: "failed", error: "test error" }, attempt: 0 }]);
    expect((await getWork(workId))?.attempts).toBe(1);
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult.kind).toBe("failed");
    expect(completions[0].retry).toBe(true);
  });

  it("should not retry a non-retryable failed job", async () => {
    const workId = await enqueue({ retryBehavior });
    await complete([
      { workId, runResult: { kind: "failed", error: "terminal error" }, attempt: 0, nonRetryable: true },
    ]);
    expect(await getWork(workId)).toBeNull();
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult).toEqual({ kind: "failed", error: "terminal error" });
    expect(completions[0].retry).toBe(false);
  });

  it("should process a failed job that has reached max attempts", async () => {
    const workId = await enqueue({ retryBehavior: { ...retryBehavior, maxAttempts: 2 } });
    await t.run((ctx: any) => ctx.db.patch("work", workId, { attempts: 1 }));
    await complete([{ workId, runResult: { kind: "failed", error: "test error" }, attempt: 1 }]);
    expect(await getWork(workId)).toBeNull();
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult.kind).toBe("failed");
    expect(completions[0].retry).toBe(false);
  });

  it("should process a canceled job", async () => {
    const workId = await enqueue();
    await complete([{ workId, runResult: { kind: "canceled" }, attempt: 0 }]);
    expect(await getWork(workId)).toBeNull();
    expect(await completionsOf(workId)).toHaveLength(0);
  });

  it("should ping after inserting a terminal completion even when saturated", async () => {
    const workId = await seedSaturatedRunningWork();
    expect(await workerStatus(t)).toBeNull();
    await complete([{ workId, runResult: { kind: "success", returnValue: "test result" }, attempt: 0 }]);
    expect(await workerStatus(t)).toBe("running");
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].retry).toBe(false);
  });

  it("should ping after inserting a retry completion even when saturated", async () => {
    const workId = await seedSaturatedRunningWork(retryBehavior);
    expect(await workerStatus(t)).toBeNull();
    await complete([{ workId, runResult: { kind: "failed", error: "test error" }, attempt: 0 }]);
    expect(await workerStatus(t)).toBe("running");
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].retry).toBe(true);
  });

  it("should call onComplete handler for successful jobs", async () => {
    const runAfter = mock(async () => "scheduled");
    const workId = await enqueue({ onComplete: { fnHandle: "testOnComplete", context: { someContext: "value" } } });
    await t.run(async (ctx: any) => {
      const spyCtx = { ...ctx, scheduler: { ...ctx.scheduler, runAfter } };
      await completeHandler(spyCtx, {
        jobs: [{ workId, runResult: { kind: "success", returnValue: "test result" }, attempt: 0 }],
      });
    });
    expect(runAfter).toHaveBeenCalledWith(
      0,
      "testOnComplete",
      expect.objectContaining({
        workId,
        context: { someContext: "value" },
        result: { kind: "success", returnValue: "test result" },
      }),
    );
  });

  it("should handle multiple jobs in a single call", async () => {
    const workId1 = await enqueue({ fnArgs: { test: 1 } });
    const workId2 = await enqueue({ fnArgs: { test: 2 }, retryBehavior });
    await complete([
      { workId: workId1, runResult: { kind: "success", returnValue: "result 1" }, attempt: 0 },
      { workId: workId2, runResult: { kind: "failed", error: "error 2" }, attempt: 0 },
    ]);
    expect(await getWork(workId1)).toBeNull();
    expect((await getWork(workId2))?.attempts).toBe(1);
    expect(await t.run((ctx: any) => ctx.db.query("pendingCompletion").collect())).toHaveLength(2);
  });

  it("should handle mismatched attempt numbers", async () => {
    const workId = await enqueue();
    await t.run((ctx: any) => ctx.db.patch("work", workId, { attempts: 5 }));
    await complete([{ workId, runResult: { kind: "success", returnValue: "test result" }, attempt: 0 }]);
    expect((await getWork(workId))?.attempts).toBe(5);
    expect(await completionsOf(workId)).toHaveLength(0);
  });

  it("should only process the first call with the same attempt number for retries", async () => {
    const workId = await enqueue({ retryBehavior });
    await complete([{ workId, runResult: { kind: "failed", error: "first error" }, attempt: 0 }]);
    expect((await getWork(workId))?.attempts).toBe(1);
    let completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ retry: true, runResult: { kind: "failed", error: "first error" } });

    const runMutation = mock();
    await t.run(async (ctx: any) => {
      await completeHandler({ ...ctx, runMutation } as any, {
        jobs: [{ workId, runResult: { kind: "failed", error: "second error" }, attempt: 0 }],
      });
    });
    expect((await getWork(workId))?.attempts).toBe(1);
    completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ retry: true, runResult: { kind: "failed", error: "first error" } });
    expect(runMutation).not.toHaveBeenCalled();
  });

  // More (STUDY-199 §1.11): a batch over 2 MB is split, and every batch after the first is scheduled.
  it("schedules the jobs past 2 MB as another complete", async () => {
    const ids: Id<"work">[] = [];
    for (let i = 0; i < 3; i++) ids.push(await enqueue({ fnArgs: { big: "x".repeat(900_000), i } }));
    await complete(ids.map((workId) => ({ workId, runResult: { kind: "success", returnValue: null }, attempt: 0 })));
    // The first two fit in one batch; the third waits for the scheduled call.
    expect(await getWork(ids[0]!)).toBeNull();
    expect(await getWork(ids[1]!)).toBeNull();
    expect(await getWork(ids[2]!)).not.toBeNull();
    const scheduled = (await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())) as any[];
    const later = scheduled.filter((s) => /^complete(\.js)?:complete$/.test(s.name));
    expect(later.map((s) => s.args[0].jobs.map((j: any) => j.workId))).toEqual([[ids[2]]]);
  });
});

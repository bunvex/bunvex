// Upstream's `src/component/recovery.test.ts` (get-convex/workpool 0.4.14, STUDY-199 §1.19), ported. Upstream patches
// `ctx.db.system.get` to fake a scheduled function's state; here each state is real (STUDY-199 §3.4): a job that
// failed (`testing:fail`), one canceled before it ran, one still pending, one that succeeded, and one the scheduler
// garbage-collected a week after it ran (the "not found" case, upstream's issue #225). A failed job's error is the
// scheduler's own text, read back from `_scheduled_functions`.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createFunctionHandle } from "@bunvex/server";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import { recoveryHandler } from "../src/component/recovery.ts";
import { api, scheduledGone, scheduledIn, setupTest } from "./helpers.ts";

setDefaultTimeout(30_000);

const ALL_KINDS = ["success", "failed", "canceled"] as const;
let t: ReturnType<typeof setupTest>;
beforeEach(async () => {
  t = setupTest();
  await t.run((ctx: any) => ctx.db.insert("globals", { maxParallelism: 10, logLevel: "WARN" }));
});

const makeDummyWork = (overrides: Partial<Doc<"work">> = {}) =>
  t.run((ctx: any) =>
    ctx.db.insert("work", {
      fnType: "action",
      fnHandle: "test_handle",
      fnName: "test_handle",
      fnArgs: {},
      attempts: 0,
      ...overrides,
    }),
  ) as Promise<Id<"work">>;
const completionsOf = (workId: Id<"work">) =>
  t.run((ctx: any) =>
    ctx.db
      .query("pendingCompletion")
      .withIndex("workId", (q: any) => q.eq("workId", workId))
      .collect(),
  ) as Promise<any[]>;
const scheduledError = (id: Id<"_scheduled_functions">) =>
  t.run(async (ctx: any) => (await ctx.db.system.get("_scheduled_functions", id)).state.error) as Promise<string>;
const recover = (jobs: { scheduledId: string; workId: string; attempt: number; started: number }[]) =>
  t.mutation(api.recovery.recover, { jobs });

for (const mode of ["all", "failed", "canceled", "success", "none"] as const) {
  describe(`${mode} callbacks`, () => {
    for (const state of ["missing", "failed", "canceled"] as const) {
      it(`dispatches the appropriate callback for a ${state} scheduled job`, async () => {
        const scheduledId =
          state === "missing"
            ? await scheduledGone(t)
            : await scheduledIn(t, state === "failed" ? "failed" : "canceled");
        const error =
          state === "missing"
            ? "Scheduled job not found"
            : state === "failed"
              ? await scheduledError(scheduledId)
              : "Canceled via scheduler";
        const handle = await t.run(() => createFunctionHandle(api.testing.complete));
        const workId = await makeDummyWork({
          onComplete: {
            fnHandle: handle,
            context: { key: state },
            excludeKinds: mode === "all" ? undefined : ALL_KINDS.filter((k) => k !== mode),
          },
        });
        const job = { workId, scheduledId, attempt: 0, started: t.now() };
        await recover([job]);
        // A repeated recovery scan does not dispatch the callback again.
        await recover([job]);
        await t.finishAllScheduledFunctions(undefined, 1000);
        const calls = (await t.mutation(api.testing.calls, {})) as any[];
        if (mode !== "all" && mode !== "failed") {
          expect(calls).toEqual([]);
        } else {
          expect(calls).toEqual([{ workId, context: { key: state }, result: { kind: "failed", error } }]);
        }
        expect(await t.run((ctx: any) => ctx.db.get("work", workId))).toBeNull();
      });
    }
  });
}

describe("recover", () => {
  it("should skip jobs that already have a pendingCompletion", async () => {
    const workId = await makeDummyWork();
    const scheduledId = await scheduledIn(t, "failed");
    await t.run((ctx: any) =>
      ctx.db.insert("pendingCompletion", {
        segment: 1n,
        workId,
        runResult: { kind: "failed", error: "test error" },
        retry: true,
      }),
    );
    await recover([{ scheduledId, workId, attempt: 0, started: t.now() }]);
    expect(await completionsOf(workId)).toHaveLength(1);
  });

  it("should skip jobs where work is not found", async () => {
    const workId = await makeDummyWork();
    const scheduledId = await scheduledIn(t, "failed");
    await t.run((ctx: any) => ctx.db.delete("work", workId));
    await recover([{ scheduledId, workId, attempt: 0, started: t.now() }]);
    expect(await completionsOf(workId)).toHaveLength(0);
  });

  it("should skip jobs where work attempts mismatch", async () => {
    const workId = await makeDummyWork({ attempts: 5 });
    const scheduledId = await scheduledIn(t, "failed");
    await recover([{ scheduledId, workId, attempt: 0, started: t.now() }]);
    expect(await completionsOf(workId)).toHaveLength(0);
  });

  it("should handle scheduled job not found", async () => {
    const scheduledId = await scheduledGone(t);
    const workId = await makeDummyWork();
    await t.run((ctx: any) =>
      recoveryHandler(ctx, { jobs: [{ scheduledId, workId, attempt: 0, started: Date.now() }] }),
    );
    const [completion] = await completionsOf(workId);
    expect(completion.runResult.kind).toBe("failed");
    expect(completion.runResult.error).toContain("Scheduled job not found");
  });

  it("should handle failed scheduled jobs", async () => {
    const workId = await makeDummyWork();
    const scheduledId = await scheduledIn(t, "failed");
    const error = await scheduledError(scheduledId);
    await t.run((ctx: any) =>
      recoveryHandler(ctx, { jobs: [{ scheduledId, workId, attempt: 0, started: Date.now() }] }),
    );
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    // The scheduler's state, as it is.
    expect(completions[0].runResult).toEqual({ kind: "failed", error });
    expect(error).toStartWith("Uncaught Error: boom\n");
  });

  it("should handle canceled scheduled jobs", async () => {
    const workId = await makeDummyWork();
    const scheduledId = await scheduledIn(t, "canceled");
    await t.run((ctx: any) =>
      recoveryHandler(ctx, { jobs: [{ scheduledId, workId, attempt: 0, started: Date.now() }] }),
    );
    const completions = await completionsOf(workId);
    expect(completions).toHaveLength(1);
    expect(completions[0].runResult).toEqual({ kind: "failed", error: "Canceled via scheduler" });
  });

  it("should handle multiple jobs in a single call", async () => {
    const workId1 = await makeDummyWork({ fnArgs: { test: 1 } });
    const workId2 = await makeDummyWork({ fnArgs: { test: 2 } });
    const scheduledId1 = await scheduledIn(t, "failed");
    const scheduledId2 = await scheduledIn(t, "canceled");
    const error = await scheduledError(scheduledId1);
    await t.run((ctx: any) =>
      recoveryHandler(ctx, {
        jobs: [
          { scheduledId: scheduledId1, workId: workId1, attempt: 0, started: Date.now() },
          { scheduledId: scheduledId2, workId: workId2, attempt: 0, started: Date.now() },
        ],
      }),
    );
    const all = (await t.run((ctx: any) => ctx.db.query("pendingCompletion").collect())) as any[];
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.workId === workId1).runResult).toEqual({ kind: "failed", error });
    expect(all.find((c) => c.workId === workId2).runResult).toEqual({
      kind: "failed",
      error: "Canceled via scheduler",
    });
  });

  for (const state of ["pending", "success"] as const) {
    it(`should not process jobs with other scheduled states (${state})`, async () => {
      const workId = await makeDummyWork();
      const scheduledId = await scheduledIn(t, state);
      await t.run((ctx: any) =>
        recoveryHandler(ctx, { jobs: [{ scheduledId, workId, attempt: 0, started: Date.now() }] }),
      );
      expect(await completionsOf(workId)).toHaveLength(0);
    });
  }

  // More (STUDY-199 §3.4): a recovered failure goes through the retry rules.
  it("retries a recovered failure when the job has attempts left", async () => {
    const workId = await makeDummyWork({ retryBehavior: { maxAttempts: 2, initialBackoffMs: 10, base: 2 } });
    const scheduledId = await scheduledIn(t, "canceled");
    await recover([{ scheduledId, workId, attempt: 0, started: t.now() }]);
    const [completion] = await completionsOf(workId);
    expect(completion).toMatchObject({ retry: true, runResult: { kind: "failed", error: "Canceled via scheduler" } });
    expect((await t.run((ctx: any) => ctx.db.get("work", workId)))?.attempts).toBe(1);
  });

  // More (STUDY-199 §2.3): every item of one `runBatch` records its scheduled id. If that action dies, the recovery
  // iteration fails every item still open with the scheduler's one error, and each goes through `complete`.
  it("recovers every item of a dead runBatch that shares its scheduled id", async () => {
    const handle = await t.run(() => createFunctionHandle(api.testing.complete));
    const ids = await t.run(async (ctx: any) => {
      const out: Id<"work">[] = [];
      for (let i = 0; i < 3; i++)
        out.push(
          await ctx.db.insert("work", {
            fnType: "action",
            fnHandle: "test_handle",
            fnName: "test_handle",
            fnArgs: {},
            attempts: 0,
            onComplete: { fnHandle: handle, context: { i } },
          }),
        );
      return out;
    });
    // A real `runBatch` that dies before running any item: its arguments fail validation when it runs.
    const scheduledId = await t.run((ctx: any) =>
      ctx.scheduler.runAfter(0, api.worker.runBatch, {
        logLevel: "WARN",
        items: ids.map((workId) => ({ workId, fnHandle: "test_handle", attempt: 0, fnType: "mutation" })),
      }),
    );
    await t.advanceTime(10);
    const dead = (await t.run((ctx: any) => ctx.db.system.get("_scheduled_functions", scheduledId))) as any;
    expect(dead.state.kind).toBe("failed");
    // The loop started them all in that one batch, six minutes ago.
    await t.run((ctx: any) =>
      ctx.db.insert("internalState", {
        generation: 0n,
        segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
        lastRecovery: 0n,
        report: { completed: 0, succeeded: 0, failed: 0, retries: 0, canceled: 0, lastReportTs: Date.now() },
        running: ids.map((workId) => ({ workId, scheduledId, started: Date.now() - 6 * 60_000 })),
      }),
    );
    const batch = (await t.query(api.loop.getBatch, { name: "main" })) as any;
    expect(batch.batch.recovery).toBe(true);
    await t.mutation(api.loop.run, batch.batch);
    // One `recover` with the three jobs, then `complete`, the callbacks and the loop's retirement of them.
    await t.finishAllScheduledFunctions(undefined, 1000);
    const calls = (await t.mutation(api.testing.calls, {})) as any[];
    expect(calls).toHaveLength(3);
    for (const [i, workId] of ids.entries()) {
      expect(calls.find((c) => c.workId === workId)).toEqual({
        workId,
        context: { i },
        result: { kind: "failed", error: dead.state.error },
      });
    }
    const state = (await t.run((ctx: any) => ctx.db.query("internalState").unique())) as any;
    expect(state.running).toEqual([]);
    expect(await t.run((ctx: any) => ctx.db.query("work").collect())).toEqual([]);
  });
});

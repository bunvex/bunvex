// Upstream's `src/component/stateMachine.test.ts` (get-convex/workpool 0.4.14, STUDY-199 §1.19), ported: every
// transition between the job's composite states (S1–S12) for the loop, `complete`, `cancel` and recovery, garbage-
// collected scheduled ids (upstream's issue #225), invalid states and interleavings. The three cases named "BUG"
// assert today's behaviour, as upstream's do (STUDY-199 §2.3, W-3).
//
// Upstream sets vitest's clock to a segment (`vi.setSystemTime`); the virtual clock only moves forward, so `runLoop`
// moves it there when the segment is ahead. Moving it runs what is due, so the batch worker is stopped first: the loop
// is driven by hand only, as upstream's fake timers keep it. A running job's scheduled id is a pending
// `testing:noop` (upstream schedules the legacy `runActionWrapper`, not built, DV-539), and a garbage-collected one is
// real (upstream deletes the system row).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import { kickMainLoop } from "../src/component/kick.ts";
import { RECOVERY_PERIOD_SEGMENTS } from "../src/component/loop.ts";
import { DEFAULT_MAX_PARALLELISM, fromSegment, SECOND, toSegment, WORKER_NAME } from "../src/component/shared.ts";
import { api, components, emptyReport, MINUTE, scheduledGone, setupTest } from "./helpers.ts";

setDefaultTimeout(30_000);

type WorkConfig = { attempts: number; canceled?: boolean; hasRetryBehavior: boolean; fnType: "action" | "mutation" };
type PendingCompletionConfig = false | { retry: boolean; resultKind: "success" | "failed" | "canceled" };
/** A job's state across all the tables. */
type CompositeState = {
  work: false | WorkConfig;
  pendingStart: boolean;
  running: boolean;
  pendingCompletion: PendingCompletionConfig;
  pendingCancelation: boolean;
};

const S1_ENQUEUED: CompositeState = {
  work: { attempts: 0, hasRetryBehavior: false, fnType: "action" },
  pendingStart: true,
  running: false,
  pendingCompletion: false,
  pendingCancelation: false,
};
const S2_RUNNING: CompositeState = {
  work: { attempts: 0, hasRetryBehavior: false, fnType: "action" },
  pendingStart: false,
  running: true,
  pendingCompletion: false,
  pendingCancelation: false,
};
const S2_RUNNING_WITH_RETRIES: CompositeState = {
  ...S2_RUNNING,
  work: { attempts: 0, hasRetryBehavior: true, fnType: "action" },
};
const S3_COMPLETING_NO_RETRY: CompositeState = {
  work: false,
  pendingStart: false,
  running: true,
  pendingCompletion: { retry: false, resultKind: "success" },
  pendingCancelation: false,
};
const S3_COMPLETING_FAILED_FINAL: CompositeState = {
  ...S3_COMPLETING_NO_RETRY,
  pendingCompletion: { retry: false, resultKind: "failed" },
};
const S5_COMPLETING_WILL_RETRY: CompositeState = {
  work: { attempts: 1, hasRetryBehavior: true, fnType: "action" },
  pendingStart: false,
  running: true,
  pendingCompletion: { retry: true, resultKind: "failed" },
  pendingCancelation: false,
};
const S7_CANCEL_PENDING: CompositeState = { ...S1_ENQUEUED, pendingCancelation: true };
const S8_CANCEL_RUNNING: CompositeState = { ...S2_RUNNING, pendingCancelation: true };
const S9_CANCELED_RETRYING: CompositeState = {
  ...S5_COMPLETING_WILL_RETRY,
  work: { attempts: 1, canceled: true, hasRetryBehavior: true, fnType: "action" },
};
const S10_REENQUEUED: CompositeState = {
  work: { attempts: 1, hasRetryBehavior: true, fnType: "action" },
  pendingStart: true,
  running: false,
  pendingCompletion: false,
  pendingCancelation: false,
};
const S12_CANCELED_AWAITING_COMPLETE: CompositeState = {
  ...S2_RUNNING,
  work: { attempts: 0, canceled: true, hasRetryBehavior: false, fnType: "action" },
};
const ABSENT: CompositeState = {
  work: false,
  pendingStart: false,
  running: false,
  pendingCompletion: false,
  pendingCancelation: false,
};

const ACTION_RECOVERY_THRESHOLD_MS = 5 * 60 * 1000;
const retryBehavior = { maxAttempts: 5, initialBackoffMs: 100, base: 2 };

let t: ReturnType<typeof setupTest>;
const currentSegment = () => toSegment(t.now());
const nextSegment = () => currentSegment() + 1n;

beforeEach(async () => {
  t = setupTest();
  await t.run((ctx: any) => ctx.db.insert("globals", { logLevel: "ERROR", maxParallelism: DEFAULT_MAX_PARALLELISM }));
  // The worker exists and is stopped: pings are no-ops, and moving the clock runs no loop of its own.
  await t.run((ctx: any) => kickMainLoop(ctx));
  await t.mutation(components.batchWorker.lib.stop, { name: WORKER_NAME });
});

const makeDummyWork = (ctx: any, overrides: Partial<Doc<"work">> = {}) =>
  ctx.db.insert("work", {
    fnType: "action",
    fnHandle: "test_handle",
    fnName: "test_fn",
    fnArgs: {},
    attempts: 0,
    ...overrides,
  });
const makeDummyScheduledFunction = (ctx: any) => ctx.scheduler.runAfter(10 * MINUTE, api.testing.noop, {});
const insertState = (ctx: any, running: Doc<"internalState">["running"], lastRecovery = toSegment(Date.now())) =>
  ctx.db.insert("internalState", {
    generation: 0n,
    segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
    lastRecovery,
    report: emptyReport(Date.now()),
    running,
  });

/** Write `state` to the tables; the work id is real even when the work is absent (inserted, then deleted). */
async function setupState(
  state: CompositeState,
  opts?: { oldForRecovery?: boolean; segment?: bigint; gcScheduledRow?: boolean },
): Promise<{ workId: Id<"work">; segment: bigint; scheduledId?: Id<"_scheduled_functions"> }> {
  // A garbage-collected scheduled function, first: it takes a week of the clock.
  const gone = opts?.gcScheduledRow ? await scheduledGone(t) : undefined;
  const seg = opts?.segment ?? currentSegment();
  let scheduledId: Id<"_scheduled_functions"> | undefined;
  const workId = await t.run(async (ctx: any) => {
    let wId: Id<"work">;
    if (state.work) {
      wId = await makeDummyWork(ctx, {
        fnType: state.work.fnType,
        attempts: state.work.attempts,
        canceled: state.work.canceled,
        retryBehavior: state.work.hasRetryBehavior ? retryBehavior : undefined,
      });
    } else {
      wId = await makeDummyWork(ctx);
      await ctx.db.delete("work", wId);
    }
    const running: Doc<"internalState">["running"] = [];
    if (state.running) {
      scheduledId = gone ?? (await makeDummyScheduledFunction(ctx));
      const started = opts?.oldForRecovery ? Date.now() - ACTION_RECOVERY_THRESHOLD_MS - 10_000 : Date.now();
      running.push({ workId: wId, scheduledId: scheduledId!, started });
    }
    const now = toSegment(Date.now());
    await insertState(ctx, running, opts?.oldForRecovery ? now - RECOVERY_PERIOD_SEGMENTS - 1n : now);
    if (state.pendingStart) await ctx.db.insert("pendingStart", { workId: wId, segment: seg });
    if (state.pendingCompletion) {
      const results = {
        success: { kind: "success" as const, returnValue: null },
        failed: { kind: "failed" as const, error: "test error" },
        canceled: { kind: "canceled" as const },
      };
      await ctx.db.insert("pendingCompletion", {
        workId: wId,
        segment: seg,
        retry: state.pendingCompletion.retry,
        runResult: results[state.pendingCompletion.resultKind],
      });
    }
    if (state.pendingCancelation) await ctx.db.insert("pendingCancelation", { workId: wId, segment: seg });
    return wId;
  });
  return { workId, segment: seg, scheduledId };
}

/** The job's state, read back. */
function observeState(workId: Id<"work">) {
  return t.run(async (ctx: any) => {
    const byWork = (table: string) =>
      ctx.db
        .query(table)
        .withIndex("workId", (q: any) => q.eq("workId", workId))
        .first();
    const work = await ctx.db.get("work", workId);
    const state = await ctx.db.query("internalState").unique();
    const pc = await byWork("pendingCompletion");
    return {
      work: work
        ? {
            attempts: work.attempts as number,
            canceled: !!work.canceled,
            hasRetryBehavior: !!work.retryBehavior,
            fnType: work.fnType as string,
          }
        : (false as const),
      pendingStart: !!(await byWork("pendingStart")),
      running: (state?.running.some((r: any) => r.workId === workId) ?? false) as boolean,
      pendingCompletion: pc
        ? { retry: pc.retry as boolean, resultKind: pc.runResult.kind as string }
        : (false as const),
      pendingCancelation: !!(await byWork("pendingCancelation")),
    };
  });
}

/** One loop iteration at `segment`: the clock moves there first when it is ahead. */
async function runLoop(segment: bigint) {
  const ahead = fromSegment(segment) - t.now();
  if (ahead > 0) await t.advanceTime(ahead);
  const result = (await t.query(api.loop.getBatch, { name: WORKER_NAME })) as any;
  if (result.kind === "work") await t.mutation(api.loop.run, result.batch);
}

async function runComplete(workId: Id<"work">, kind: "success" | "failed" | "canceled", attempt: number) {
  const runResult =
    kind === "success"
      ? { kind, returnValue: null }
      : kind === "failed"
        ? { kind, error: "test error" }
        : { kind: "canceled" as const };
  await t.mutation(api.complete.complete, { jobs: [{ workId, runResult, attempt }] });
}

describe("loop transitions", () => {
  it("S1 enqueued -> S2 running: starts work", async () => {
    const { workId, segment } = await setupState(S1_ENQUEUED);
    await runLoop(segment);
    const s = await observeState(workId);
    expect(s.work).toBeTruthy();
    expect(s).toMatchObject({
      pendingStart: false,
      running: true,
      pendingCompletion: false,
      pendingCancelation: false,
    });
  });

  it("S10 re-enqueued -> S2 running: starts retry work", async () => {
    const { workId, segment } = await setupState(S10_REENQUEUED);
    await runLoop(segment);
    const s = await observeState(workId);
    expect(s.work).toBeTruthy();
    expect(s).toMatchObject({ pendingStart: false, running: true });
  });

  it("S3 completing (success, no retry) -> finished: removes from running", async () => {
    const { workId, segment } = await setupState(S3_COMPLETING_NO_RETRY);
    await runLoop(segment);
    expect(await observeState(workId)).toEqual({
      work: false,
      pendingStart: false,
      running: false,
      pendingCompletion: false,
      pendingCancelation: false,
    });
  });

  it("S3 completing (failed, no retry) -> finished: removes from running", async () => {
    const { workId, segment } = await setupState(S3_COMPLETING_FAILED_FINAL);
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ work: false, running: false, pendingCompletion: false });
  });

  it("S5 completing (will retry) -> retried: reschedules and may restart immediately", async () => {
    const { workId, segment } = await setupState(S5_COMPLETING_WILL_RETRY);
    await runLoop(segment);
    const s = await observeState(workId);
    expect(s.work).toBeTruthy();
    expect(s.pendingCompletion).toBe(false);
    expect(s.pendingStart || s.running).toBe(true);
  });

  it("S7 cancel-pending -> canceled: deletes pendingStart, marks canceled", async () => {
    const { workId, segment } = await setupState(S7_CANCEL_PENDING);
    await runLoop(segment);
    const s = await observeState(workId);
    expect(s).toMatchObject({ pendingStart: false, pendingCancelation: false, running: false });
    if (s.work) expect(s.work.canceled).toBe(true);
  });

  it("S8 cancel-running -> S12 canceled, still running", async () => {
    const { workId, segment } = await setupState(S8_CANCEL_RUNNING);
    await runLoop(segment);
    const s = await observeState(workId);
    expect(s).toMatchObject({ pendingCancelation: false, running: true, work: { canceled: true } });
  });

  it("S9 canceled+retrying -> does not retry, cancels instead", async () => {
    const { workId, segment } = await setupState(S9_CANCELED_RETRYING);
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ running: false, pendingCompletion: false, pendingStart: false });
  });

  it("S2 running (no pending events) -> S2 no change", async () => {
    const { workId, segment } = await setupState(S2_RUNNING);
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ running: true, work: { attempts: 0 } });
  });

  it("S12 canceled awaiting complete -> no change (still running)", async () => {
    const { workId, segment } = await setupState(S12_CANCELED_AWAITING_COMPLETE);
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ running: true, work: { canceled: true } });
  });
});

describe("complete.complete transitions", () => {
  it("S2 running + complete(success) -> work deleted, pendingCompletion(retry=false)", async () => {
    const { workId } = await setupState(S2_RUNNING);
    await runComplete(workId, "success", 0);
    expect(await observeState(workId)).toMatchObject({
      work: false,
      pendingCompletion: { retry: false, resultKind: "success" },
    });
  });

  it("S2 running (with retries) + complete(failed) -> work kept, pendingCompletion(retry=true)", async () => {
    const { workId } = await setupState(S2_RUNNING_WITH_RETRIES);
    await runComplete(workId, "failed", 0);
    expect(await observeState(workId)).toMatchObject({ work: { attempts: 1 }, pendingCompletion: { retry: true } });
  });

  it("S2 running (no retries) + complete(failed) -> work deleted, pendingCompletion(retry=false)", async () => {
    const { workId } = await setupState(S2_RUNNING);
    await runComplete(workId, "failed", 0);
    expect(await observeState(workId)).toMatchObject({
      work: false,
      pendingCompletion: { retry: false, resultKind: "failed" },
    });
  });

  it("S2 running + complete(canceled) -> work deleted, NO pendingCompletion", async () => {
    const { workId } = await setupState(S2_RUNNING);
    await runComplete(workId, "canceled", 0);
    expect(await observeState(workId)).toMatchObject({ work: false, pendingCompletion: false });
  });

  it("S12 canceled running + complete(success) -> work deleted (complete ignores canceled flag)", async () => {
    const { workId } = await setupState(S12_CANCELED_AWAITING_COMPLETE);
    await runComplete(workId, "success", 0);
    expect(await observeState(workId)).toMatchObject({ work: false, pendingCompletion: { retry: false } });
  });

  it("complete with wrong attempt number -> no-op", async () => {
    const { workId } = await setupState(S2_RUNNING);
    await runComplete(workId, "success", 999);
    expect(await observeState(workId)).toMatchObject({ work: { attempts: 0 }, pendingCompletion: false });
  });

  it("complete on absent work -> no-op", async () => {
    const { workId } = await setupState({ ...ABSENT, running: true });
    await runComplete(workId, "success", 0);
    expect(await observeState(workId)).toMatchObject({ work: false, pendingCompletion: false });
  });

  it("duplicate complete -> second one is no-op (attempt mismatch)", async () => {
    const { workId } = await setupState(S2_RUNNING_WITH_RETRIES);
    await runComplete(workId, "failed", 0);
    expect((await observeState(workId)).work).toMatchObject({ attempts: 1 });
    await runComplete(workId, "failed", 0);
    expect((await observeState(workId)).work).toMatchObject({ attempts: 1 });
  });

  it("duplicate complete with correct attempt -> BUG: attempts incremented before dedup check", async () => {
    const { workId } = await setupState(S2_RUNNING_WITH_RETRIES);
    await runComplete(workId, "failed", 0);
    expect((await observeState(workId)).work).toMatchObject({ attempts: 1 });
    // The second call finds the pendingCompletion only after counting the attempt (upstream's BUG, kept: W-3).
    await runComplete(workId, "failed", 1);
    expect((await observeState(workId)).work).toMatchObject({ attempts: 2 });
  });
});

describe("lib.cancel transitions", () => {
  it("S1 enqueued + cancel -> adds pendingCancelation", async () => {
    const { workId } = await setupState(S1_ENQUEUED);
    await t.mutation(api.lib.cancel, { id: workId });
    const s = await observeState(workId);
    expect(s.work).toBeTruthy();
    expect(s).toMatchObject({ pendingStart: true, pendingCancelation: true });
  });

  it("S2 running + cancel -> adds pendingCancelation", async () => {
    const { workId } = await setupState(S2_RUNNING);
    await t.mutation(api.lib.cancel, { id: workId });
    const s = await observeState(workId);
    expect(s.work).toBeTruthy();
    expect(s).toMatchObject({ running: true, pendingCancelation: true });
  });

  it("S10 re-enqueued + cancel -> adds pendingCancelation", async () => {
    const { workId } = await setupState(S10_REENQUEUED);
    await t.mutation(api.lib.cancel, { id: workId });
    expect(await observeState(workId)).toMatchObject({ pendingStart: true, pendingCancelation: true });
  });

  it("absent work + cancel -> no-op", async () => {
    const { workId } = await setupState(ABSENT);
    await t.mutation(api.lib.cancel, { id: workId });
    expect((await observeState(workId)).pendingCancelation).toBe(false);
  });

  it("S7 already cancel-pending + cancel -> no-op (dedup)", async () => {
    const { workId } = await setupState(S7_CANCEL_PENDING);
    await t.mutation(api.lib.cancel, { id: workId });
    const count = await t.run(
      async (ctx: any) =>
        (
          await ctx.db
            .query("pendingCancelation")
            .withIndex("workId", (q: any) => q.eq("workId", workId))
            .collect()
        ).length,
    );
    expect(count).toBe(1);
  });
});

describe("recovery transitions", () => {
  const recoverySegment = () => currentSegment() + RECOVERY_PERIOD_SEGMENTS + 1n;

  it("work absent + running (old, no pendingCompletion) -> removed from running", async () => {
    const { workId } = await setupState({ ...ABSENT, running: true }, { oldForRecovery: true });
    await runLoop(recoverySegment());
    expect((await observeState(workId)).running).toBe(false);
  });

  it("work absent + running (old) + pendingCompletion -> handleCompletions processes first", async () => {
    const { workId } = await setupState(
      { ...ABSENT, running: true, pendingCompletion: { retry: false, resultKind: "success" } },
      { oldForRecovery: true },
    );
    await runLoop(recoverySegment());
    expect(await observeState(workId)).toMatchObject({ pendingCompletion: false, running: false });
  });

  it("S2 running action (old, not yet completed) -> recovery checks scheduled function", async () => {
    const { workId } = await setupState(S2_RUNNING, { oldForRecovery: true });
    await runLoop(recoverySegment());
    expect((await observeState(workId)).running).toBe(true);
  });

  it("S12 canceled running (old) -> recovery doesn't crash on canceled work", async () => {
    const { workId } = await setupState(S12_CANCELED_AWAITING_COMPLETE, { oldForRecovery: true });
    await runLoop(recoverySegment());
    expect((await observeState(workId)).work).toMatchObject({ canceled: true });
  });
});

describe("GC'd scheduledId in running", () => {
  it("consumes a pending completion and starts backlog despite GC'd scheduledId", async () => {
    const { workId, segment } = await setupState(
      { ...ABSENT, running: true, pendingCompletion: { retry: false, resultKind: "success" } },
      { gcScheduledRow: true },
    );
    const backlogWorkId = await t.run(async (ctx: any) => {
      const id = await makeDummyWork(ctx);
      await ctx.db.insert("pendingStart", { workId: id, segment });
      return id;
    });
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ pendingCompletion: false, running: false });
    expect(await observeState(backlogWorkId)).toMatchObject({ pendingStart: false, running: true });
  });

  it("recovery fails a job whose scheduledId is GC'd and no completion exists", async () => {
    const { workId, scheduledId } = await setupState(
      { ...ABSENT, work: { attempts: 0, hasRetryBehavior: true, fnType: "action" }, running: true },
      { oldForRecovery: true, gcScheduledRow: true },
    );
    await t.mutation(api.recovery.recover, { jobs: [{ scheduledId, workId, attempt: 0, started: t.now() }] });
    expect(await observeState(workId)).toMatchObject({
      work: { attempts: 1 },
      pendingCompletion: { retry: true, resultKind: "failed" },
    });
    await runLoop(currentSegment());
    const s = await observeState(workId);
    expect(s.pendingCompletion).toBe(false);
    expect(s.pendingStart || s.running).toBe(true);
  });

  it("recovery scan tolerates a GC'd scheduledId for a live job", async () => {
    const { workId, segment } = await setupState(S2_RUNNING, { oldForRecovery: true, gcScheduledRow: true });
    await runLoop(segment + RECOVERY_PERIOD_SEGMENTS + 1n);
    expect((await observeState(workId)).running).toBe(true);
  });
});

describe("invalid states", () => {
  it("work absent + pendingStart -> loop handles gracefully (no throw)", async () => {
    const { workId, segment } = await setupState({ ...ABSENT, pendingStart: true });
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ pendingStart: false, work: false, running: false });
  });

  it("pendingStart + running for same workId -> skips start but leaves pendingStart", async () => {
    const { workId, segment } = await setupState({ ...S1_ENQUEUED, running: true });
    await runLoop(segment);
    // Upstream's BUG, kept (W-3): the start is skipped and its pendingStart stays, read again each iteration.
    expect(await observeState(workId)).toMatchObject({ running: true, pendingStart: true });
  });

  it("duplicate pendingCompletion via complete.complete -> BUG: attempts still incremented", async () => {
    const { workId } = await setupState(S2_RUNNING_WITH_RETRIES);
    await runComplete(workId, "failed", 0);
    await runComplete(workId, "failed", 1);
    expect((await observeState(workId)).work).toMatchObject({ attempts: 2 });
    const count = await t.run(
      async (ctx: any) =>
        (
          await ctx.db
            .query("pendingCompletion")
            .withIndex("workId", (q: any) => q.eq("workId", workId))
            .collect()
        ).length,
    );
    expect(count).toBe(1);
  });
});

describe("multi-step / interleaved transitions", () => {
  it("completion + new enqueue -> loop processes both in one pass", async () => {
    const seg = currentSegment();
    const { workId: w1 } = await setupState(S1_ENQUEUED, { segment: seg });
    await runLoop(seg);
    await runComplete(w1, "success", 0);
    const w2 = await t.run(async (ctx: any) => {
      const id = await makeDummyWork(ctx, { fnName: "test_fn2" });
      await ctx.db.insert("pendingStart", { workId: id, segment: seg });
      return id;
    });
    await runLoop(seg);
    expect(await observeState(w1)).toMatchObject({ work: false, running: false });
    expect((await observeState(w2)).running).toBe(true);
  });

  it("two jobs complete(retry) before loop -> loop retries both", async () => {
    const seg = currentSegment();
    const ids = await t.run(async (ctx: any) => {
      const w1 = await makeDummyWork(ctx, { fnHandle: "h1", fnName: "fn1", retryBehavior });
      const w2 = await makeDummyWork(ctx, { fnHandle: "h2", fnName: "fn2", retryBehavior });
      const s1 = await makeDummyScheduledFunction(ctx);
      const s2 = await makeDummyScheduledFunction(ctx);
      await insertState(ctx, [
        { workId: w1, scheduledId: s1, started: Date.now() },
        { workId: w2, scheduledId: s2, started: Date.now() },
      ]);
      return { w1, w2 };
    });
    await runComplete(ids.w1, "failed", 0);
    await runComplete(ids.w2, "failed", 0);
    expect((await observeState(ids.w1)).pendingCompletion).toMatchObject({ retry: true });
    expect((await observeState(ids.w2)).pendingCompletion).toMatchObject({ retry: true });
    // The retries' starts are a jittered backoff ahead; past it, the next pass starts them.
    await runLoop(seg);
    await runLoop(toSegment(t.now() + SECOND));
    for (const id of [ids.w1, ids.w2]) {
      expect(await observeState(id)).toMatchObject({
        pendingCompletion: false,
        running: true,
        pendingStart: false,
        work: { attempts: 1 },
      });
    }
  });

  it("cancel arrives while retry completion is pending -> cancel wins", async () => {
    const { workId, segment } = await setupState(S5_COMPLETING_WILL_RETRY);
    await t.run((ctx: any) => ctx.db.insert("pendingCancelation", { workId, segment }));
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ pendingStart: false, running: false, pendingCompletion: false });
  });

  // Upstream's assertion, kept, and failing on bunvex today: two `ctx.db.delete`s of one document in flight at once in
  // a transaction both succeed, where the second fails on Convex (and in convex-test) with "Delete on nonexistent
  // document ID". A platform bug, reported with STUDY-199's build; `failing` flips once it is fixed.
  it.failing("multiple cancels for same work -> BUG: crashes with double delete", async () => {
    const seg = nextSegment();
    await t.run(async (ctx: any) => {
      const wId = await makeDummyWork(ctx, { fnHandle: "h", fnName: "fn" });
      await ctx.db.insert("pendingStart", { workId: wId, segment: seg });
      await ctx.db.insert("pendingCancelation", { workId: wId, segment: seg });
      await ctx.db.insert("pendingCancelation", { workId: wId, segment: seg });
      await insertState(ctx, []);
    });
    // Upstream's BUG, kept (W-3): both cancelations find the one pendingStart, and the second delete fails.
    await expect(runLoop(seg)).rejects.toThrow();
  });

  it("complete(success) + cancel interleaved -> cancel is no-op (work already gone)", async () => {
    const { workId, segment } = await setupState(S2_RUNNING);
    await runComplete(workId, "success", 0);
    await t.mutation(api.lib.cancel, { id: workId });
    await runLoop(segment);
    expect(await observeState(workId)).toMatchObject({ work: false, running: false });
  });

  it("retry with large backoff -> pendingStart not picked up in same loop pass", async () => {
    const seg = nextSegment();
    const workId = await t.run(async (ctx: any) => {
      const wId = await makeDummyWork(ctx, {
        fnHandle: "h",
        fnName: "fn",
        attempts: 1,
        retryBehavior: { maxAttempts: 5, initialBackoffMs: 60000, base: 2 },
      });
      const sId = await makeDummyScheduledFunction(ctx);
      await insertState(ctx, [{ workId: wId, scheduledId: sId, started: Date.now() }]);
      await ctx.db.insert("pendingCompletion", {
        workId: wId,
        segment: seg,
        retry: true,
        runResult: { kind: "failed", error: "test" },
      });
      return wId;
    });
    await runLoop(seg);
    const s = await observeState(workId);
    expect(s).toMatchObject({ pendingCompletion: false, running: false, pendingStart: true });
    expect(s.work).toBeTruthy();
  });

  it("loop crash recovery: state recoverable after restart", async () => {
    const seg = currentSegment();
    const { workId } = await setupState(S1_ENQUEUED, { segment: seg });
    await runLoop(seg);
    expect((await observeState(workId)).running).toBe(true);
    await runComplete(workId, "success", 0);
    await runLoop(currentSegment());
    expect(await observeState(workId)).toMatchObject({ work: false, running: false });
  });

  it("all three pending queues populated -> loop processes all in order", async () => {
    const seg = currentSegment();
    const ids = await t.run(async (ctx: any) => {
      const w1 = await makeDummyWork(ctx, { fnHandle: "h1", fnName: "fn1" });
      const s1 = await makeDummyScheduledFunction(ctx);
      const w2 = await makeDummyWork(ctx, { fnHandle: "h2", fnName: "fn2" });
      const w3 = await makeDummyWork(ctx, { fnHandle: "h3", fnName: "fn3" });
      await insertState(ctx, [{ workId: w1, scheduledId: s1, started: Date.now() }]);
      await ctx.db.insert("pendingCompletion", {
        workId: w1,
        segment: seg,
        retry: false,
        runResult: { kind: "success", returnValue: null },
      });
      await ctx.db.insert("pendingStart", { workId: w2, segment: seg });
      await ctx.db.insert("pendingCancelation", { workId: w2, segment: seg });
      await ctx.db.insert("pendingStart", { workId: w3, segment: seg });
      return { w1, w2, w3 };
    });
    await runLoop(seg);
    // w1's work row stays: the loop does not delete it (`complete` does, and was bypassed here).
    expect(await observeState(ids.w1)).toMatchObject({ running: false, pendingCompletion: false });
    expect(await observeState(ids.w2)).toMatchObject({
      pendingStart: false,
      pendingCancelation: false,
      work: { canceled: true },
    });
    expect(await observeState(ids.w3)).toMatchObject({ running: true, pendingStart: false });
  });

  it("cancel during S5 (completing+retry) with pendingCancelation still present -> no retry", async () => {
    const seg = nextSegment();
    const workId = await t.run(async (ctx: any) => {
      const wId = await makeDummyWork(ctx, { fnHandle: "h", fnName: "fn", attempts: 1, retryBehavior });
      const sId = await makeDummyScheduledFunction(ctx);
      await insertState(ctx, [{ workId: wId, scheduledId: sId, started: Date.now() }]);
      await ctx.db.insert("pendingCompletion", {
        workId: wId,
        segment: seg,
        retry: true,
        runResult: { kind: "failed", error: "test" },
      });
      await ctx.db.insert("pendingCancelation", { workId: wId, segment: seg });
      return wId;
    });
    await runLoop(seg);
    expect(await observeState(workId)).toMatchObject({
      pendingStart: false,
      running: false,
      pendingCompletion: false,
      pendingCancelation: false,
    });
  });
});

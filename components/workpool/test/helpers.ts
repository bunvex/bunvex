// What the component tests share: a deployment of the component's functions pushed as an app's
// (fixtures/standalone, which mounts the batch worker as the component does), upstream's `setupTest`; and the loop
// driven by hand, as upstream's tests drive it.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import { DEFAULT_MAX_PARALLELISM, getCurrentSegment, WORKER_NAME } from "../src/component/shared.ts";

export const api = anyApi as any;
export const components = componentsGeneric() as any;
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

/** A fresh deployment of the component's functions, closed after the test. */
export function setupTest(): TestBunvex {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

/** The batch worker's status for the pool's queue, or null before the first ping. */
export async function workerStatus(t: TestBunvex): Promise<string | null> {
  const status = (await t.query(components.batchWorker.lib.status, { name: WORKER_NAME })) as { kind: string } | null;
  return status?.kind ?? null;
}

export const emptyReport = (lastReportTs: number) => ({
  completed: 0,
  succeeded: 0,
  failed: 0,
  retries: 0,
  canceled: 0,
  lastReportTs,
});

/** The globals and an empty `internalState`, as upstream's loop tests seed them. */
export async function initialize(
  t: TestBunvex,
  opts: { maxParallelism?: number; logLevel?: Doc<"globals">["logLevel"] } = {},
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("globals", {
      logLevel: opts.logLevel ?? "WARN",
      maxParallelism: opts.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
    });
    await ctx.db.insert("internalState", {
      generation: 0n,
      segmentCursors: { incoming: 0n, completion: 0n, cancelation: 0n },
      lastRecovery: 0n,
      report: emptyReport(Date.now()),
      running: [],
    });
  });
}

/** A `work` row and its `pendingStart` at `segment` (now by default), bypassing `enqueue`. */
export function enqueueWork(
  t: TestBunvex,
  overrides: Partial<Doc<"work">> = {},
  segment?: bigint,
): Promise<Id<"work">> {
  return t.run(async (ctx: any) => {
    const workId = await ctx.db.insert("work", {
      fnType: "action",
      fnHandle: "test_handle",
      fnName: "test_handle",
      fnArgs: {},
      attempts: 0,
      ...overrides,
    });
    await ctx.db.insert("pendingStart", { workId, segment: segment ?? getCurrentSegment() });
    return workId;
  });
}

/** One loop iteration as the batch worker runs it: the batch, then `run` with it when there is one. */
export async function runLoop(t: TestBunvex): Promise<any> {
  const result = await t.query(api.loop.getBatch, { name: WORKER_NAME });
  if (result.kind === "work") await t.mutation(api.loop.run, result.batch);
  return result;
}

/** A worker's report of an attempt, through `complete`. */
export async function simulateCompletion(
  t: TestBunvex,
  workId: Id<"work">,
  runResult: { kind: "success"; returnValue: unknown } | { kind: "failed"; error: string } | { kind: "canceled" },
  attempt = 0,
) {
  await t.mutation(api.complete.complete, { jobs: [{ workId, runResult, attempt }] });
}

/** What an observer sees: the running jobs and the three queues. */
export function observe(t: TestBunvex) {
  return t.run(async (ctx: any) => {
    const state = await ctx.db.query("internalState").unique();
    return {
      state,
      running: (state?.running ?? []) as Doc<"internalState">["running"],
      lastRecovery: (state?.lastRecovery ?? 0n) as bigint,
      pendingStart: (await ctx.db.query("pendingStart").collect()) as Doc<"pendingStart">[],
      pendingCompletion: (await ctx.db.query("pendingCompletion").collect()) as Doc<"pendingCompletion">[],
      pendingCancelation: (await ctx.db.query("pendingCancelation").collect()) as Doc<"pendingCancelation">[],
    };
  });
}

export const statusOf = (t: TestBunvex, id: Id<"work">) => t.query(api.lib.status, { id }) as Promise<any>;

/** A scheduled function's id in the given state: pending (in a minute), or after running `testing:noop`/`fail`. */
export async function scheduledIn(
  t: TestBunvex,
  state: "pending" | "success" | "failed" | "canceled",
): Promise<Id<"_scheduled_functions">> {
  if (state === "pending") return t.run((ctx: any) => ctx.scheduler.runAfter(MINUTE, api.testing.noop, {}));
  if (state === "canceled") {
    return t.run(async (ctx: any) => {
      const id = await ctx.scheduler.runAfter(MINUTE, api.testing.noop, {});
      await ctx.scheduler.cancel(id);
      return id;
    });
  }
  const id = await t.run((ctx: any) =>
    ctx.scheduler.runAfter(0, state === "failed" ? api.testing.fail : api.testing.noop, {}),
  );
  await t.finishInProgressScheduledFunctions();
  await t.advanceTime(5);
  return id;
}

/** A garbage-collected scheduled function's id: it ran, and the scheduler deleted it a week later. */
export async function scheduledGone(t: TestBunvex): Promise<Id<"_scheduled_functions">> {
  const id = await scheduledIn(t, "success");
  await t.advanceTime(7 * 24 * 60 * MINUTE + 5 * SECOND);
  return id;
}

/**
 * The console calls made while `fn` runs, as `level: text` lines; a deployed function's console reaches the test's.
 * Push the deployment (any call) first: the process's first push starts the function logs' sink.
 */
export async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const levels = ["debug", "info", "log", "warn", "error"] as const;
  const saved = levels.map((l) => console[l]);
  for (const l of levels) {
    console[l] = (...args: unknown[]) => {
      lines.push(`${l}: ${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}`);
    };
  }
  try {
    return { result: await fn(), lines };
  } finally {
    levels.forEach((l, i) => {
      console[l] = saved[i] as never;
    });
  }
}

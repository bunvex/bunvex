// More (STUDY-199 §3.4), on an app that installs the package by its name (fixtures/app): `onComplete` in every row of
// §1.11's table (inline or scheduled, read from the `completed` event's `onCompleteScheduledFunctionId`), including
// the success callback that throws and so runs twice; the `failed.error` text of each kind of job; the two platform
// features §3.2 has the tests confirm in a component (`v.id("_scheduled_functions")` in a function's arguments, and
// `db.system.query("_scheduled_functions").withIndex("by_creation_time", …)` with a range); and a saturated pool.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { type WorkId, Workpool, type WorkpoolComponent } from "../src/client/index.ts";
import { captureLogs } from "./helpers.ts";

setDefaultTimeout(60_000);

const refs = (anyApi as any).callbacks;
const components = componentsGeneric() as unknown as { workpool: WorkpoolComponent & Record<string, any> };
const pool = new Workpool(components.workpool, { maxParallelism: 10, logLevel: "INFO" });
const APP = join(import.meta.dir, "fixtures", "app");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});
let t: TestBunvex;
function setup() {
  t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
}
/** Push the app before capturing the console: the first push of the process starts the function logs' sink. */
const boot = () => t.query(refs.events, { key: "" });
const drain = () => t.finishAllScheduledFunctions(undefined, 1000);
const callbackCalls = () => t.mutation(refs.calls, {}) as Promise<number>;
const events = (key: string) => t.query(refs.events, { key }) as Promise<any[]>;
/** The pool's JSON events of one kind, from the captured console. */
const eventsIn = (lines: string[], event: string) =>
  lines
    .filter((l) => l.startsWith('info: {"component":"workpool"'))
    .map((l) => JSON.parse(l.slice("info: ".length)))
    .filter((e) => e.event === event);

type Kind = "action" | "mutation" | "query";
const enqueue = (kind: Kind, args: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  t.mutation((ctx: any) => {
    const opts = { onComplete: refs.complete, context: { key: args.key }, ...options };
    if (kind === "action") return pool.enqueueAction(ctx, refs.action, args as never, opts);
    if (kind === "mutation") return pool.enqueueMutation(ctx, refs.mutation, args as never, opts);
    return pool.enqueueQuery(ctx, refs.query, args as never, opts);
  }) as Promise<WorkId>;

describe("onComplete, by §1.11's table", () => {
  const rows: { kind: Kind; result: "success" | "failed" | "canceled"; inline: boolean }[] = [
    { kind: "action", result: "success", inline: true },
    { kind: "query", result: "success", inline: true },
    { kind: "action", result: "failed", inline: false },
    { kind: "query", result: "failed", inline: false },
    { kind: "mutation", result: "success", inline: false },
    { kind: "mutation", result: "failed", inline: false },
    { kind: "action", result: "canceled", inline: false },
    { kind: "mutation", result: "canceled", inline: false },
    { kind: "query", result: "canceled", inline: false },
  ];
  for (const { kind, result, inline } of rows) {
    test(`${kind}, ${result}: ${inline ? "inline" : "scheduled"}`, async () => {
      setup();
      await boot();
      const { lines } = await captureLogs(async () => {
        const id = await enqueue(
          kind,
          { key: "row", fail: result === "failed" },
          result === "canceled" ? { runAt: t.now() + 60_000 } : {},
        );
        if (result === "canceled") await t.mutation((ctx: any) => pool.cancel(ctx, id));
        await drain();
      });
      expect(await callbackCalls()).toBe(1);
      expect((await events("row")).filter((e) => e.kind === "callback")).toMatchObject([{ result: { kind: result } }]);
      const [completed] = eventsIn(lines, "completed");
      expect(completed).toMatchObject({ status: result, attempts: 1 });
      if (inline) expect(completed.onCompleteScheduledFunctionId).toBeUndefined();
      else expect(completed.onCompleteScheduledFunctionId).toEqual(expect.any(String));
    });
  }

  for (const kind of ["action", "query"] as const) {
    test(`a ${kind}'s success callback that throws runs twice: inline, rolled back, then scheduled`, async () => {
      setup();
      await boot();
      const { lines } = await captureLogs(async () => {
        await enqueue(kind, { key: "twice" }, { context: { key: "twice", throw: true } });
        await drain();
      });
      expect(await callbackCalls()).toBe(2);
      // Both runs threw, so neither's write stayed.
      expect(await events("twice")).toEqual(kind === "action" ? [expect.objectContaining({ kind: "attempt" })] : []);
      const [completed] = eventsIn(lines, "completed");
      expect(completed.onCompleteScheduledFunctionId).toEqual(expect.any(String));
      expect(
        lines.some((l) =>
          /^error: \[complete\] caught error while running onComplete inline for \w+, scheduling instead: /.test(l),
        ),
      ).toBe(true);
    });
  }

  test("a mutation's success callback that throws runs once, scheduled", async () => {
    setup();
    await enqueue("mutation", { key: "once" }, { context: { key: "once", throw: true } });
    await drain();
    expect(await callbackCalls()).toBe(1);
  });
});

describe("failed.error", () => {
  for (const kind of ["action", "mutation", "query"] as const) {
    test(`a ${kind} that throws: the platform's text; a NonRetryableError: its message`, async () => {
      setup();
      await enqueue(kind, { key: "plain", fail: true });
      await enqueue(kind, { key: "terminal", fail: true, nonRetryable: true });
      await drain();
      const resultOf = async (key: string) =>
        (await events(key)).find((e) => e.kind === "callback")?.result as { kind: string; error: string };
      // The callee's error, as the nested call gives it: its name, message and where it was thrown.
      const plain = await resultOf("plain");
      expect(plain.kind).toBe("failed");
      expect(plain.error).toStartWith("Uncaught Error: work failed\n");
      expect(plain.error).toContain("callbacks.ts");
      expect(await resultOf("terminal")).toEqual({ kind: "failed", error: "work failed" });
    });
  }
});

describe("the platform in a component (STUDY-199 §3.2)", () => {
  test('v.id("_scheduled_functions") in a component function\'s arguments', async () => {
    setup();
    await t.mutation(refs.closeGate, {});
    const id = await enqueue("action", { key: "held" });
    const moving = t.advanceTime(50);
    let running: any[] = [];
    for (let i = 0; i < 400 && running.length === 0; i++) {
      running = (await t.query(components.workpool.stats.running, {})) as any[];
      await Bun.sleep(5);
    }
    expect(running).toHaveLength(1);
    const [{ scheduledId, started }] = running;
    // The component's own scheduled function's id is accepted, and read in the component's namespace: in progress,
    // so recovery leaves the job alone.
    await t.mutation(components.workpool.recovery.recover, {
      jobs: [{ scheduledId, workId: id, attempt: 0, started }],
    });
    expect(await t.query((ctx: any) => pool.status(ctx, id))).toEqual({ state: "running", previousAttempts: 0 });
    // Another table's id is refused.
    await expect(
      t.mutation(components.workpool.recovery.recover, {
        jobs: [{ scheduledId: id, workId: id, attempt: 0, started }],
      }),
    ).rejects.toThrow(/ArgumentValidationError/);
    await t.mutation(refs.openGate, {});
    await moving;
    await drain();
    expect(await t.query((ctx: any) => pool.status(ctx, id))).toEqual({ state: "finished" });
  });

  test('db.system.query("_scheduled_functions").withIndex("by_creation_time", range) in a component', async () => {
    setup();
    const before = t.now();
    // The app's own scheduled functions, which the component's query must not see.
    await t.run(async (ctx: any) => {
      for (let i = 0; i < 3; i++) await ctx.scheduler.runAfter(60 * 60_000, refs.attempt, { key: "app" });
    });
    const quiet = new Workpool(components.workpool, {});
    await t.mutation((ctx: any) => quiet.enqueueMutation(ctx, refs.mutation, { key: "m" }));
    await drain();
    const range = (startTime: number, endTimeExclusive: number) =>
      t.query(components.workpool.stats.scheduledFunctionsInRange, { startTime, endTimeExclusive });
    // In the pool's namespace: the mutation's `runMutationWrapper` and its `complete`.
    expect(await range(before - 1, t.now() + 1)).toEqual({ count: 2, overflow: false });
    // The range bounds: nothing before, nothing after.
    expect(await range(before - 60_000, before - 1)).toEqual({ count: 0, overflow: false });
    expect(await range(t.now() + 1, t.now() + 60_000)).toEqual({ count: 0, overflow: false });
  });
});

// STUDY-199 §6: a pool at its limit of 200 actions, each holding one of the 64 action permits while it calls the
// app's action, which needs a permit of its own.
describe("saturation", () => {
  test("200 actions drain with maxParallelism 200", async () => {
    setup();
    const big = new Workpool(components.workpool, { maxParallelism: 200, logLevel: "ERROR" });
    const args = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}` }));
    const ids = (await t.mutation((ctx: any) => big.enqueueActionBatch(ctx, refs.action, args))) as WorkId[];
    await drain();
    const statuses = (await t.query((ctx: any) => big.statusBatch(ctx, ids))) as any[];
    expect(statuses.every((s) => s.state === "finished")).toBe(true);
    expect(await events("k199")).toMatchObject([{ kind: "attempt" }]);
  });
});

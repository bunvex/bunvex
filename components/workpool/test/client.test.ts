// Upstream's client tests (`src/client/index.test.ts` of get-convex/workpool 0.4.14, STUDY-199 §1.19), ported: the
// `Workpool` client used by an app that installs the package by its name (fixtures/app), with real jobs and
// callbacks (fixtures/app/bunvex/callbacks.ts), on the virtual clock. Upstream builds its app with convex-test's
// `defineTestApp`, which `@bunvex/testing` has not (DV-546); the app is pushed instead.
//
// Upstream's `vi.fn` spy on the callback and its `actionGate` promise live in the test's file; the deployment runs the
// app's functions in a realm of its own, so both live in the fixture's module and are read (`callbacks:calls`) and
// opened (`callbacks:openGate`) through functions. Where upstream waits with `vi.waitFor` for a gated action, the
// clock is moved without awaiting it (`t.advanceTime` waits for the jobs in progress) while the test polls.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  anyApi,
  componentsGeneric,
  type FunctionArgs,
  type GenericDataModel,
  type GenericMutationCtx,
  makeFunctionReference,
} from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { type Infer, v } from "@bunvex/values";
import {
  type EnqueueOptions,
  type OnCompleteArgs,
  type RetryOption,
  vOnCompleteArgs,
  type WorkId,
  Workpool,
  type WorkpoolComponent,
} from "../src/client/index.ts";
import type { api as componentApi } from "../src/component/_generated/api.ts";

// Each test pushes its own deployment first, which takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

const refs = (anyApi as any).callbacks;
const components = componentsGeneric() as unknown as { workpool: WorkpoolComponent };
const pool = new Workpool(components.workpool, { maxParallelism: 3, logLevel: "ERROR" });
const retries = { maxAttempts: 3, initialBackoffMs: 1, base: 2 };
type Kind = "action" | "mutation" | "query";
type Mode = "all" | "failed" | "canceled";
type Context = { key: string; padding?: string; throw?: boolean };
type RunArgs = { key: string; fail?: boolean; failures?: number; nonRetryable?: boolean; payload?: string };
const ALL_KINDS = ["success", "failed", "canceled"] as const;
const excludeFilters = [
  undefined,
  [],
  ["success"],
  ["failed"],
  ["canceled"],
  ["success", "failed"],
  ["success", "canceled"],
  ["failed", "canceled"],
  ["success", "failed", "canceled"],
  ["failed", "failed"],
] as const;

const APP = join(import.meta.dir, "fixtures", "app");
const open: TestBunvex[] = [];
let t: TestBunvex;
function setup() {
  t = bunvexTest({ cwd: APP });
  open.push(t);
  return t;
}
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});
const drain = () => t.finishAllScheduledFunctions(undefined, 1000);
const events = (key: string) => t.query(refs.events, { key }) as Promise<any[]>;
const recorded = (all: any[]) => all.filter((e) => e.kind === "callback");
const callbackCalls = () => t.mutation(refs.calls, {}) as Promise<number>;
const statusOf = (id: WorkId) => t.query((ctx: any) => pool.status(ctx, id));
const statusesOf = (ids: WorkId[]) => t.query((ctx: any) => pool.statusBatch(ctx, ids));
/** Poll `check` until it passes (upstream's `vi.waitFor`), for up to 10 s of real time. */
async function waitFor(check: () => Promise<void>) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (performance.now() > deadline) throw e;
      await Bun.sleep(5);
    }
  }
}

function enqueue(
  kind: Kind,
  args: RunArgs,
  options: { mode?: Mode; context?: Context; retry?: RetryOption["retry"]; runAt?: number } = {},
): Promise<WorkId> {
  const { mode = "failed", context = { key: args.key }, ...rest } = options;
  const opts = {
    onComplete: refs.complete,
    onCompleteExcludeKinds: mode === "all" ? undefined : ALL_KINDS.filter((k) => k !== mode),
    context,
    ...rest,
  };
  return t.mutation((ctx: any) => {
    switch (kind) {
      case "action":
        return pool.enqueueAction(ctx, refs.action, args, opts);
      case "mutation":
        return pool.enqueueMutation(ctx, refs.mutation, args, opts);
      case "query":
        return pool.enqueueQuery(ctx, refs.query, args, opts);
    }
  });
}

describe("completion callbacks through the client and scheduler", () => {
  for (const excludeKinds of excludeFilters) {
    describe(`exclude filter ${JSON.stringify(excludeKinds)}`, () => {
      for (const result of ["success", "failed", "canceled"] as const) {
        test(`dispatches a ${result} result at most once and finishes the job`, async () => {
          setup();
          const id = await t.mutation((ctx: any) =>
            pool.enqueueMutation(
              ctx,
              refs.mutation,
              { key: "filtered", fail: result === "failed" },
              {
                onComplete: refs.complete,
                onCompleteExcludeKinds: excludeKinds,
                context: { key: "filtered" },
                runAt: result === "canceled" ? t.now() + 60_000 : undefined,
              },
            ),
          );
          if (result === "canceled") await t.mutation((ctx: any) => pool.cancel(ctx, id));
          await drain();
          const selected = !(excludeKinds as readonly string[] | undefined)?.includes(result);
          expect(await callbackCalls()).toBe(selected ? 1 : 0);
          const recorded = (await events("filtered")).filter((e) => e.kind === "callback");
          expect(recorded).toMatchObject(selected ? [{ workId: id, result: { kind: result } }] : []);
          expect(await statusOf(id)).toEqual({ state: "finished" });
        });
      }
    });
  }

  for (const kind of ["action", "mutation", "query"] as const) {
    test(`a failure filter skips successful ${kind} work`, async () => {
      setup();
      const id = await enqueue(kind, { key: kind });
      await drain();
      expect(await callbackCalls()).toBe(0);
      expect(await statusOf(id)).toEqual({ state: "finished" });
    });

    test(`a failure filter reuses an existing completion handler for failed ${kind} work`, async () => {
      setup();
      const id = await enqueue(kind, { key: kind, fail: true });
      await drain();
      expect(await callbackCalls()).toBe(1);
      expect((await events(kind)).filter((e) => e.kind === "callback")).toMatchObject([
        { workId: id, context: { key: kind }, result: { kind: "failed" } },
      ]);
      // convex-test's text is "work failed"; the platform's names the error and where it was thrown (STUDY-199 §6).
      expect(recorded(await events(kind))[0].result.error).toStartWith("Uncaught Error: work failed\n");
      expect(await statusOf(id)).toEqual({ state: "finished" });
      // The failed mutation's own write was rolled back.
      if (kind === "mutation") expect((await events(kind)).some((e) => e.kind === "work")).toBe(false);
    });
  }

  test("a failure filter runs once after retry exhaustion", async () => {
    setup();
    await enqueue("action", { key: "retry", fail: true }, { retry: retries });
    await drain();
    expect(await callbackCalls()).toBe(1);
    expect((await events("retry")).map((e) => e.kind)).toEqual(["attempt", "attempt", "attempt", "callback"]);
  });

  test("a failure filter is skipped if a retry succeeds", async () => {
    setup();
    await enqueue("action", { key: "retry", failures: 2 }, { retry: retries });
    await drain();
    expect(await callbackCalls()).toBe(0);
    expect((await events("retry")).map((e) => e.kind)).toEqual(["attempt", "attempt", "attempt"]);
  });

  test("NonRetryableError skips remaining attempts and invokes the failure callback", async () => {
    setup();
    await enqueue("action", { key: "terminal", fail: true, nonRetryable: true }, { retry: retries });
    await drain();
    expect(await callbackCalls()).toBe(1);
    const recorded = await events("terminal");
    expect(recorded.map((e) => e.kind)).toEqual(["attempt", "callback"]);
    expect(recorded[1].result).toEqual({ kind: "failed", error: "work failed" });
  });

  for (const mode of ["all", "failed", "canceled"] as const) {
    test(`${mode} preserves cancellation semantics`, async () => {
      setup();
      const id = await enqueue("action", { key: "cancel", fail: true }, { mode, runAt: t.now() + 60_000 });
      await t.mutation((ctx: any) => pool.cancel(ctx, id));
      await drain();
      const recorded = await events("cancel");
      if (mode === "failed") {
        expect(await callbackCalls()).toBe(0);
        expect(recorded).toEqual([]);
      } else {
        expect(await callbackCalls()).toBe(1);
        expect(recorded).toMatchObject([{ workId: id, kind: "callback", result: { kind: "canceled" } }]);
      }
      expect(await statusOf(id)).toEqual({ state: "finished" });
    });
  }

  for (const kind of ["action", "mutation", "query"] as const) {
    test(`a cancellation filter skips successful and failed ${kind} work`, async () => {
      setup();
      const ids = [
        await enqueue(kind, { key: "success" }, { mode: "canceled" }),
        await enqueue(kind, { key: "failure", fail: true }, { mode: "canceled", retry: retries }),
      ];
      await drain();
      expect(await callbackCalls()).toBe(0);
      expect(await statusesOf(ids)).toEqual([{ state: "finished" }, { state: "finished" }]);
      // Only actions are retried by the client.
      if (kind === "action") expect(await events("failure")).toHaveLength(3);
    });
  }

  test("a cancellation filter runs once when a job is canceled during retry backoff", async () => {
    setup();
    const id = await enqueue(
      "action",
      { key: "backoff", fail: true },
      { mode: "canceled", retry: { ...retries, initialBackoffMs: 60_000 } },
    );
    // Upstream lets its timers run until the first attempt has failed; the clock moves only as far as that.
    for (let i = 0; i < 50; i++) {
      const s = await statusOf(id);
      if (s.state === "pending" && s.previousAttempts === 1) break;
      await t.advanceTime(100);
    }
    expect(await statusOf(id)).toEqual({ state: "pending", previousAttempts: 1 });
    expect(await callbackCalls()).toBe(0);
    await t.mutation((ctx: any) => pool.cancel(ctx, id));
    await t.mutation((ctx: any) => pool.cancel(ctx, id));
    await drain();
    expect(await callbackCalls()).toBe(1);
    const recorded = await events("backoff");
    expect(recorded.map((e) => e.kind)).toEqual(["attempt", "callback"]);
    expect(recorded[1]).toMatchObject({ workId: id, result: { kind: "canceled" } });
    expect(await statusOf(id)).toEqual({ state: "finished" });
  });

  for (const c of [
    { name: "success", fail: false, retry: false, expected: "success" },
    { name: "failure", fail: true, retry: false, expected: "failed" },
    { name: "prevented retry", fail: true, retry: retries, expected: "canceled" },
    { name: "non-retryable failure", fail: true, nonRetryable: true, retry: retries, expected: "failed" },
    { name: "exhausted retries", fail: true, retry: { ...retries, maxAttempts: 1 }, expected: "failed" },
  ] as const) {
    test(`canceling running work dispatches by its final result (${c.name})`, async () => {
      setup();
      const { name, fail, retry, expected, ...args } = c;
      await t.mutation(refs.closeGate, {});
      let running: Promise<void> | undefined;
      try {
        const id = await t.mutation((ctx: any) =>
          pool.enqueueAction(
            ctx,
            refs.action,
            { key: name, fail, ...args },
            { onComplete: refs.complete, onCompleteExcludeKinds: ["success"], context: { key: name }, retry },
          ),
        );
        // The loop starts the action, which records its attempt and waits at the gate; moving the clock waits for it.
        running = t.advanceTime(50);
        await waitFor(async () => {
          expect((await events(name)).map((e) => e.kind)).toEqual(["attempt"]);
        });
        await t.mutation((ctx: any) => pool.cancel(ctx, id));
        expect(await statusOf(id)).toMatchObject({ state: "running" });
        expect(await callbackCalls()).toBe(0);

        await t.mutation(refs.openGate, {});
        await running;
        await drain();
        expect(await statusOf(id)).toEqual({ state: "finished" });
        const recorded = await events(name);
        expect(recorded.filter((e) => e.kind === "attempt")).toHaveLength(1);
        expect(recorded.filter((e) => e.kind === "callback")).toMatchObject(
          expected === "success" ? [] : [{ result: { kind: expected } }],
        );
        if (expected === "success") {
          expect(await callbackCalls()).toBe(0);
        } else {
          expect(await callbackCalls()).toBe(1);
          expect(recorded[1]).toMatchObject({ workId: id, result: { kind: expected } });
        }
      } finally {
        await t.mutation(refs.openGate, {});
        await running?.catch(() => {});
      }
    });
  }

  for (const kind of ["action", "mutation", "query"] as const) {
    test(`cancelAll invokes the cancellation callback for each pending ${kind} in a batch`, async () => {
      setup();
      const args = [{ key: "first" }, { key: "second" }];
      const options = {
        onComplete: refs.complete,
        onCompleteExcludeKinds: ["success"] as const,
        context: { key: "batch-cancel" },
        runAt: t.now() + 60_000,
      };
      const ids = await t.mutation((ctx: any) => {
        switch (kind) {
          case "action":
            return pool.enqueueActionBatch(ctx, refs.action, args, options);
          case "mutation":
            return pool.enqueueMutationBatch(ctx, refs.mutation, args, options);
          case "query":
            return pool.enqueueQueryBatch(ctx, refs.query, args, options);
        }
      });
      // Past the inserts' creation times before cancelAll takes its cutoff, as upstream does. A row's fractional
      // creation time is in the millisecond after the clock's reading, so the clock moves 2 ms where upstream's moves 1.
      await t.advanceTime(2);
      await t.mutation((ctx: any) => pool.cancelAll(ctx));
      await drain();
      expect(await callbackCalls()).toBe(2);
      const recorded = await events("batch-cancel");
      expect(recorded.map((e) => e.workId).sort()).toEqual([...ids].sort());
      expect(recorded.every((e) => e.result?.kind === "canceled")).toBe(true);
      expect(await statusesOf(ids)).toEqual([{ state: "finished" }, { state: "finished" }]);
      expect(await events("first")).toEqual([]);
      expect(await events("second")).toEqual([]);
    });
  }

  for (const largeArgs of [false, true]) {
    test(`a cancellation filter restores large context (large arguments: ${largeArgs})`, async () => {
      setup();
      const context = { key: "large-cancel", padding: "x".repeat(12_000) };
      const id = await enqueue(
        "action",
        { key: context.key, ...(largeArgs ? { payload: context.padding } : {}) },
        { mode: "canceled", context, runAt: t.now() + 60_000 },
      );
      await t.mutation((ctx: any) => pool.cancel(ctx, id));
      await drain();
      expect(await callbackCalls()).toBe(1);
      expect(await events(context.key)).toMatchObject([{ workId: id, context, result: { kind: "canceled" } }]);
    });
  }

  test("a failing cancellation callback rolls back without starting the work", async () => {
    setup();
    const id = await enqueue(
      "mutation",
      { key: "broken-cancel" },
      { mode: "canceled", context: { key: "broken-cancel", throw: true }, runAt: t.now() + 60_000 },
    );
    await t.mutation((ctx: any) => pool.cancel(ctx, id));
    await drain();
    expect(await callbackCalls()).toBe(1);
    expect(await events("broken-cancel")).toEqual([]);
    expect(await statusOf(id)).toEqual({ state: "finished" });
  });

  for (const kind of ["action", "mutation", "query"] as const) {
    test(`onComplete still receives successful ${kind} results`, async () => {
      setup();
      const id = await enqueue(kind, { key: kind }, { mode: "all" });
      await drain();
      expect(await callbackCalls()).toBe(1);
      expect((await events(kind)).filter((e) => e.kind === "callback")).toMatchObject([
        { workId: id, result: { kind: "success", returnValue: `${kind} result` } },
      ]);
    });
  }

  for (const largeArgs of [false, true]) {
    test(`a failure filter restores large context (large arguments: ${largeArgs})`, async () => {
      setup();
      const context = { key: "large", padding: "x".repeat(12_000) };
      const id = await enqueue(
        "action",
        { key: "large", fail: true, ...(largeArgs ? { payload: "x".repeat(12_000) } : {}) },
        { context },
      );
      await drain();
      expect(await callbackCalls()).toBe(1);
      const recorded = await events("large");
      expect(recorded.map((e) => e.kind)).toEqual(["attempt", "callback"]);
      expect(recorded[1]).toMatchObject({ context, result: { kind: "failed" } });
      expect(recorded[1].result.error).toStartWith("Uncaught Error: work failed\n");
      expect(await statusOf(id)).toEqual({ state: "finished" });
    });
  }

  for (const mode of ["failed", "canceled"] as const) {
    test(`${mode} supports omitted context`, async () => {
      setup();
      const id = await t.mutation((ctx: any) =>
        pool.enqueueMutation(
          ctx,
          refs.mutation,
          { key: "default", fail: true },
          mode === "failed"
            ? { onComplete: refs.optionalComplete, onCompleteExcludeKinds: ["success", "canceled"] }
            : {
                onComplete: refs.optionalComplete,
                onCompleteExcludeKinds: ["success", "failed"],
                runAt: t.now() + 60_000,
              },
        ),
      );
      if (mode === "canceled") await t.mutation((ctx: any) => pool.cancel(ctx, id));
      await drain();
      expect(await callbackCalls()).toBe(1);
      const [first] = await events("default");
      expect(first).toMatchObject({ workId: id, result: { kind: mode === "failed" ? "failed" : "canceled" } });
      expect(first.context).toBeUndefined();
    });
  }

  for (const kind of ["action", "mutation", "query"] as const) {
    test(`batch ${kind} enqueue only calls back for failed items`, async () => {
      setup();
      const args = [{ key: "success" }, { key: "failure", fail: true }];
      const opts = {
        onComplete: refs.complete,
        onCompleteExcludeKinds: ["success", "canceled"] as const,
        context: { key: "batch" },
      };
      const ids = await t.mutation((ctx: any) => {
        switch (kind) {
          case "action":
            return pool.enqueueActionBatch(ctx, refs.action, args, opts);
          case "mutation":
            return pool.enqueueMutationBatch(ctx, refs.mutation, args, opts);
          case "query":
            return pool.enqueueQueryBatch(ctx, refs.query, args, opts);
        }
      });
      await drain();
      expect(await callbackCalls()).toBe(1);
      expect(await events("batch")).toMatchObject([{ workId: ids[1], result: { kind: "failed" } }]);
      expect(await statusesOf(ids)).toEqual([{ state: "finished" }, { state: "finished" }]);
    });
  }

  test("a failing failure callback rolls back without retrying the original work", async () => {
    setup();
    const id = await enqueue(
      "action",
      { key: "broken", fail: true },
      { retry: retries, context: { key: "broken", throw: true } },
    );
    await drain();
    expect(await callbackCalls()).toBe(1);
    expect((await events("broken")).map((e) => e.kind)).toEqual(["attempt", "attempt", "attempt"]);
    expect(await statusOf(id)).toEqual({ state: "finished" });
  });

  for (const batch of [false, true]) {
    test(`rejects invalid result kinds at runtime (batch: ${batch})`, async () => {
      setup();
      const opts = {
        onComplete: refs.complete,
        onCompleteExcludeKinds: ["running"],
        context: { key: "invalid" },
      } as unknown as EnqueueOptions<Context>;
      await expect(
        t.mutation(
          (ctx: any): Promise<unknown> =>
            batch
              ? pool.enqueueMutationBatch(ctx, refs.mutation, [{ key: "invalid" }], opts)
              : pool.enqueueMutation(ctx, refs.mutation, { key: "invalid" }, opts),
        ),
      ).rejects.toThrow(/ArgumentValidationError/);
      await drain();
      expect(await events("invalid")).toEqual([]);
      expect(await callbackCalls()).toBe(0);
    });
  }

  for (const batch of [false, true]) {
    test(`omits callback metadata when onComplete is disabled (batch: ${batch})`, async () => {
      setup();
      for (const [index, options] of [{}, { onComplete: null }].entries()) {
        const key = `disabled-${index}`;
        await t.mutation(
          (ctx: any): Promise<unknown> =>
            batch
              ? pool.enqueueMutationBatch(ctx, refs.mutation, [{ key }], options)
              : pool.enqueueMutation(ctx, refs.mutation, { key }, options),
        );
        await drain();
        expect((await events(key)).map((event) => event.kind)).toEqual(["work"]);
      }
      expect(await callbackCalls()).toBe(0);
    });
  }
});

// Upstream's type tests (`expectTypeOf`): checked by `tsc`, which typechecks this file; the functions never run.
type MutationCtx = GenericMutationCtx<GenericDataModel>;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const assertType = <T extends true>(_?: T) => {};
const action = makeFunctionReference<"action", { value: number }, number>("work:action");
const onComplete = makeFunctionReference<"mutation", OnCompleteArgs<{ label: string }, number>>("work:onComplete");

test("onComplete retains context and return value types", () => {
  const check = (p: Workpool, ctx: MutationCtx) => {
    // @ts-expect-error The callback requires a string label.
    void p.enqueueAction(ctx, action, { value: 1 }, { onComplete, context: { label: 1 } });
    const stringAction = makeFunctionReference<"action", { value: number }, string>("work:stringAction");
    void p.enqueueAction(
      ctx,
      // @ts-expect-error The callback requires a number result.
      stringAction,
      { value: 1 },
      { onComplete, context: { label: "job" } },
    );
    return p.enqueueAction(ctx, action, { value: 1 }, { onComplete, context: { label: "job" } });
  };
  assertType<Equal<ReturnType<typeof check>, Promise<WorkId>>>();
});

test("completion validators preserve the declared context and result", () => {
  const _args = vOnCompleteArgs(v.object({ label: v.string() }), v.number());
  type Args = Infer<typeof _args>;
  assertType<Equal<Args["context"], { label: string }>>();
  assertType<Equal<Extract<Args["result"], { kind: "success" }>["returnValue"], number>>();
});

test("runAt and runAfter are mutually exclusive", () => {
  // @ts-expect-error Only one scheduling option can be specified.
  const options: EnqueueOptions = { runAt: 1, runAfter: 2 };
  void options;
});

test("exclude filters accept existing handlers on all enqueue methods", () => {
  const options = { onComplete, onCompleteExcludeKinds: ["success"] as const, context: { label: "job" } };
  const mutation = makeFunctionReference<"mutation", { value: number }, number>("work:mutation");
  const query = makeFunctionReference<"query", { value: number }, number>("work:query");
  const one = (p: Workpool, ctx: MutationCtx) => [
    p.enqueueAction(ctx, action, { value: 1 }, options),
    p.enqueueMutation(ctx, mutation, { value: 1 }, options),
    p.enqueueQuery(ctx, query, { value: 1 }, options),
  ];
  const many = (p: Workpool, ctx: MutationCtx) => [
    p.enqueueActionBatch(ctx, action, [{ value: 1 }], options),
    p.enqueueMutationBatch(ctx, mutation, [{ value: 1 }], options),
    p.enqueueQueryBatch(ctx, query, [{ value: 1 }], options),
  ];
  assertType<Equal<ReturnType<typeof one>, Promise<WorkId>[]>>();
  assertType<Equal<ReturnType<typeof many>, Promise<WorkId[]>[]>>();
});

test("exclude filters only accept terminal result kinds", () => {
  // @ts-expect-error A running job has no terminal result.
  const options: EnqueueOptions = { onCompleteExcludeKinds: ["running"] };
  const none: EnqueueOptions = { onComplete: null, onCompleteExcludeKinds: [] };
  void options;
  void none;
});

test("generated enqueue types match the component validators", () => {
  assertType<Equal<FunctionArgs<WorkpoolComponent["lib"]["enqueue"]>, FunctionArgs<typeof componentApi.lib.enqueue>>>();
  assertType<
    Equal<FunctionArgs<WorkpoolComponent["lib"]["enqueueBatch"]>, FunctionArgs<typeof componentApi.lib.enqueueBatch>>
  >();
});

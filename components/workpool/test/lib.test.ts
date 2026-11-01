// Upstream's `src/component/lib.test.ts` (get-convex/workpool 0.4.14, STUDY-199 §1.19), ported: enqueue, cancel,
// cancelAll and status on the component's functions pushed as an app's. Times are the deployment's virtual clock
// (`t.now()`), where upstream's are vitest's frozen `Date.now()`. A rejected argument's message is the platform's
// (`ArgumentValidationError: …`, as Convex's backend says), where convex-test's says "Validator error".
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Id } from "../src/component/_generated/dataModel.ts";
import { api, setupTest, statusOf } from "./helpers.ts";

setDefaultTimeout(30_000);

type WorkId = Id<"work">;
let t: ReturnType<typeof setupTest>;
beforeEach(() => {
  t = setupTest();
});
const item = (over: Record<string, unknown> = {}) => ({
  fnHandle: "testHandle",
  fnName: "testFunction",
  fnArgs: { test: true },
  fnType: "mutation" as const,
  runAt: t.now(),
  config: { maxParallelism: 10, logLevel: "WARN" as const },
  ...over,
});
const enqueue = (over: Record<string, unknown> = {}) => t.mutation(api.lib.enqueue, item(over)) as Promise<WorkId>;
const rows = (table: string) => t.run((ctx: any) => ctx.db.query(table).collect()) as Promise<any[]>;

describe("enqueue", () => {
  for (const batch of [false, true]) {
    it(`accepts legacy, empty, and populated callback exclusions (batch: ${batch})`, async () => {
      const callbacks = [
        { fnHandle: "callback", context: { key: "legacy" } },
        { fnHandle: "callback", excludeKinds: [] },
        { fnHandle: "callback", excludeKinds: ["failed", "canceled"] },
      ];
      const items = callbacks.map((onComplete) => ({
        fnHandle: "workHandle",
        fnName: "work",
        fnArgs: {},
        fnType: "mutation" as const,
        runAt: t.now(),
        onComplete,
      }));
      const ids = batch
        ? ((await t.mutation(api.lib.enqueueBatch, { items, config: {} })) as WorkId[])
        : await Promise.all(items.map((i) => t.mutation(api.lib.enqueue, { ...i, config: {} }) as Promise<WorkId>));
      expect(
        await t.run(async (ctx: any) => Promise.all(ids.map(async (id) => (await ctx.db.get("work", id))?.onComplete))),
      ).toEqual(callbacks);
    });

    it(`rejects invalid status filters before writing any work (batch: ${batch})`, async () => {
      const valid = {
        fnHandle: "workHandle",
        fnName: "work",
        fnArgs: { payload: "x".repeat(10_000) },
        fnType: "mutation" as const,
        runAt: t.now(),
      };
      const invalid = { ...valid, onComplete: { fnHandle: "callback", excludeKinds: ["running"] } };
      await expect(
        batch
          ? t.mutation(api.lib.enqueueBatch, { items: [valid, invalid], config: {} })
          : t.mutation(api.lib.enqueue, { ...invalid, config: {} }),
      ).rejects.toThrow(/ArgumentValidationError/);
      expect(await rows("work")).toEqual([]);
      expect(await rows("pendingStart")).toEqual([]);
      expect(await rows("payload")).toEqual([]);
      expect(await rows("globals")).toEqual([]);
    });
  }

  it("should successfully enqueue a work item", async () => {
    const id = await enqueue();
    expect(id).toBeDefined();
    expect(await statusOf(t, id)).toEqual({ state: "pending", previousAttempts: 0 });
  });

  it("should throw error if maxParallelism is too high", async () => {
    await expect(enqueue({ config: { maxParallelism: 500, logLevel: "WARN" } })).rejects.toThrow(
      "maxParallelism must be <= 200",
    );
  });

  it("should throw error if maxParallelism is too low", async () => {
    await expect(enqueue({ config: { maxParallelism: -1, logLevel: "WARN" } })).rejects.toThrow(
      "maxParallelism must be >= 0",
    );
  });
});

describe("cancel", () => {
  it("should successfully queue a work item for cancelation", async () => {
    const id = await enqueue();
    await t.mutation(api.lib.cancel, { id, logLevel: "WARN" });
    const cancelations = await rows("pendingCancelation");
    expect(cancelations).toHaveLength(1);
    expect(cancelations[0].workId).toBe(id);
  });

  it("should not create duplicate cancelation requests", async () => {
    const id = await enqueue();
    await t.mutation(api.lib.cancel, { id, logLevel: "WARN" });
    await t.mutation(api.lib.cancel, { id, logLevel: "WARN" });
    const cancelations = await rows("pendingCancelation");
    expect(cancelations).toHaveLength(1);
    expect(cancelations[0].workId).toBe(id);
  });

  it("should not create cancelation for non-existent work", async () => {
    const id = await enqueue();
    await t.run((ctx: any) => ctx.db.delete("work", id));
    await t.mutation(api.lib.cancel, { id, logLevel: "WARN" });
    expect(await rows("pendingCancelation")).toHaveLength(0);
  });
});

describe("cancelAll", () => {
  it("should queue multiple work items for cancelation", async () => {
    const ids: WorkId[] = [];
    for (let i = 0; i < 3; i++) ids.push(await enqueue({ fnArgs: { test: i }, runAt: t.now() + 5 * 60 * 1000 }));
    await t.mutation(api.lib.cancelAll, { logLevel: "WARN", before: t.now() + 1000 });
    const cancelations = await rows("pendingCancelation");
    expect(cancelations).toHaveLength(3);
    expect(cancelations.map((c) => c.workId)).toEqual(expect.arrayContaining(ids));
  });

  it("should process work items in batches for cancelAll", async () => {
    const PAGE_SIZE = 64;
    for (let i = 0; i < PAGE_SIZE + 1; i++) await enqueue({ fnArgs: { test: i } });
    await t.mutation(api.lib.cancelAll, { logLevel: "WARN", before: t.now() + 1000 });
    const scheduled = (await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect())) as any[];
    expect(scheduled.length).toBeGreaterThan(0);
    // bunvex records the module's file in the name (`lib.js:cancelAll`); convex-test records `lib:cancelAll`.
    expect(scheduled.find((sf) => /^lib(\.js)?:cancelAll$/.test(sf.name))).toBeDefined();
    expect(await rows("pendingCancelation")).toHaveLength(PAGE_SIZE);
  });
});

describe("status", () => {
  it("should return finished state for non-existent work", async () => {
    const id = await enqueue();
    await t.run((ctx: any) => ctx.db.delete("work", id));
    expect(await statusOf(t, id)).toEqual({ state: "finished" });
  });

  it("should return pending state for newly enqueued work", async () => {
    const id = await enqueue();
    expect(await t.run((ctx: any) => ctx.db.get("work", id))).toBeDefined();
    const starts = await rows("pendingStart");
    expect(starts).toHaveLength(1);
    expect(starts[0].workId).toBe(id);
    expect(await statusOf(t, id)).toEqual({ state: "pending", previousAttempts: 0 });
  });

  const dropStart = () =>
    t.run(async (ctx: any) => {
      const pendingStart = await ctx.db.query("pendingStart").first();
      expect(pendingStart).not.toBeNull();
      await ctx.db.delete("pendingStart", pendingStart._id);
    });

  it("should return running state when work is in progress", async () => {
    const id = await enqueue();
    await dropStart();
    expect(await statusOf(t, id)).toEqual({ state: "running", previousAttempts: 0 });
  });

  it("should return pending state for work pending retry", async () => {
    const id = await enqueue({ retryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 } });
    await dropStart();
    await t.run((ctx: any) =>
      ctx.db.insert("pendingCompletion", {
        workId: id,
        segment: 1n,
        runResult: { kind: "failed", error: "Test error" },
        retry: true,
      }),
    );
    expect(await statusOf(t, id)).toEqual({ state: "pending", previousAttempts: 0 });
  });

  it("should return running state for work with pendingCancelation", async () => {
    const id = await enqueue();
    await dropStart();
    await t.run((ctx: any) => ctx.db.insert("pendingCancelation", { workId: id, segment: 1n }));
    expect(await statusOf(t, id)).toEqual({ state: "running", previousAttempts: 0 });
  });

  it("should return running state for work with pendingCompletion but retry=false", async () => {
    const id = await enqueue();
    await dropStart();
    await t.run((ctx: any) =>
      ctx.db.insert("pendingCompletion", {
        workId: id,
        segment: 1n,
        runResult: { kind: "failed", error: "Test error" },
        retry: false,
      }),
    );
    expect(await statusOf(t, id)).toEqual({ state: "running", previousAttempts: 0 });
  });
});

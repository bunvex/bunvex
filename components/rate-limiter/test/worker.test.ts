// Upstream's `src/component/worker.test.ts` (get-convex/rate-limiter 0.4.2, STUDY-197 §1.7), ported: the
// asynchronous mode's queue drained by the batch worker, in the component's functions pushed as the app's
// (fixtures/standalone, which mounts the batch worker as the component does). Updates take the virtual clock's time
// (`t.now()`), where upstream's take vitest's frozen `Date.now()`.
//
// Upstream lowers the whole test deployment's read limit (`convexTest({ transactionLimits })`), which
// `@bunvex/testing` has no option for (it runs Convex's limits, DV-540). The read-budget case lowers it for the work
// query alone instead, through `runQuery`'s own `transactionLimits`, which the query's metrics then report.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx and the app's api are untyped
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { BATCH_SIZE, READ_BUDGET_FRACTION, WORKER_NAME } from "../src/component/worker.ts";
import { type RateLimitConfig, SINGLETON_SHARD } from "../src/shared.ts";

const api = anyApi as any;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const STANDALONE = join(import.meta.dir, "fixtures", "standalone");
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});
function deployment() {
  const t = bunvexTest({ cwd: STANDALONE });
  open.push(t);
  return t;
}

const tokenBucket = (rest: { rate: number; period: number; capacity?: number }): RateLimitConfig => ({
  kind: "token bucket",
  ...rest,
});
const consume = (t: TestBunvex, args: { name: string; key?: string; count?: number; config: RateLimitConfig }) => ({
  kind: "consume" as const,
  name: args.name,
  key: args.key,
  count: args.count ?? 1,
  config: args.config,
  ts: t.now(),
});
const reset = (name: string) => ({ kind: "reset" as const, name });
const enqueue = (t: TestBunvex, updates: unknown[]) => t.mutation(api.lib.enqueueUpdates, { updates });
const drain = (t: TestBunvex) => t.finishAllScheduledFunctions(undefined, 1000);
const shards = (t: TestBunvex) => t.run((ctx: any) => ctx.db.query("rateLimits").collect()) as Promise<any[]>;
const pending = (t: TestBunvex) => t.run((ctx: any) => ctx.db.query("pendingUpdates").collect()) as Promise<any[]>;
async function nextBatch(t: TestBunvex, options?: unknown) {
  const result = await t.run((ctx: any) => ctx.runQuery(api.worker.getBatch, { name: WORKER_NAME }, options));
  if (result.kind !== "work") throw new Error("expected a work batch");
  return result.batch;
}

describe("worker", () => {
  test("enqueued updates are applied by the worker", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 1, period: HOUR });
    await enqueue(t, [consume(t, { name: "simple", config })]);
    // Until the worker runs, the update is queued and the limit untouched.
    expect(await shards(t)).toHaveLength(0);
    expect(await pending(t)).toHaveLength(1);
    expect(await t.query(api.lib.checkRateLimit, { name: "simple", config })).toEqual({ ok: true });

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ shard: SINGLETON_SHARD, value: 0 });
    const after = await t.query(api.lib.checkRateLimit, { name: "simple", config });
    expect(after.ok).toBe(false);
    expect(after.retryAfter).toBeGreaterThan(0);
  });

  test("updates for the same limit fold into one write", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 20, period: MINUTE, capacity: 20 });
    const enqueued = 15;
    await enqueue(
      t,
      Array.from({ length: enqueued }, () => consume(t, { name: "burst", config })),
    );
    expect(await pending(t)).toHaveLength(enqueued);

    const written = await t.run(async (ctx: any) => {
      const batch = await ctx.runQuery(api.worker.getBatch, { name: WORKER_NAME });
      expect(batch.batch.updates).toHaveLength(enqueued);
      const before = (await ctx.meta.getTransactionMetrics()).documentsWritten.used;
      await ctx.runMutation(api.worker.processBatch, batch.batch);
      return (await ctx.meta.getTransactionMetrics()).documentsWritten.used - before;
    });

    // One write for the limit, and a delete per pending update.
    expect(written).toBe(1 + enqueued);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(5);
  });

  test("a batch updates each key separately", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 10, period: HOUR, capacity: 10 });
    await enqueue(
      t,
      ["a", "b"].map((key) => consume(t, { name: "perUser", key, count: 3, config })),
    );
    await drain(t);
    expect(Object.fromEntries((await shards(t)).map((doc) => [doc.key, doc.value]))).toEqual({ a: 7, b: 7 });
  });

  test("reset is enqueued and clears the limit", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 1, period: HOUR });
    await enqueue(t, [consume(t, { name: "resettable", config })]);
    await drain(t);
    expect(await shards(t)).toHaveLength(1);

    await enqueue(t, [reset("resettable")]);
    expect(await shards(t)).toHaveLength(1);
    await drain(t);

    expect(await shards(t)).toHaveLength(0);
    expect(await t.query(api.lib.checkRateLimit, { name: "resettable", config })).toEqual({ ok: true });
  });

  test("reset then consume in the same batch starts fresh", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 10, period: MINUTE, capacity: 10 });
    await enqueue(t, [consume(t, { name: "mixed", count: 10, config })]);
    await drain(t);
    expect((await shards(t))[0].value).toBe(0);

    await enqueue(t, [reset("mixed"), consume(t, { name: "mixed", count: 3, config })]);
    await drain(t);

    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(7);
  });

  test("a stale update after a reset does not move time backwards", async () => {
    const t = deployment();
    const config = tokenBucket({ rate: 60, period: MINUTE, capacity: 10 });
    const staleTs = t.now();
    await t.advanceTime(5 * SECOND);
    const storedTs = t.now();
    await enqueue(t, [consume(t, { name: "stale", count: 10, config })]);
    await drain(t);
    expect((await shards(t))[0].ts).toBe(storedTs);

    // The reset clears the batch's state, so the stale consumption is clamped to the stored time instead.
    await enqueue(t, [reset("stale"), { ...consume(t, { name: "stale", count: 3, config }), ts: staleTs }]);
    await drain(t);

    const [applied] = await shards(t);
    expect(applied.value).toBe(7);
    expect(applied.ts).toBe(storedTs);
  });

  test("updates are applied at the time they were enqueued", async () => {
    const t = deployment();
    // One token a second.
    const config = tokenBucket({ rate: 60, period: MINUTE, capacity: 10 });
    await enqueue(t, [consume(t, { name: "accrual", count: 6, config })]);
    await t.advanceTime(5 * SECOND);
    const secondEnqueuedAt = t.now();
    await enqueue(t, [consume(t, { name: "accrual", count: 3, config })]);
    await t.advanceTime(MINUTE);
    await drain(t);

    const [applied] = await shards(t);
    // 10 - 6 = 4, then 5 tokens accrue over the 5 s between the updates: 9 - 3.
    expect(applied.value).toBeCloseTo(6, 6);
    expect(applied.ts).toBe(secondEnqueuedAt);
  });

  test("the worker drains multiple batches", async () => {
    const t = deployment();
    const enqueued = BATCH_SIZE + 10;
    const config = tokenBucket({ rate: 2 * enqueued, period: MINUTE, capacity: 2 * enqueued });
    await enqueue(
      t,
      Array.from({ length: enqueued }, () => consume(t, { name: "big", config })),
    );
    expect(await pending(t)).toHaveLength(enqueued);
    expect((await nextBatch(t)).updates).toHaveLength(BATCH_SIZE);

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    expect((await shards(t))[0].value).toBe(2 * enqueued - enqueued);
  });

  test("batches are capped by the transaction read limit", async () => {
    const MAX_BYTES_READ = 256 * 1024;
    const BYTES_PER_UPDATE = 4 * 1024;
    // The work query stops once it has read its share of the read limit.
    const updatesPerBatch = Math.floor((MAX_BYTES_READ * READ_BUDGET_FRACTION) / BYTES_PER_UPDATE);
    const enqueued = (2 * updatesPerBatch) / READ_BUDGET_FRACTION;

    const t = deployment();
    const config = tokenBucket({ rate: 2 * enqueued, period: MINUTE, capacity: 2 * enqueued });
    const key = "x".repeat(BYTES_PER_UPDATE);
    await enqueue(
      t,
      Array.from({ length: enqueued }, () => consume(t, { name: "sized", key, config })),
    );

    // The batch ends on the first update that crosses the budget.
    const updates = (await nextBatch(t, { transactionLimits: { bytesRead: MAX_BYTES_READ } })).updates;
    expect(updates.length).toBeGreaterThan(updatesPerBatch / 2);
    expect(updates.length).toBeLessThanOrEqual(updatesPerBatch + 1);

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(enqueued);
  });
});

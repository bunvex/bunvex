// Where a call takes its permit (STUDY-68, STUDY-194 §4.13), as Convex at precompiled-2026-10-24-bb31399:
// - a query after its path and arguments are checked (`CacheManager::get`): one that fails them never waits;
// - a client's mutation before its transaction begins (d328f85, STUDY-186 A11): its snapshot has what committed
//   while it waited, and a request whose outcome is recorded is still answered without a permit;
// - a scheduled mutation in its transaction, as before (Convex kept their order).
// The waits time out on virtual time (STUDY-132).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { TestRuntime } from "@bunvex/core/test-runtime";
import { v } from "@bunvex/values";
import { functionLimitsFromEnv, TooManyConcurrentRequestsError } from "../src/action-permits.ts";
import { Functions, mutation, query } from "../src/functions.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function until(f: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (f()) return;
    await Bun.sleep(1);
  }
  throw new Error(`never: ${what}`);
}

async function setup() {
  const rt = new TestRuntime();
  const engine = await new Engine(
    defineSchema({ counters: defineTable({ n: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
    { runtime: rt },
  ).init();
  const limits = functionLimitsFromEnv(
    {
      APPLICATION_MAX_CONCURRENT_QUERIES: "1",
      APPLICATION_MAX_CONCURRENT_MUTATIONS: "1",
      APPLICATION_FUNCTION_RUNNER_SEMAPHORE_TIMEOUT: "40",
    },
    undefined,
    rt,
  );
  const functions = new Functions(engine, { limits }).register("m", {
    read: query(async ({ db }, { id }: { id: string }) => ((await db.get(id as never)) as { n: number }).n),
    typed: query({ args: { n: v.number() }, handler: (_ctx, { n }) => n }),
    bump: mutation(async ({ db }, { id }: { id: string }) => {
      const n = ((await db.get(id as never)) as { n: number }).n;
      await db.patch(id as never, { n: n + 1 });
      return n;
    }),
    typedMutation: mutation({ args: { n: v.number() }, handler: (_ctx, { n }) => n }),
  });
  const id = (await engine.mutation((db) => db.insert("counters", { n: 0 }))) as string;
  const queued = (kind: "query" | "mutation") =>
    until(() => limits[kind].outstanding.queued === 1, `a ${kind} waiting for its permit`);
  return { engine, functions, limits, rt, id, queued };
}

test("a server's engine under the tests round-trips its calls through the codec (STUDY-194 Q7)", async () => {
  expect((await setup()).engine.callCodec).toBe(true);
});

test("a query whose arguments fail their validator fails at once, without waiting for a permit", async () => {
  const t = await setup();
  const release = await t.limits.query.acquire();
  await expect(t.functions.runQuery("m:typed", { n: "x" })).rejects.toThrow("ArgumentValidationError");
  await expect(t.functions.runQuery("m:missing", {})).rejects.toThrow("Could not find public function");
  expect(t.limits.query.stats.refused).toBe(0);
  // A valid one waits for it.
  const waiting = t.functions.runQuery("m:typed", { n: 1 });
  await t.queued("query");
  release();
  expect(await waiting).toBe(1);
});

test("a client's mutation takes its permit before its transaction: what commits meanwhile is in its snapshot", async () => {
  const t = await setup();
  const release = await t.limits.mutation.acquire();
  const bumped = t.functions.runMutation("m:bump", { id: t.id });
  await t.queued("mutation");
  // An engine write needs no permit: it commits while the mutation waits.
  await t.engine.mutation((db) => db.patch(t.id as never, { n: 10 }));
  const retries = t.engine.stats.retries;
  release();
  expect(await bumped).toBe(10);
  // Its first attempt read the write it waited behind: no conflict, no retry.
  expect(t.engine.stats.retries).toBe(retries);
});

test("a client's mutation waits for its permit before its arguments are checked, as Convex's", async () => {
  const t = await setup();
  const release = await t.limits.mutation.acquire();
  const refused = t.functions.runMutation("m:typedMutation", { n: "x" }).catch((e) => e);
  await t.queued("mutation");
  await t.rt.advance(40);
  expect(await refused).toBeInstanceOf(TooManyConcurrentRequestsError);
  release();
  await expect(t.functions.runMutation("m:typedMutation", { n: "x" })).rejects.toThrow("ArgumentValidationError");
});

test("a session's request already committed is answered without a permit; a new one is refused", async () => {
  const t = await setup();
  const first = await t.functions.runSessionMutation("m:bump", { id: t.id }, { sessionId: "s", requestId: 1 });
  expect("value" in first && first.value).toBe(0);
  const release = await t.limits.mutation.acquire();
  const again = t.functions.runSessionMutation("m:bump", { id: t.id }, { sessionId: "s", requestId: 1 });
  const fresh = t.functions
    .runSessionMutation("m:bump", { id: t.id }, { sessionId: "s", requestId: 2 })
    .catch((e: unknown) => e);
  await until(() => t.limits.mutation.outstanding.queued === 2, "two mutations waiting");
  await t.rt.advance(40);
  const replayed = await again;
  expect("replayed" in replayed && JSON.parse(replayed.replayed.result)).toBe(0);
  expect(await fresh).toBeInstanceOf(TooManyConcurrentRequestsError);
  release();
  expect(await t.functions.runQuery("m:read", { id: t.id })).toBe(1);
});

test("a query runs the function its arguments were checked against, even if new code lands while it waits for its permit", async () => {
  const t = await setup();
  const release = await t.limits.query.acquire();
  const waiting = t.functions.runQuery("m:typed", { n: 1 });
  await t.queued("query");
  // New code for the same path, whose validator would refuse these arguments.
  t.functions.register("m", {
    typed: query({ args: { n: v.string() }, handler: (_ctx, { n }) => `new:${typeof n}` }),
  });
  release();
  // The old function, whose validator accepted { n: 1 }: never the new handler on unchecked arguments.
  expect(await waiting).toBe(1);
  // A call made now checks against, and runs, the new one (other arguments: `register` keeps the query cache).
  await expect(t.functions.runQuery("m:typed", { n: 2 })).rejects.toThrow("ArgumentValidationError");
  expect(await t.functions.runQuery("m:typed", { n: "x" })).toBe("new:string");
});

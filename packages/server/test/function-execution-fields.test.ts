// The log streams' `function_execution` fields DV-305 left out (STUDY-74), as Convex fills them: `run_reason`
// of a sync query (its initial subscription, a data change, an identity change), `scheduler_info`,
// `function_args_bytes`, `mutation_retry_count` (and the lost attempt's empty error), `mutation_queue_length`.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, internalIdOf } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5f".repeat(32);
const NAME = "fields-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(opts: { maxRetries?: number } = {}) {
  const store = await MemoryPersistence.open(null, { durable: false });
  // A gate on reading one document: the mutation that reads it waits until the test opens it.
  const gate = { id: "", open: Promise.resolve() as Promise<void> };
  const get = store.get.bind(store);
  store.get = (async (...a: Parameters<typeof get>) => {
    // Persistence keys a document by its internal id (STUDY-133 PR 3).
    if (gate.id !== "" && a[1] === internalIdOf(gate.id)) await gate.open;
    return get(...a);
  }) as unknown as typeof store.get;
  const engine = await new Engine(defineSchema({ items: defineTable(v.any()) }), store, {
    instanceName: NAME,
    instanceSecret: SECRET,
    occInitialBackoffMs: 1,
    occMaxBackoffMs: 2,
    ...opts,
  }).init();
  const id = await engine.mutation((db) => db.insert("items", { n: 0 }));
  let attempts = 0;
  let jobAttempts = 0;
  const functions = new Functions(engine).register("m", {
    // Reads the identity too, so a new identity runs it again rather than sharing a result.
    count: query(async ({ db, auth }) => [(await db.query("items").collect()).length, await auth.getUserIdentity()]),
    add: mutation(({ db }, { tag }: { tag: string }) => db.insert("items", { tag })),
    gated: mutation(async ({ db }, { i }: { i: number }) => {
      await db.get(gate.id as never);
      return db.insert("items", { i });
    }),
    later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:job" as never, { x: 1 })),
    job: mutation(({ db }) => db.insert("items", { job: true })),
    contended: mutation(async ({ db }) => {
      await db.get(id as never);
      if (attempts++ === 0) await engine.mutation((d) => d.patch(id as never, { n: 2 }), "m:rival");
      await db.patch(id as never, { n: 3 });
      return "the same value either time";
    }),
    act: action(async () => 1),
    laterContended: mutation(({ scheduler }) => scheduler.runAfter(0, "m:contendedJob" as never, {})),
    contendedJob: mutation(async ({ db }) => {
      await db.get(id as never);
      if (jobAttempts++ === 0) await engine.mutation((d) => d.patch(id as never, { n: 5 }), "m:rival");
      await db.patch(id as never, { n: 6 });
    }),
  });
  const router = httpRouter();
  router.route({ path: "/hook", method: "POST", handler: httpAction(async () => new Response("ok")) });
  const s = createServer({ engine, functions, port: 0, http: router });
  stops.push(() => s.stop());
  const events: Record<string, any>[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "function_execution") events.push(eventJsonV2(x));
    },
  } as never;
  const api = `http://127.0.0.1:${s.server.port}`;
  const call = (kind: string, path: string, args: unknown = {}) =>
    fetch(`${api}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    }).then((r) => r.json());
  const of = (path: string) => events.filter((e) => e.function.path === path);
  const until = async <T>(f: () => T | undefined | false) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  const hold = () => {
    let release = () => {};
    gate.id = id as string;
    gate.open = new Promise<void>((r) => (release = r));
    return release;
  };
  return { s, call, of, until, events, hold };
}

test("run_reason of a sync query: its initial subscription, a data change, an identity change", async () => {
  const t = await setup();
  const c = await v1Client(syncUrl(t.s.server.port));
  c.modify([add(1, "m:count")]);
  await t.until(() => t.of("m.js:count").length === 1);
  await t.call("mutation", "m:add", { tag: "a" });
  await t.until(() => t.of("m.js:count").length === 2);
  c.send({ type: "Authenticate", tokenType: "Admin", value: KEY, baseVersion: 0 } as v1.ClientMessage);
  await t.until(() => t.of("m.js:count").length === 3);
  expect(t.of("m.js:count").map((e) => e.run_reason)).toEqual(["initialSubscription", "dataChange", "identityChange"]);
  // Other callers' queries: their caller's reason.
  await t.call("query", "m:count");
  expect(t.of("m.js:count").at(-1)!.run_reason).toBe("httpApi");
});

test("scheduler_info carries the job's id; others have none", async () => {
  const t = await setup();
  const scheduled = (await t.call("mutation", "m:later")) as { value: string };
  const job = await t.until(() => t.of("m.js:job")[0]);
  expect(job).toMatchObject({ run_reason: "scheduler", scheduler_info: { job_id: scheduled.value } });
  expect(t.of("m.js:later")[0]).toMatchObject({ run_reason: "httpApi", scheduler_info: null });
});

test("function_args_bytes: the arguments' JSON array; none for an HTTP action", async () => {
  const t = await setup();
  await t.call("mutation", "m:add", { tag: "xyz" });
  expect(t.of("m.js:add")[0].usage.function_args_bytes).toBe(JSON.stringify([{ tag: "xyz" }]).length);
  await t.call("action", "m:act");
  expect(t.of("m.js:act")[0].usage.function_args_bytes).toBe(2 + 2);
  await fetch(`http://127.0.0.1:${t.s.site!.port}/hook`, { method: "POST" }).catch(() => null);
  const http = await t.until(() => t.events.find((e) => e.function.type === "http_action"));
  expect(http.usage.function_args_bytes).toBeNull();
});

test("mutation_retry_count per attempt; the lost attempt has no error, as Convex's", async () => {
  const t = await setup();
  await t.call("mutation", "m:contended");
  const [lost, won] = t.of("m.js:contended");
  expect(lost).toMatchObject({ will_retry: true, status: "success", error_message: null });
  expect(lost.function.mutation_retry_count).toBe(0);
  expect(lost.occ_info).not.toBeNull();
  expect(won).toMatchObject({ will_retry: false, status: "success" });
  expect(won.function.mutation_retry_count).toBe(1);
  // What the lost attempt returned is measured too, as Convex logs it before failing it.
  expect(won.usage.function_returns_bytes).toBeGreaterThan(0);
  expect(lost.usage.function_returns_bytes).toBe(won.usage.function_returns_bytes);
  await t.call("query", "m:count");
  expect(t.of("m.js:count")[0].function.mutation_retry_count).toBeNull();
});

test("mutation_queue_length: a WebSocket mutation's waiting predecessors; none over HTTP", async () => {
  const t = await setup();
  const c = await v1Client(syncUrl(t.s.server.port));
  const release = t.hold();
  for (let i = 0; i < 3; i++) {
    c.mutate(i + 1, "m:gated", { i });
    await Bun.sleep(20); // each frame read before the next is sent
  }
  release();
  await t.until(() => t.of("m.js:gated").length === 3);
  // The first arrives to an empty queue; the second while the first runs; the third with the second waiting.
  expect(t.of("m.js:gated").map((e) => e.function.mutation_queue_length)).toEqual([0, 0, 1]);
  await t.call("mutation", "m:add", { tag: "h" });
  expect(t.of("m.js:add")[0].function.mutation_queue_length).toBeNull();
});

test("a scheduled mutation's lost attempt: will_retry, then the next attempt's count", async () => {
  const t = await setup();
  await t.call("mutation", "m:laterContended");
  const [lost, won] = await t.until(() => t.of("m.js:contendedJob").length === 2 && t.of("m.js:contendedJob"));
  expect(lost).toMatchObject({ will_retry: true, status: "success", error_message: null, run_reason: "scheduler" });
  expect([lost.function.mutation_retry_count, won.function.mutation_retry_count]).toEqual([0, 1]);
  expect(won).toMatchObject({ will_retry: false, status: "success" });
});

test("a scheduled mutation whose conflict escapes the engine's retries: the scheduler's loop counts on", async () => {
  // No retries in the engine: the conflict reaches the scheduler, which runs the job again.
  const t = await setup({ maxRetries: 0 });
  await t.call("mutation", "m:laterContended");
  const [lost, won] = await t.until(() => t.of("m.js:contendedJob").length === 2 && t.of("m.js:contendedJob"));
  expect(lost).toMatchObject({ will_retry: true, status: "success", error_message: null });
  expect([lost.function.mutation_retry_count, won.function.mutation_retry_count]).toEqual([0, 1]);
});

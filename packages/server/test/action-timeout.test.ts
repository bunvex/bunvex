// The action timeout (STUDY-77), as Convex's V8_ACTION_USER_TIMEOUT (1800 s) and NODE_ACTION_USER_TIMEOUT
// (600 s): awaited calls count; Convex's messages; a user error for the caller, the function log and a
// scheduled job; the permit freed; the cut-off handler can no longer call `ctx` or `fetch`.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { ActionPermits } from "../src/action-permits.ts";
import { FunctionLog } from "../src/function-log.ts";
import {
  action,
  type FunctionDef,
  Functions,
  internalAction,
  internalMutation,
  mutation,
  NODE_FUNCTIONS,
  query,
} from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { ScheduledJobExecutor } from "../src/scheduler.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
};

async function setup(o: { timeoutMs?: number; nodeTimeoutMs?: number; permits?: number } = {}) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const seen: string[] = [];
  // A server that never answers: an action's fetch to it hangs until it is aborted.
  const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  stops.push(() => hang.stop(true));
  const slowNode = action(async () => {
    await Bun.sleep(10_000);
  });
  NODE_FUNCTIONS.add(slowNode as FunctionDef);
  const functions = new Functions(engine, {
    ...(o.permits ? { actionPermits: new ActionPermits(o.permits, 5_000) } : {}),
  }).register("m", {
    count: query(async ({ db }) => (await db.query("items").collect()).length),
    insert: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      await db.insert("items", { tag });
    }),
    sleep: action(async (_, { ms }: { ms: number }) => {
      console.log("going to sleep");
      await Bun.sleep(ms);
      return "awake";
    }),
    sleepThenLog: action(async () => {
      await Bun.sleep(300);
      console.log("too late");
      seen.push("logged");
    }),
    // Its time goes in awaited queries: they count, as Convex counts an action's syscalls.
    manyQueries: action(async ({ runQuery }) => {
      for (;;) {
        await runQuery("m:count" as never);
        await Bun.sleep(10);
      }
    }),
    // Cut off while it waits on a fetch: the fetch is aborted, and what it does next never starts.
    fetchThenWrite: action(async ({ runMutation, scheduler, storage }) => {
      try {
        await fetch(`http://127.0.0.1:${hang.port}/`);
      } catch (e) {
        seen.push(`fetch: ${(e as Error).message}`);
      }
      for (const [what, call] of [
        ["runMutation", () => runMutation("m:insert" as never, { tag: "late" } as never)],
        ["scheduler", () => scheduler.runAfter(0, "m:insert" as never, { tag: "late" } as never)],
        ["storage", () => storage.getUrl("x" as never)],
        ["fetch", () => fetch(`http://127.0.0.1:${hang.port}/`)],
      ] as const) {
        try {
          await call();
          seen.push(`${what}: ran`);
        } catch (e) {
          seen.push(`${what}: ${(e as Error).message}`);
        }
      }
    }),
    parent: action(async ({ runAction }) => {
      await runAction("m:child" as never);
    }),
    child: internalAction(async ({ runMutation }) => {
      await Bun.sleep(400);
      try {
        await runMutation("m:insert" as never, { tag: "child" } as never);
        seen.push("child: ran");
      } catch (e) {
        seen.push(`child: ${(e as Error).message}`);
      }
    }),
    slowNode,
  });
  if (o.timeoutMs !== undefined) functions.actionTimeoutMs = o.timeoutMs;
  if (o.nodeTimeoutMs !== undefined) functions.nodeActionTimeoutMs = o.nodeTimeoutMs;
  const count = async () => (await functions.runQuery("m:count", {})) as number;
  return { engine, functions, seen, count };
}

describe("the action timeout", () => {
  test("Convex's defaults and knobs: 1800 s, 600 s for a Node action", async () => {
    const { functions } = await setup();
    expect(functions.actionTimeoutMs).toBe(1_800_000);
    expect(functions.nodeActionTimeoutMs).toBe(600_000);
    process.env.V8_ACTION_USER_TIMEOUT_SECS = "2";
    process.env.NODE_ACTION_USER_TIMEOUT_SECS = "3";
    try {
      const { functions: f } = await setup();
      expect(f.actionTimeoutMs).toBe(2000);
      expect(f.nodeActionTimeoutMs).toBe(3000);
    } finally {
      delete process.env.V8_ACTION_USER_TIMEOUT_SECS;
      delete process.env.NODE_ACTION_USER_TIMEOUT_SECS;
    }
  });

  test("an action within its time is untouched", async () => {
    const { functions } = await setup({ timeoutMs: 500 });
    expect(await functions.runAction("m:sleep", { ms: 20 })).toBe("awake");
  });

  test("past it the action fails with Convex's message, its awaited calls counted", async () => {
    const { functions } = await setup({ timeoutMs: 150 });
    const t0 = performance.now();
    const e = (await functions.runAction("m:sleep", { ms: 5000 }).catch((x) => x)) as Error;
    expect(e.message).toBe("Function execution timed out (maximum duration: 150ms)");
    expect(performance.now() - t0).toBeLessThan(1000);
    // Time in awaited queries is the action's time too.
    const q = (await functions.runAction("m:manyQueries", {}).catch((x) => x)) as Error;
    expect(q.message).toBe("Function execution timed out (maximum duration: 150ms)");
  });

  test("a Node action's message is the Node executor's, with its export name", async () => {
    const { functions } = await setup({ nodeTimeoutMs: 100 });
    const e = (await functions.runAction("m:slowNode", {}).catch((x) => x)) as Error;
    expect(e.message).toBe("Action `slowNode` execution timed out (maximum duration 0.1s)");
  });

  test("the cut-off action can start nothing more: its fetch is aborted, ctx calls and fetch refused", async () => {
    const { functions, seen, count } = await setup({ timeoutMs: 150 });
    const e = (await functions.runAction("m:fetchThenWrite", {}).catch((x) => x)) as Error;
    expect(e.message).toBe("Function execution timed out (maximum duration: 150ms)");
    await until(() => seen.length === 5, "the cut-off handler ran to its end");
    const timedOut = "Function execution timed out (maximum duration: 150ms)";
    expect(seen).toEqual([
      `fetch: ${timedOut}`,
      `runMutation: ${timedOut}`,
      `scheduler: ${timedOut}`,
      `storage: ${timedOut}`,
      `fetch: ${timedOut}`,
    ]);
    expect(await count()).toBe(0);
  });

  test("an action called by a timed-out action is cut off with it", async () => {
    const { functions, seen, count } = await setup({ timeoutMs: 150 });
    const e = (await functions.runAction("m:parent", {}).catch((x) => x)) as Error;
    expect(e.message).toBe("Function execution timed out (maximum duration: 150ms)");
    await until(() => seen.length === 1, "the child woke up");
    expect(seen).toEqual(["child: Function execution timed out (maximum duration: 150ms)"]);
    expect(await count()).toBe(0);
  });

  test("its permit is free again: the next action runs", async () => {
    const { functions } = await setup({ timeoutMs: 100, permits: 1 });
    await functions.runAction("m:sleep", { ms: 60_000 }).catch(() => {});
    expect(await functions.runAction("m:sleep", { ms: 1 })).toBe("awake");
  });

  test("the function log records a failure with the message and the lines printed so far", async () => {
    const { functions } = await setup({ timeoutMs: 100 });
    const log = new FunctionLog();
    functions.functionLog = log;
    await functions.runAction("m:sleep", { ms: 60_000 }).catch(() => {});
    const { parts } = await log.after(0, 1000);
    const done = parts.find((p) => p.kind === "Completion") as Record<string, unknown>;
    expect(done).toMatchObject({
      identifier: "m:sleep",
      error: "Function execution timed out (maximum duration: 100ms)\n",
      logLines: [expect.objectContaining({ level: "LOG", messages: ["'going to sleep'"] })],
    });
  });

  test("a cut-off action's later lines are not in the log", async () => {
    const { functions, seen } = await setup({ timeoutMs: 100 });
    const log = new FunctionLog();
    functions.functionLog = log;
    await functions.runAction("m:sleepThenLog", {}).catch(() => {});
    await until(() => seen.length === 1, "the cut-off handler logged");
    const { parts } = await log.after(0, 100);
    expect(parts.map((p) => p.kind)).toEqual(["Completion"]);
  });

  test("a client gets a user error: Server Error and the message (HTTP 200, status error)", async () => {
    const { engine, functions } = await setup({ timeoutMs: 100 });
    const server = createServer({ engine, functions, port: 0 });
    stops.push(server.stop);
    const res = await fetch(`http://127.0.0.1:${server.server.port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:sleep", args: { ms: 60_000 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; errorMessage: string; logLines: string[] };
    expect(body.status).toBe("error");
    expect(body.errorMessage).toMatch(
      /^\[Request ID: [0-9a-f]{16}\] Server Error\nFunction execution timed out \(maximum duration: 100ms\)\n?$/,
    );
    expect(body.logLines).toEqual(["[LOG] 'going to sleep'"]);
  });

  test("a scheduled action that times out is failed with the message, never retried", async () => {
    const { engine, functions } = await setup({ timeoutMs: 100 });
    const executor = new ScheduledJobExecutor(engine, functions, {});
    executor.start();
    stops.push(() => executor.stop());
    const scheduler = functions.register("s", {
      later: mutation(({ scheduler }) => scheduler.runAfter(0, "m:sleep" as never, { ms: 60_000 } as never)),
      job: query(async ({ db }, { id }: { id: string }) => db.system.get(id as never)),
    });
    const jobId = (await scheduler.runMutation("s:later", {})) as string;
    const state = async () =>
      ((await functions.runQuery("s:job", { id: jobId })) as { state: { kind: string; error?: string } }).state;
    await until(async () => (await state()).kind === "failed", "the job failed");
    expect(await state()).toEqual({
      kind: "failed",
      error: "Function execution timed out (maximum duration: 100ms)\n",
    });
  });

  test("an HTTP action shares it: a 500 with the message when no head was sent", async () => {
    const { engine, functions } = await setup({ timeoutMs: 100 });
    const http = httpRouter();
    http.route({
      path: "/slow",
      method: "GET",
      handler: httpAction(async () => {
        await Bun.sleep(60_000);
        return new Response("late");
      }),
    });
    const server = createServer({ engine, functions, port: 0, http, httpActionHeadTimeoutMs: 5000 });
    stops.push(server.stop);
    const res = await fetch(`${server.siteUrl}/slow`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; trace: string };
    expect(body.code).toMatch(
      /^\[Request ID: [0-9a-f]{16}\] Server Error: Function execution timed out \(maximum duration: 100ms\)$/,
    );
    expect(body.trace).toBe("Function execution timed out (maximum duration: 100ms)");
  });
});

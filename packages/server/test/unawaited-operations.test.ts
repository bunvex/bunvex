// The unawaited-operations warning (STUDY-143), as Convex's `add_warnings_to_log_lines`: what counts (ctx's calls,
// `ctx.meta`, `createFunctionHandle`, `log.audit`, a multipart `formData()`; not a timer). An answer is handed over
// in a later turn of the event loop, as Convex's tasks are: a call left unawaited still counts when the action
// returns at once, one it awaited does not, one answered while an HTTP action's body streams does not; an action
// that timed out lists what was pending then. The same cases run against Convex's backend in
// packages/differential/test/unawaited-operations.test.ts.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createFunctionHandle } from "../src/function-handles.ts";
import { action, Functions, query } from "../src/functions.ts";
import { log } from "../src/log.ts";
import type { LogEvent } from "../src/log-events.ts";
import { eventJsonV2 } from "../src/log-events.ts";
import { collectLogs } from "../src/logs.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

const line = (n: number, names: string) =>
  `[WARN] ${n} unawaited operation${n === 1 ? "" : "s"}: [${names}]. Async operations should be awaited or they might not run.`;

async function setup() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  // biome-ignore lint/suspicious/noExplicitAny: ctx.meta and the calls under test
  const operations = (ctx: any): Record<string, () => Promise<unknown>> => ({
    query: () => ctx.runQuery("m:q", {}),
    getUserIdentity: () => ctx.auth.getUserIdentity(),
    functionMetadata: () => ctx.meta.getFunctionMetadata(),
    deploymentMetadata: () => ctx.meta.getDeploymentMetadata(),
    requestMetadata: () => ctx.meta.getRequestMetadata(),
    handle: () => createFunctionHandle("m:q"),
    audit: () => log.audit({ action: "x" }),
    timer: () => new Promise((r) => setTimeout(r, 50)),
  });
  const functions = new Functions(engine).register("m", {
    q: query(async () => 1),
    leave: action(async (ctx, { which }: { which: string[] }) => {
      const all = operations(ctx);
      for (const w of which) void all[w]!().catch(() => {});
      return null;
    }),
    awaited: action(async (ctx, { which }: { which: string[] }) => {
      const all = operations(ctx);
      await Promise.allSettled(which.map((w) => all[w]!()));
      return null;
    }),
    // Left unawaited, but answered while the action waited on a timer: handled by then, as in Convex.
    later: action(async (ctx) => {
      void ctx.runQuery("m:q" as never, {});
      void ctx.auth.getUserIdentity();
      await new Promise((r) => setTimeout(r, 20));
      return null;
    }),
    // Not an async function: its operations are read at once.
    plain: action((ctx) => {
      void ctx.runQuery("m:q" as never, {});
      return null;
    }),
    hang: action(async (ctx) => {
      void ctx.runQuery("m:q" as never, {});
      // Refused once the action is cut off; caught, or its rejection would fail whichever test runs 10 s later.
      void new Promise((r) => setTimeout(r, 10_000)).then(() => ctx.runQuery("m:q" as never, {})).catch(() => {});
      void fetch("http://127.0.0.1:1/").catch(() => {});
      await new Promise(() => {});
    }),
  });
  const events: Record<string, unknown>[] = [];
  functions.functionLog = { append: () => {} } as never;
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "console") events.push(eventJsonV2(x));
    },
  } as never;
  const warnings = async (run: () => Promise<unknown>) =>
    (await collectLogs(run)).logLines.filter((l) => l.includes("unawaited"));
  return { engine, functions, warnings, events };
}

test("what counts: ctx's calls, ctx.meta, createFunctionHandle, log.audit; not a timer", async () => {
  const t = await setup();
  const leave = (which: string[]) => t.warnings(() => t.functions.runAction("m:leave", { which }));
  // Each of these answers within microtasks: still pending when the handler settled, as Convex reads them.
  expect(await leave(["query", "query", "getUserIdentity"])).toEqual([line(3, "getUserIdentity, query")]);
  expect(await leave(["functionMetadata", "deploymentMetadata", "requestMetadata", "handle", "audit"])).toEqual([
    line(5, "auditLog, createFunctionHandle, getDeploymentMetadata, getFunctionMetadata, getRequestMetadata"),
  ]);
  expect(await leave(["timer"])).toEqual([]);
  expect(await t.warnings(() => t.functions.runAction("m:later", {}))).toEqual([]);
  expect(await t.warnings(() => t.functions.runAction("m:plain", {}))).toEqual([line(1, "query")]);
  expect(t.events.find((e) => String(e.message).includes("unawaited"))?.system_code).toBe("UnawaitedOperations");
});

test("an action that awaited everything has none", async () => {
  const t = await setup();
  const all = ["query", "getUserIdentity", "functionMetadata", "handle", "audit", "timer"];
  expect(await t.warnings(() => t.functions.runAction("m:awaited", { which: all }))).toEqual([]);
});

test("an action that timed out lists what was pending at the timeout", async () => {
  const t = await setup();
  t.functions.actionTimeoutMs = 300;
  // The query and the refused fetch settled long before; the timer's query never started.
  expect(await t.warnings(() => t.functions.runAction("m:hang", {}).catch(() => null))).toEqual([]);
});

test("an HTTP action: a multipart formData() and a runQuery left pending; not a form that is not multipart, nor a call answered while the body streamed", async () => {
  const t = await setup();
  const http = httpRouter();
  http.route({
    path: "/form",
    method: "POST",
    handler: httpAction(async (_ctx, req) => {
      void req.formData().catch(() => {});
      return new Response("ok");
    }),
  });
  http.route({
    path: "/query",
    method: "GET",
    handler: httpAction(async (ctx) => {
      void ctx.runQuery("m:q" as never, {});
      return new Response("ok");
    }),
  });
  // Its query answers while the body streams: handled before the warning is read, as in Convex.
  http.route({
    path: "/stream",
    method: "GET",
    handler: httpAction(async (ctx) => {
      void ctx.runQuery("m:q" as never, {});
      let n = 0;
      const body = new ReadableStream({
        async pull(c) {
          await Bun.sleep(20);
          if (n++ === 3) c.close();
          else c.enqueue(new TextEncoder().encode("x"));
        },
      });
      return new Response(body);
    }),
  });
  const logManager = t.functions.logManager;
  const app = createServer({ engine: t.engine, functions: t.functions, port: 0, sitePort: null, http });
  stops.push(() => app.stop());
  t.functions.logManager = logManager; // the server set its own: the test's collects the lines again
  const base = `http://127.0.0.1:${app.server.port}/http`;
  const form = new FormData();
  form.append("a", "b");
  await (await fetch(`${base}/form`, { method: "POST", body: form })).text();
  await (await fetch(`${base}/form`, { method: "POST", body: new URLSearchParams({ a: "b" }) })).text();
  await (await fetch(`${base}/query`)).text();
  expect(await (await fetch(`${base}/stream`)).text()).toBe("xxx");
  await Bun.sleep(100);
  const byRoute = t.events
    .filter((e) => String(e.message).includes("unawaited"))
    .map((e) => [(e.function as { path: string }).path, `[WARN] ${e.message}`]);
  expect(byRoute).toEqual([
    ["POST /form", line(1, "formData")],
    ["GET /query", line(1, "query")],
  ]);
});

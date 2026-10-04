// An HTTP action's run is logged once its response is sent (STUDY-76, DV-323), as Convex's: its duration
// covers the body, its lines end with the response-size warning, and a chunk past 20 MiB is dropped with an
// `error:httpAction` line (later chunks that fit still go). A HEAD request or a client that goes away still
// gets the run logged.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import type { FunctionLog } from "../src/function-log.ts";
import { Functions } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const MiB = 1 << 20;
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  delete process.env.FUNCTION_LIMIT_WARNING_RATIO;
});

/** A body of `sizes` chunks, `delayMs` apart; `fail` errors it after them. */
const chunks = (sizes: number[], delayMs = 0, fail = false) =>
  new ReadableStream<Uint8Array>({
    async start(c) {
      for (const n of sizes) {
        if (delayMs) await Bun.sleep(delayMs);
        c.enqueue(new Uint8Array(n));
      }
      if (fail) c.error(new Error("the body broke"));
      else c.close();
    },
  });

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const http = httpRouter();
  const route = (path: string, body: () => ReadableStream<Uint8Array> | string) =>
    http.route({ path, method: "GET", handler: httpAction(async () => new Response(body())) });
  route("/slow", () => chunks([10, 10, 10], 60));
  route("/big", () => chunks([15 * MiB, 10 * MiB, MiB]));
  route("/broken", () => chunks([5], 0, true));
  route("/small", () => "ok");
  // A body that never ends (an event stream).
  route(
    "/endless",
    () =>
      new ReadableStream<Uint8Array>({
        async pull(c) {
          await Bun.sleep(20);
          c.enqueue(new Uint8Array(1));
        },
      }),
  );
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, http });
  stops.push(() => s.stop());
  const completions: any[] = [];
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") completions.push(p);
    },
  } as unknown as FunctionLog;
  const consoleEvents: Record<string, any>[] = [];
  functions.logManager = {
    active: true,
    send: (e: LogEvent[]) => {
      for (const x of e) if (x.event.topic === "console") consoleEvents.push(eventJsonV2(x));
    },
  } as never;
  const site = `http://127.0.0.1:${s.site!.port}`;
  const until = async <T>(f: () => T | undefined | false) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error("timed out");
  };
  const logged = (path: string, method = "GET") =>
    until(() => completions.find((c) => c.identifier === `${method} ${path}`));
  return { site, completions, consoleEvents, logged, until };
}

test("the run is logged once its body is sent: its time covers the body", async () => {
  const t = await setup();
  const r = await fetch(`${t.site}/slow`);
  expect(t.completions).toEqual([]); // the head came; the body is still coming
  expect((await r.arrayBuffer()).byteLength).toBe(30);
  const c = await t.logged("/slow");
  expect(c.executionTime).toBeGreaterThanOrEqual(0.15);
});

test("past 80 % of 20 MiB: the warning in the run's lines", async () => {
  process.env.FUNCTION_LIMIT_WARNING_RATIO = "0.00000001";
  const t = await setup();
  await (await fetch(`${t.site}/small`)).text();
  const c = await t.logged("/small");
  expect(JSON.stringify(c.logLines)).toContain("Large response returned from an HTTP action (actual: 2 bytes");
  expect(t.consoleEvents.map((e) => e.system_code)).toContain("warning:HttpResponseTooLarge");
});

test("a chunk past 20 MiB is dropped with Convex's error line; a later one that fits still goes", async () => {
  const t = await setup();
  const r = await fetch(`${t.site}/big`);
  expect((await r.arrayBuffer()).byteLength).toBe(16 * MiB);
  const c = await t.logged("/big");
  expect(JSON.stringify(c.logLines)).toContain("HttpResponseTooLarge: HTTP actions support responses up to 20 MiB");
  const line = t.consoleEvents.find((e) => e.message.startsWith("HttpResponseTooLarge"))!;
  expect(line).toMatchObject({ log_level: "ERROR", system_code: "error:httpAction" });
});

test("a body that fails: an error line; the run is logged", async () => {
  const t = await setup();
  await fetch(`${t.site}/broken`)
    .then((r) => r.arrayBuffer())
    .catch(() => null);
  const c = await t.logged("/broken");
  expect(JSON.stringify(c.logLines)).toContain("the body broke");
});

test("a HEAD request and a client that goes away still get the run logged", async () => {
  const t = await setup();
  await fetch(`${t.site}/slow`, { method: "HEAD" });
  await t.logged("/slow", "HEAD");
  const before = t.completions.length;
  const aborted = new AbortController();
  const r = await fetch(`${t.site}/slow`, { signal: aborted.signal });
  aborted.abort();
  await r.arrayBuffer().catch(() => null);
  for (let i = 0; i < 100 && t.completions.length === before; i++) await Bun.sleep(10);
  expect(t.completions.length).toBe(before + 1);
});

test("a body that never ends: the run is logged when the client goes away, or for a HEAD request", async () => {
  const t = await setup();
  await fetch(`${t.site}/endless`, { method: "HEAD" });
  await t.logged("/endless", "HEAD");
  const aborted = new AbortController();
  const r = await fetch(`${t.site}/endless`, { signal: aborted.signal });
  const reader = r.body!.getReader();
  await reader.read();
  aborted.abort();
  await t.logged("/endless");
});

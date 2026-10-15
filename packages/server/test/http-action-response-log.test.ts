// An HTTP action's run is logged once its response is sent (STUDY-76, DV-323), as Convex's: its duration
// covers the body, its lines end with the response-size warning, and past 100 MiB (Convex since 82e5c50) the
// rest of the body is dropped with one `error:httpAction` line and no size warning. A HEAD request or a client
// that goes away still gets the run logged. A body that fails (STUDY-31 §10) ends the response cleanly with an
// `error:httpAction` line of its error, or fails the run (the 500) when it failed before the head would go. A chunk
// that is not bytes fails the body the same way (STUDY-161 §15); null and undefined are no chunk.
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
  route("/big", () => chunks([60 * MiB, 50 * MiB, MiB, 30 * MiB]));
  route("/broken", () => chunks([5, 5], 20, true));
  route("/broken-now", () => chunks([5], 0, true));
  // Errored with a value that is no Error, after a chunk and a timer.
  route(
    "/broken-string",
    () =>
      new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new Uint8Array(3));
          await Bun.sleep(20);
          c.error("a string");
        },
      }),
  );
  route(
    "/pull-throws",
    () =>
      new ReadableStream<Uint8Array>({
        pull() {
          throw new TypeError("no body");
        },
      }),
  );
  // Its first pull throws after a few awaits, still in the handler's turn.
  route(
    "/pull-throws-awaited",
    () =>
      new ReadableStream<Uint8Array>({
        async pull() {
          for (let i = 0; i < 5; i++) await null;
          throw new TypeError("no body yet");
        },
      }),
  );
  const enc = (t: string) => new TextEncoder().encode(t);
  /** `first`, then each of `values` (after a timer when `late`), then `last`. */
  const chunkRoute = (path: string, late: boolean, ...values: unknown[]) =>
    route(
      path,
      () =>
        new ReadableStream<unknown>({
          async start(c) {
            c.enqueue(enc("first "));
            for (const v of values) {
              if (late) await Bun.sleep(20);
              c.enqueue(v);
            }
            c.enqueue(enc(" last"));
            c.close();
          },
        }) as ReadableStream<Uint8Array>,
    );
  chunkRoute("/chunk-string", false, "a string");
  chunkRoute("/chunk-object", false, { a: 1 });
  chunkRoute("/chunk-late-number", true, 42);
  chunkRoute("/chunk-nothing", false, null, undefined);
  chunkRoute("/chunk-late-nothing", true, null, undefined);
  chunkRoute("/chunk-buffers", false, enc("ab").buffer, new DataView(enc("dv").buffer), new Uint16Array([0x6968]));
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
  const progress: any[] = [];
  functions.functionLog = {
    append: (p: any) => {
      if (p.kind === "Completion") completions.push(p);
      else if (p.kind === "Progress") progress.push(p);
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
  // A HEAD request is logged as GET, as Convex's `RoutableMethod` names it.
  const logged = (path: string) => until(() => completions.find((c) => c.identifier === `GET ${path}`));
  return { site, completions, progress, consoleEvents, logged, until };
}

test("the run is logged once its body is sent: its time covers the body", async () => {
  const t = await setup();
  const r = await fetch(`${t.site}/slow`);
  expect(t.completions).toEqual([]); // the head came; the body is still coming
  expect((await r.arrayBuffer()).byteLength).toBe(30);
  const c = await t.logged("/slow");
  expect(c.executionTime).toBeGreaterThanOrEqual(0.15);
});

test("past 80 % of 100 MiB: the warning in the run's lines", async () => {
  process.env.FUNCTION_LIMIT_WARNING_RATIO = "0.00000001";
  const t = await setup();
  await (await fetch(`${t.site}/small`)).text();
  const c = await t.logged("/small");
  expect(JSON.stringify(c.logLines)).toContain("Large response returned from an HTTP action (actual: 2 bytes");
  expect(t.consoleEvents.map((e) => e.system_code)).toContain("warning:HttpResponseTooLarge");
});

test("past 100 MiB the rest of the body is dropped, with one error line and no size warning", async () => {
  process.env.FUNCTION_LIMIT_WARNING_RATIO = "0.00000001"; // the warning would show for any body
  const t = await setup();
  const r = await fetch(`${t.site}/big`);
  // 60 MiB fit; the 50 MiB chunk would cross the limit, and the 1 MiB and 30 MiB after it that would fit are
  // dropped too.
  expect((await r.arrayBuffer()).byteLength).toBe(60 * MiB);
  const c = await t.logged("/big");
  const lines = JSON.stringify(c.logLines);
  expect(lines.split("HttpResponseTooLarge: HTTP actions support responses up to 100 MiB").length).toBe(2);
  expect(lines).not.toContain("Large response returned from an HTTP action");
  const line = t.consoleEvents.find((e) => e.message.startsWith("HttpResponseTooLarge"))!;
  expect(line).toMatchObject({ log_level: "ERROR", system_code: "error:httpAction" });
});

test("a body that fails after the head: the response ends cleanly; an error line; the run is logged", async () => {
  const t = await setup();
  const r = await fetch(`${t.site}/broken`);
  expect(r.status).toBe(200);
  // What was sent before the error, then a clean end (no reset: `arrayBuffer` resolves).
  expect((await r.arrayBuffer()).byteLength).toBe(10);
  const c = await t.logged("/broken");
  expect([c.success, c.error ?? null]).toEqual([{ status: "200" }, null]);
  const line = t.consoleEvents.find((e) => e.system_code === "error:httpAction")!;
  expect(line).toMatchObject({ log_level: "ERROR" });
  // As Convex's uncaught error: `Uncaught`, its name and message, then the app's frames.
  expect(line.message).toStartWith("Uncaught Error: the body broke\n    at ");
  expect(line.message).toContain("http-action-response-log.test.ts");
  const s = await fetch(`${t.site}/broken-string`);
  expect((await s.arrayBuffer()).byteLength).toBe(3);
  await t.logged("/broken-string");
  expect(t.consoleEvents.filter((e) => e.system_code === "error:httpAction").map((e) => e.message)).toEqual([
    line.message,
    "Uncaught a string\n",
  ]);
});

test("a body that fails before the head would go: the run fails with its error, answered 500", async () => {
  const t = await setup();
  for (const [path, message] of [
    ["/broken-now", "Uncaught Error: the body broke"],
    ["/pull-throws", "Uncaught TypeError: no body"],
    ["/pull-throws-awaited", "Uncaught TypeError: no body yet"],
  ]) {
    const r = await fetch(`${t.site}${path}`);
    expect(r.status).toBe(500);
    expect(((await r.json()) as { code: string }).code).toEndWith(`Server Error: ${message}`);
    const c = await t.logged(path!);
    expect(c.success ?? null).toBeNull();
    expect(c.error).toStartWith(`${message}\n`);
  }
  expect(t.consoleEvents.filter((e) => e.system_code === "error:httpAction")).toEqual([]);
});

test("a chunk that is not bytes: the 500 in the handler's turn; after the head, a clean end and an error line", async () => {
  const t = await setup();
  for (const [path, got] of [
    ["/chunk-string", "string"],
    ["/chunk-object", "unknown"],
  ]) {
    const message = `Uncaught Error: HTTP action response body chunks must be an ArrayBuffer or a view of one, got ${got}`;
    const r = await fetch(`${t.site}${path}`);
    expect(r.status).toBe(500);
    // Raised by the runtime: no frames.
    const { code, trace } = (await r.json()) as { code: string; trace: string };
    expect([code.replace(/^\[Request ID: \w+\] /, ""), trace]).toEqual([`Server Error: ${message}`, message]);
    const c = await t.logged(path!);
    expect([c.success ?? null, c.error]).toEqual([null, `${message}\n`]);
  }
  const r = await fetch(`${t.site}/chunk-late-number`);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("first ");
  const c = await t.logged("/chunk-late-number");
  expect([c.success, c.error ?? null]).toEqual([{ status: "200" }, null]);
  expect(t.consoleEvents.filter((e) => e.system_code === "error:httpAction").map((e) => e.message)).toEqual([
    "Uncaught Error: HTTP action response body chunks must be an ArrayBuffer or a view of one, got Number\n",
  ]);
});

test("null and undefined chunks are skipped; an ArrayBuffer or any view of one is bytes", async () => {
  const t = await setup();
  for (const path of ["/chunk-nothing", "/chunk-late-nothing"]) {
    const r = await fetch(`${t.site}${path}`);
    expect([r.status, await r.text()]).toEqual([200, "first  last"]);
    expect((await t.logged(path)).success).toEqual({ status: "200" });
  }
  const r = await fetch(`${t.site}/chunk-buffers`);
  expect([r.status, await r.text()]).toEqual([200, "first abdvhi last"]);
  await t.logged("/chunk-buffers");
  expect(t.consoleEvents.filter((e) => e.system_code === "error:httpAction")).toEqual([]);
});

test("a HEAD request and a client that goes away still get the run logged", async () => {
  const t = await setup();
  await fetch(`${t.site}/slow`, { method: "HEAD" });
  await t.logged("/slow");
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
  await t.logged("/endless");
  const aborted = new AbortController();
  const r = await fetch(`${t.site}/endless`, { signal: aborted.signal });
  const reader = r.body!.getReader();
  await reader.read();
  aborted.abort();
  await t.logged("/endless");
});

// Convex's test_http_action_disconnect_while_streaming (http_routing.rs): the client leaves after the head
// and a first chunk; the run's last line is `[INFO] Client disconnected`, streamed as its own Progress
// entry, and the run is logged with the head's status, not as an error.
test("a client that leaves mid-body: an INFO Client disconnected line; the run logged with its status", async () => {
  const t = await setup();
  const aborted = new AbortController();
  const r = await fetch(`${t.site}/endless`, { signal: aborted.signal });
  await r.body!.getReader().read();
  aborted.abort();
  const c = await t.logged("/endless");
  const line = { level: "INFO", messages: ["Client disconnected"], systemCode: "info:httpActionClientDisconnect" };
  expect(c.success).toEqual({ status: "200" });
  expect(c.error ?? null).toBeNull();
  expect(c.logLines.at(-1)).toMatchObject(line);
  const p = t.progress.filter((x) => x.identifier === "GET /endless");
  expect(p.length).toBe(1);
  expect(p[0].logLines).toEqual([expect.objectContaining(line)]);
  expect(t.consoleEvents.find((e) => e.message === "Client disconnected")).toMatchObject({
    log_level: "INFO",
    system_code: "info:httpActionClientDisconnect",
  });
});

test("a body read to its end, or a HEAD request: no Client disconnected line", async () => {
  const t = await setup();
  await (await fetch(`${t.site}/slow`)).arrayBuffer();
  await fetch(`${t.site}/endless`, { method: "HEAD" });
  const read = await t.logged("/slow");
  const head = await t.logged("/endless");
  for (const c of [read, head]) expect(JSON.stringify(c.logLines)).not.toContain("Client disconnected");
  expect(t.progress).toEqual([]);
});

// The server's request timeout on every route (STUDY-147 PR 3b), as Convex's `ConvexHttpService`: no response
// head within `HTTP_SERVER_TIMEOUT_SECONDS` answers 408 with no body; reading the request's body counts, a
// streamed response body does not, a WebSocket is not timed.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions } from "../src/functions.ts";
import { REQUEST_TIMEOUT_MS } from "../src/request-timeout.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

const TIMEOUT = 200;

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const events: string[] = [];
  const functions = new Functions(engine).register("m", {
    sleep: action(async (_ctx, { ms }: { ms: number }) => {
      await Bun.sleep(ms);
      events.push("slept");
      return "awake";
    }),
  });
  const http = httpRouter();
  http.route({
    path: "/stream",
    method: "GET",
    handler: httpAction(async () => {
      const body = new ReadableStream({
        async start(c) {
          for (let i = 0; i < 4; i++) {
            c.enqueue(new TextEncoder().encode(`${i}`));
            await Bun.sleep(TIMEOUT / 2);
          }
          c.close();
        },
      });
      return new Response(body);
    }),
  });
  http.route({
    path: "/upload",
    method: "POST",
    handler: httpAction(async (_ctx, req) => new Response(`${(await req.text()).length}`)),
  });
  const server = createServer({ engine, functions, port: 0, http, requestTimeoutMs: TIMEOUT });
  stops.push(server.stop);
  return { api: `http://127.0.0.1:${server.server.port}`, site: server.siteUrl!, events };
}

test("Convex's default: 300 s", () => {
  expect(REQUEST_TIMEOUT_MS).toBe(300_000);
});

test("any route: no response head in time answers 408 with no body, and the handler keeps running", async () => {
  const { api, events } = await setup();
  const call = (ms: number) =>
    fetch(`${api}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:sleep", args: { ms } }),
    });
  const fast = await call(0);
  expect([fast.status, ((await fast.json()) as { value: string }).value]).toEqual([200, "awake"]);
  const t0 = performance.now();
  const slow = await call(TIMEOUT * 2);
  expect([slow.status, await slow.text()]).toEqual([408, ""]);
  expect(performance.now() - t0).toBeLessThan(TIMEOUT * 2);
  for (let i = 0; i < 100 && events.length < 2; i++) await Bun.sleep(10);
  expect(events).toEqual(["slept", "slept"]);
});

test("a body streamed after the head is not timed", async () => {
  const { site } = await setup();
  const t0 = performance.now();
  const r = await fetch(`${site}/stream`);
  expect([r.status, await r.text()]).toEqual([200, "0123"]);
  expect(performance.now() - t0).toBeGreaterThan(TIMEOUT);
});

test("reading the request's body counts: an upload slower than the timeout answers 408", async () => {
  const { site } = await setup();
  const slowBody = (chunks: number) =>
    new ReadableStream({
      async start(c) {
        for (let i = 0; i < chunks; i++) {
          c.enqueue(new TextEncoder().encode("x".repeat(10)));
          await Bun.sleep(TIMEOUT / 4);
        }
        c.close();
      },
    });
  const quick = await fetch(`${site}/upload`, { method: "POST", body: slowBody(2), duplex: "half" } as RequestInit);
  expect([quick.status, await quick.text()]).toEqual([200, "20"]);
  const slow = await fetch(`${site}/upload`, { method: "POST", body: slowBody(12), duplex: "half" } as RequestInit);
  expect([slow.status, await slow.text()]).toEqual([408, ""]);
});

test("a WebSocket is not timed", async () => {
  const { api } = await setup();
  const ws = new WebSocket(`${api.replace("http", "ws")}/api/1.0.0/sync`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let closed = false;
  ws.onclose = () => {
    closed = true;
  };
  await Bun.sleep(TIMEOUT * 2);
  expect([closed, ws.readyState]).toEqual([false, WebSocket.OPEN]);
  ws.close();
});

// The HTTP server's concurrent request limit (STUDY-110), as Convex's `ConvexHttpService`: requests past it wait
// their turn, first come first served, with no error; one limit for the API and the site; a permit is held until
// the response head; WebSocket upgrades and `/version` are exempt; 128 by default, or
// `HTTP_SERVER_MAX_CONCURRENT_REQUESTS`.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { action, Functions, query } from "../src/functions.ts";
import { MAX_CONCURRENT_REQUESTS, RequestLimit, requestLimitFromEnv } from "../src/request-limit.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { add, syncUrl, updated, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

/** A server whose `m:slow` action and `/slow` HTTP action wait for their gate; `started` lists who began. */
async function setup(maxConcurrentRequests: number, httpActionHeadTimeoutMs?: number) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const gate = (tag: string) => new Promise<void>((r) => gates.set(tag, r));
  const functions = new Functions(engine).register("m", {
    slow: action(async (_, { tag }: { tag: string }) => {
      started.push(tag);
      await gate(tag);
      return tag;
    }),
    one: query(() => 1),
  });
  const http = httpRouter();
  http.route({ path: "/fast", method: "GET", handler: httpAction(async () => new Response("fast")) });
  http.route({
    path: "/slow",
    method: "GET",
    handler: httpAction(async (_ctx, req) => {
      const tag = new URL(req.url).searchParams.get("tag")!;
      started.push(tag);
      await gate(tag);
      return new Response(tag);
    }),
  });
  http.route({
    path: "/stream",
    method: "GET",
    handler: httpAction(async () => {
      started.push("stream");
      // The head now; the body only once its gate opens.
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(new TextEncoder().encode("head "));
          await gate("stream");
          c.enqueue(new TextEncoder().encode("tail"));
          c.close();
        },
      });
      return new Response(body);
    }),
  });
  const server = createServer({
    engine,
    functions,
    port: 0,
    http,
    maxConcurrentRequests,
    httpActionHeadTimeoutMs,
    redactLogsToClient: false,
  });
  stops.push(server.stop);
  // Open every gate first (stops run in reverse), so a failed test leaves nothing waiting.
  stops.push(() => {
    for (const open of gates.values()) open();
  });
  const api = `http://127.0.0.1:${server.server.port}`;
  const site = server.siteUrl!;
  const slowAction = (tag: string) =>
    fetch(`${api}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:slow", args: { tag } }),
    }).then(async (r) => ((await r.json()) as { value: string }).value);
  const slowSite = (tag: string) => fetch(`${site}/slow?tag=${tag}`).then((r) => r.text());
  /** Wait until `started` has `n` entries (or fail). */
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (f()) return;
      await Bun.sleep(5);
    }
    throw new Error(`timed out; started: ${started.join(",")}`);
  };
  const open = (tag: string) => gates.get(tag)!();
  return { server, api, site, started, open, until, slowAction, slowSite };
}

test("with a limit of 2, the third slow request starts only after one finishes, with no error", async () => {
  const s = await setup(2);
  const a = s.slowAction("a");
  const b = s.slowAction("b");
  await s.until(() => s.started.length === 2);
  const c = s.slowAction("c");
  await Bun.sleep(100);
  expect(s.started).toEqual(["a", "b"]); // c waits
  s.open("b");
  expect(await b).toBe("b");
  await s.until(() => s.started.length === 3);
  expect(s.started[2]).toBe("c");
  s.open("a");
  s.open("c");
  expect(await Promise.all([a, c])).toEqual(["a", "c"]);
});

test("waiting requests go in arrival order", async () => {
  const s = await setup(1);
  const first = s.slowAction("first");
  await s.until(() => s.started.length === 1);
  const rest: Promise<string>[] = [];
  for (const tag of ["w1", "w2", "w3", "w4"]) {
    rest.push(s.slowAction(tag));
    await Bun.sleep(20); // let each arrive before the next
  }
  s.open("first");
  await first;
  for (const tag of ["w1", "w2", "w3", "w4"]) {
    await s.until(() => s.started.includes(tag));
    s.open(tag);
  }
  expect(await Promise.all(rest)).toEqual(["w1", "w2", "w3", "w4"]);
  expect(s.started).toEqual(["first", "w1", "w2", "w3", "w4"]);
});

test("the time waiting for a permit does not count toward the 300 s head timeout (Convex's is inside the limit)", async () => {
  // A 150 ms head timeout; the request waits 400 ms for its permit, then answers at once.
  const s = await setup(1, 150);
  const a = s.slowAction("busy");
  await s.until(() => s.started.length === 1);
  const fast = fetch(`${s.site}/fast`);
  await Bun.sleep(400);
  s.open("busy");
  await a;
  const r = await fast;
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("fast");
});

test("the API and the site share one limit", async () => {
  const s = await setup(1);
  const a = s.slowAction("api");
  await s.until(() => s.started.length === 1);
  const site = s.slowSite("site");
  await Bun.sleep(100);
  expect(s.started).toEqual(["api"]);
  s.open("api");
  await a;
  await s.until(() => s.started.length === 2);
  s.open("site");
  expect(await site).toBe("site");
});

test("a permit is released at the response head: a streamed body does not hold it", async () => {
  const s = await setup(1);
  const r = await fetch(`${s.site}/stream`);
  expect(r.status).toBe(200);
  // The body is still streaming; another request runs meanwhile.
  const b = s.slowSite("next");
  await s.until(() => s.started.includes("next"));
  s.open("next");
  expect(await b).toBe("next");
  s.open("stream");
  expect(await r.text()).toBe("head tail");
});

test("WebSocket upgrades and /version are exempt", async () => {
  const s = await setup(1);
  const a = s.slowAction("busy");
  await s.until(() => s.started.length === 1);
  // The limit is taken: a sync session still connects and gets its query.
  const c = await v1Client(syncUrl(s.server.server.port));
  c.modify([add(1, "m:one")]);
  const t = await c.transition(0);
  expect(updated(t)[1]).toBe(1);
  c.ws.close();
  expect(await (await fetch(`${s.api}/version`)).text()).toBe("bunvex");
  expect(await (await fetch(`${s.site}/version`)).text()).toBe("bunvex");
  s.open("busy");
  expect(await a).toBe("busy");
});

test("128 by default; HTTP_SERVER_MAX_CONCURRENT_REQUESTS sets it", () => {
  expect(MAX_CONCURRENT_REQUESTS).toBe(128);
  expect(requestLimitFromEnv({}).max).toBe(128);
  expect(requestLimitFromEnv({ HTTP_SERVER_MAX_CONCURRENT_REQUESTS: "3" }).max).toBe(3);
  expect(() => requestLimitFromEnv({ HTTP_SERVER_MAX_CONCURRENT_REQUESTS: "0" })).toThrow(
    "HTTP_SERVER_MAX_CONCURRENT_REQUESTS: not a positive integer: 0",
  );
});

test("RequestLimit: a free permit runs at once, a throw or a rejection releases it", async () => {
  const l = new RequestLimit(1);
  expect(l.run(() => 5)).toBe(5); // synchronous when a permit is free
  expect(() =>
    l.run(() => {
      throw new Error("x");
    }),
  ).toThrow("x");
  await expect(l.run(() => Promise.reject(new Error("y")))).rejects.toThrow("y");
  expect(l.running).toBe(0);
  let release!: () => void;
  const held = l.run(() => new Promise<void>((r) => (release = r)));
  const order: number[] = [];
  const waiters = [1, 2, 3].map((n) => l.run(() => order.push(n)) as Promise<number>);
  expect(l.waiting).toBe(3);
  release();
  await held;
  await Promise.all(waiters);
  expect(order).toEqual([1, 2, 3]);
  expect(l.running).toBe(0);
  expect(l.stats.peak).toBe(1);
});

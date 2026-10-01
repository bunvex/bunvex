// HTTP actions served (STUDY-31 §3.2), over real HTTP on both ways in: `/http/…` on the API port and the
// site port.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { BunvexError, v } from "@bunvex/values";
import { ActionPermits } from "../src/action-permits.ts";
import { Functions, internalMutation, query } from "../src/functions.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup(
  opts: { router?: boolean; permits?: ActionPermits; headTimeoutMs?: number; redact?: boolean; maxBody?: number } = {},
) {
  const issuer = await startIssuer({ cacheControl: "max-age=600" });
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const events: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const functions = new Functions(engine, { actionPermits: opts.permits }).register("m", {
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
    note: internalMutation(async ({ db }, { tag }: { tag: string }) => {
      await db.insert("items", { tag });
    }),
  });
  const http = httpRouter();
  http.route({
    path: "/hello",
    method: "GET",
    handler: httpAction(async (_ctx, req) =>
      Response.json(
        { url: req.url, method: req.method, requestId: req.headers.get("bunvex-request-id") },
        { headers: { "x-app": "1" } },
      ),
    ),
  });
  http.route({
    path: "/echo",
    method: "POST",
    handler: httpAction(async (_ctx, req) => new Response(await req.text())),
  });
  http.route({
    path: "/body",
    method: "GET",
    handler: httpAction(async (_ctx, req) => new Response(`body:${await req.text()}`)),
  });
  http.route({
    path: "/body",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, req) => new Response(`body:${await req.text()}`)),
  });
  http.route({
    pathPrefix: "/files/",
    method: "GET",
    handler: httpAction(async (_ctx, req) => new Response(new URL(req.url).pathname)),
  });
  http.route({
    path: "/stream",
    method: "GET",
    handler: httpAction(async () => {
      let i = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            if (i === 3) return c.close();
            await Bun.sleep(5);
            c.enqueue(new TextEncoder().encode(`chunk${i++};`));
          },
        }),
      );
    }),
  });
  http.route({
    path: "/big",
    method: "GET",
    handler: httpAction(async () => {
      let i = 0;
      const mib = new Uint8Array(1 << 20).fill(97);
      return new Response(
        new ReadableStream({
          pull(c) {
            if (i++ === 21) return c.close();
            c.enqueue(mib);
          },
        }),
      );
    }),
  });
  http.route({
    path: "/throws",
    method: "GET",
    handler: httpAction(async () => {
      throw new BunvexError({ code: "nope" });
    }),
  });
  http.route({ path: "/notResponse", method: "GET", handler: httpAction(async () => "hi" as never) });
  http.route({
    path: "/whoami",
    method: "GET",
    handler: httpAction(async (ctx) => {
      let direct: unknown;
      try {
        direct = (await ctx.auth.getUserIdentity())?.subject ?? null;
      } catch (e) {
        direct = `threw: ${(e as Error).message}`;
      }
      return Response.json({ direct, viaQuery: await ctx.runQuery("m:whoami", {}) });
    }),
  });
  http.route({
    path: "/slow",
    method: "GET",
    handler: httpAction(async () => {
      events.push("slow started");
      await gates.get("slow");
      events.push("slow finished");
      return new Response("late");
    }),
  });
  http.route({
    path: "/cors",
    method: "OPTIONS",
    handler: httpAction(async (_ctx, req) =>
      req.headers.get("origin") !== null
        ? new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST",
              "Access-Control-Max-Age": "86400",
            },
          })
        : new Response(),
    ),
  });
  http.route({
    path: "/schedule",
    method: "POST",
    handler: httpAction(async (ctx) => {
      await ctx.scheduler.runAfter(0, "m:note", { tag: "from http" });
      return new Response("scheduled");
    }),
  });
  http.route({
    path: "/abort",
    method: "GET",
    handler: httpAction(async (_ctx, req) => {
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()));
      events.push("aborted");
      return new Response("gone");
    }),
  });
  const server = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: opts.redact ?? false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
    ...(opts.router === false ? {} : { http }),
    httpActionHeadTimeoutMs: opts.headTimeoutMs,
    maxRequestBodySize: opts.maxBody,
  });
  stops.push(server.stop);
  const api = `http://127.0.0.1:${server.server.port}`;
  const site = server.siteUrl!;
  const gate = (name: string) => {
    let open!: () => void;
    gates.set(name, new Promise((r) => (open = r)));
    return open;
  };
  /** A raw HTTP/1.1 request (for what `fetch` refuses to send: TRACE, a GET with a body). */
  const raw = async (port: number, request: string) => {
    const chunks: Uint8Array[] = [];
    const done = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: { data: (_s, d) => void chunks.push(d), close: () => done.resolve(), error: () => done.resolve() },
    });
    socket.write(request);
    await Promise.race([done.promise, Bun.sleep(500)]);
    socket.end();
    return Buffer.concat(chunks).toString();
  };
  return { engine, events, api, site, server, issuer, gate, raw };
}

describe("both ways in", () => {
  test("/http/… on the API port and every path on the site port; the URL a handler sees", async () => {
    const { api, site } = await setup();
    const a = (await (await fetch(`${api}/http/hello?x=1`)).json()) as Record<string, string>;
    const s = (await (await fetch(`${site}/hello?x=1`)).json()) as Record<string, string>;
    expect(a.url).toBe(`${api}/hello?x=1`);
    expect(s.url).toBe(`${site}/hello?x=1`);
    expect(s.method).toBe("GET");
    expect(s.requestId).toMatch(/^[0-9a-f]{16}$/); // added when the client sent none
    const forwarded = (await (
      await fetch(`${site}/hello`, { headers: { "x-forwarded-proto": "https", "bunvex-request-id": "mine" } })
    ).json()) as Record<string, string>;
    expect(forwarded.url).toBe(`https://${new URL(site).host}/hello`);
    expect(forwarded.requestId).toBe("mine");
    expect(await (await fetch(`${site}/files/a/b.txt`)).text()).toBe("/files/a/b.txt");
    expect(await (await fetch(`${site}/version`)).text()).toBe("bunvex");
  });

  test("unknown routes, methods and no router: Convex's answers", async () => {
    const { site, server, raw } = await setup();
    const r = await fetch(`${site}/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await r.text()).toBe("No matching routes found");
    expect((await fetch(`${site}/api/query`, { method: "POST", body: "{}" })).status).toBe(404); // user space
    expect(await raw(server.site!.port!, "TRACE /hello HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toStartWith(
      "HTTP/1.1 405",
    );
    const none = await setup({ router: false });
    const n = await fetch(`${none.site}/x`);
    expect([n.status, await n.text()]).toEqual([404, "This bunvex deployment does not have HTTP actions enabled."]);
  });
});

describe("requests and responses", () => {
  test("HEAD runs GET without a body; GET's body is dropped; POST's streams in; a response streams out", async () => {
    const { site, server, raw } = await setup();
    const head = await fetch(`${site}/hello`, { method: "HEAD" });
    expect([head.status, head.headers.get("x-app"), await head.text()]).toEqual([200, "1", ""]);
    // Convex drops the body of GET, HEAD and OPTIONS requests (Bun already drops a GET's; an OPTIONS' it passes on).
    for (const m of ["GET", "OPTIONS"]) {
      const res = await raw(
        server.site!.port!,
        `${m} /body HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`,
      );
      expect(res).toContain("body:");
      expect(res).not.toContain("body:hello");
    }
    expect(await (await fetch(`${site}/echo`, { method: "POST", body: "ping".repeat(1000) })).text()).toBe(
      "ping".repeat(1000),
    );
    const chunks: string[] = [];
    const reader = (await fetch(`${site}/stream`)).body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toBe("chunk0;chunk1;chunk2;");
  });

  test("a response is cut once it would pass 20 MiB", async () => {
    const { site } = await setup();
    const body = await (await fetch(`${site}/big`)).arrayBuffer();
    expect(body.byteLength).toBe(20 << 20);
  });

  test("an error before the head: Convex's 500 JSON, with data; redacted without the trace", async () => {
    const { site } = await setup();
    const r = await fetch(`${site}/throws`);
    expect(r.status).toBe(500);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b.code).toMatch(/^\[Request ID: [0-9a-f]{16}\] Server Error: Uncaught BunvexError: /);
    expect(b.trace).toContain("Uncaught BunvexError");
    expect(b.data).toEqual({ code: "nope" });
    expect(((await (await fetch(`${site}/notResponse`)).json()) as Record<string, string>).code).toContain(
      "Server Error: Uncaught Error: HTTP actions must return a Response",
    );
    const quiet = await setup({ redact: true });
    const q = (await (await fetch(`${quiet.site}/throws`)).json()) as Record<string, unknown>;
    expect(q.code).toMatch(/^\[Request ID: [0-9a-f]{16}\] Server Error$/);
    expect(q.trace).toBeUndefined();
    expect(q.data).toEqual({ code: "nope" });
  });

  test("CORS is the app's: its OPTIONS route answers preflights; nothing is added elsewhere", async () => {
    const { site } = await setup();
    const pre = await fetch(`${site}/cors`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      (await fetch(`${site}/hello`, { headers: { origin: "https://app.example" } })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBeNull();
  });

  test("the request's signal aborts when the client goes away; ctx.scheduler works", async () => {
    const { site, events, engine } = await setup();
    const c = new AbortController();
    const p = fetch(`${site}/abort`, { signal: c.signal }).catch(() => "aborted");
    await Bun.sleep(50);
    c.abort();
    await p;
    for (let i = 0; i < 100 && !events.includes("aborted"); i++) await Bun.sleep(10);
    expect(events).toContain("aborted");
    expect(await (await fetch(`${site}/schedule`, { method: "POST" })).text()).toBe("scheduled");
    for (let i = 0; i < 200; i++) {
      if ((await engine.query((db) => db.query("items").collect())).length === 1) break;
      await Bun.sleep(5);
    }
    expect((await engine.query((db) => db.query("items").collect())).map((d) => d.tag)).toEqual(["from http"]);
  });

  test("request bodies above maxRequestBodySize are refused by the server", async () => {
    const { site } = await setup({ maxBody: 1024 });
    expect((await fetch(`${site}/echo`, { method: "POST", body: "x".repeat(4096) })).status).toBe(413);
  });
});

describe("auth, limits, time", () => {
  test("no token: null; a good one: the user, inside ctx.runQuery too; a bad one still runs and getUserIdentity() throws", async () => {
    const { site, issuer } = await setup();
    expect(await (await fetch(`${site}/whoami`)).json()).toEqual({ direct: null, viaQuery: null });
    const good = await issuer.sign({ sub: "ada" });
    expect(await (await fetch(`${site}/whoami`, { headers: { authorization: `Bearer ${good}` } })).json()).toEqual({
      direct: "ada",
      viaQuery: "ada",
    });
    const bad = await issuer.sign({ aud: "other" });
    const r = await fetch(`${site}/whoami`, { headers: { authorization: `Bearer ${bad}` } });
    expect(r.status).toBe(200);
    const b = (await r.json()) as Record<string, string | null>;
    expect(b.direct).toStartWith("threw: No auth provider found");
    expect(b.viaQuery).toBeNull();
  });

  test("past the action limit, a request waits, then gets Convex's 429", async () => {
    const { site, gate } = await setup({ permits: new ActionPermits(1, 50) });
    const open = gate("slow");
    const first = fetch(`${site}/slow`);
    await Bun.sleep(20);
    const second = await fetch(`${site}/hello`);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      code: "TooManyConcurrentRequests",
      message:
        "Too many concurrent requests. Your backend is limited to 1 concurrent actions. To raise the limit, set APPLICATION_MAX_CONCURRENT_V8_ACTIONS.",
    });
    open();
    expect((await first).status).toBe(200);
  });

  test("no response head in time: 408, and the action keeps running", async () => {
    const { site, gate, events } = await setup({ headTimeoutMs: 100 });
    const open = gate("slow");
    const r = await fetch(`${site}/slow`);
    expect([r.status, await r.text()]).toEqual([408, ""]);
    open();
    for (let i = 0; i < 100 && !events.includes("slow finished"); i++) await Bun.sleep(5);
    expect(events).toEqual(["slow started", "slow finished"]);
  });

  test("an invalid router fails the start", async () => {
    const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
    expect(() => createServer({ engine, functions: new Functions(engine), port: 0, http: {} as never })).toThrow(
      "The default export of `bunvex/http.js` is not a Router.",
    );
  });
});

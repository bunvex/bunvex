// HTTP actions over the bridge (STUDY-168 PR 6, STUDY-171 §14): the same pushed code deployed to a server running it
// in `vm` and to one running it in `process`, every case requested on both, and what the client gets compared: the
// status, its text, the headers (with how the body is framed: `content-length` or chunked), the body byte for byte;
// and what the function log gets: the run's name, its status or error, and every line it logged (the console's, the
// warnings', the body's errors), in order.
//
// The cases cover the request (its URL, method, headers, every way to read its body, a multipart body parsed by the
// host, a 3 MiB body streamed), the response (every kind of body, of known length or streamed, small and large, a
// stream that fails before or after its head, chunks that are not bytes, the 100 MiB cap, a client that leaves), what
// the handler reaches (`ctx`'s calls, storage with the request's bytes, `fetch`, the console, `process.env`), a body
// whose chunks still call `ctx` after the handler returned, the unawaited-operations warning (`formData` among them),
// errors and what is not a `Response`, and the routing (exact and prefix routes, HEAD, a path no route matches). Then,
// under `process` only, what `vm` cannot do (DV-528): a rejection nothing handles fails the run (before the head) or
// ends the body (after it), as the same value thrown does; and the call ends with its body, as Convex's isolate does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, Functions } from "@bunvex/server";
import { provideProcessExecutor } from "@bunvex/server/executor";
import { v } from "@bunvex/values";
import { ProcessExecutor } from "../src/executor.ts";
import { TestBlobs } from "./fixtures/blobs.ts";

// No memory cap in the children: the cases past the response's 100 MiB cap hold more than a call's 64 MiB, which fails
// them first under `process`, as on Convex (STUDY-188 §X17b; `memory-cap.test.ts`).
provideProcessExecutor(() => new ProcessExecutor({ memoryCap: false }));
process.env.TZ = "UTC";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const VALUES = JSON.stringify(["bunvex", "values"].join("/"));
const MiB = 1 << 20;

/** HTTP cases: `ctx` is an HTTP action's, `request` the request, `T` the `fetch` target's origin (`process.env.T`). */
const HTTP_CASES = `{
  text: async () => new Response("plain text"),
  textStatus: async () => new Response("made", { status: 201, statusText: "Made It", headers: { "x-mine": "1" } }),
  json: async () => Response.json({ a: [1, 2], b: "x" }),
  jsonStatus: async () => Response.json({ e: 1 }, { status: 422, headers: { "content-type": "application/problem+json" } }),
  empty: async () => new Response(),
  emptyString: async () => new Response(""),
  noContent: async () => new Response(null, { status: 204, headers: { "x-a": "b" } }),
  bytes: async () => new Response(new Uint8Array([1, 2, 3, 250])),
  bytesTyped: async () => new Response(new Uint8Array([104, 105]), { headers: { "content-type": "text/plain" } }),
  buffer: async () => new Response(new Uint8Array([7, 8, 9]).buffer),
  blobTyped: async () => new Response(new Blob(["blob body"], { type: "Text/X-Mine" })),
  blobUntyped: async () => new Response(new Blob(["no type"])),
  params: async () => new Response(new URLSearchParams({ a: "1", b: "two words" })),
  form: async () => { const f = new FormData(); f.append("a", "1"); return new Response(f); },
  number: async () => new Response(42),
  bigText: async () => new Response("x".repeat(MiB + 3)),
  bigBytes: async () => { const b = new Uint8Array(3 * MiB + 5); for (let i = 0; i < b.length; i++) b[i] = (i * 31) & 0xff; return new Response(b); },
  bigBytesTyped: async () => new Response(new Uint8Array(2 * MiB).fill(65), { headers: { "content-type": "text/plain" } }),
  overCapBytes: async () => new Response(new Uint8Array(101 * MiB)),
  overCapTyped: async () => new Response(new Uint8Array(101 * MiB), { headers: { "content-type": "application/octet-stream" } }),
  explicitLength: async () => new Response("abc", { headers: { "content-length": "3" } }),
  noType: async () => { const r = new Response("typed then not"); r.headers.delete("content-type"); return r; },
  cookies: async () => { const h = new Headers(); h.append("set-cookie", "a=1"); h.append("set-cookie", "b=2"); h.append("x-multi", "one"); h.append("x-multi", "two"); return new Response("c", { headers: h }); },
  redirect: async () => Response.redirect("https://example.com/elsewhere", 307),
  stream: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("one,")); c.enqueue(new TextEncoder().encode("two")); c.close(); } })),
  streamTyped: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: 1\\n\\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } }),
  streamBigAtOnce: async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(MiB).fill(i)); c.close(); } })),
  streamEmpty: async () => new Response(new ReadableStream({ start(c) { c.close(); } })),
  streamSlow: async () => { let n = 0; return new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 5)); if (n++ < 5) c.enqueue(new Uint8Array(10).fill(n)); else c.close(); } })); },
  streamBig: async () => { let n = 0; return new Response(new ReadableStream({ pull(c) { if (n++ < 50) c.enqueue(new Uint8Array(100000).fill(n)); else c.close(); } })); },
  streamFailsLate: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); setTimeout(() => c.error(new Error("the body broke")), 20); } })),
  streamFailsNow: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.error(new Error("broke at once")); } })),
  streamFailsString: async () => new Response(new ReadableStream({ async start(c) { c.enqueue(new Uint8Array(3)); await new Promise((r) => setTimeout(r, 20)); c.error("a string"); } })),
  pullThrows: async () => new Response(new ReadableStream({ pull() { throw new TypeError("no body"); } })),
  pullThrowsAwaited: async () => new Response(new ReadableStream({ async pull() { for (let i = 0; i < 5; i++) await null; throw new TypeError("no body yet"); } })),
  chunkString: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("first ")); c.enqueue("a string"); c.close(); } })),
  chunkLateNumber: async () => new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("first ")); await new Promise((r) => setTimeout(r, 20)); c.enqueue(42); c.close(); } })),
  chunkLateObject: async () => new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("first ")); await new Promise((r) => setTimeout(r, 20)); c.enqueue({ a: 1 }); c.close(); } })),
  chunkNothing: async () => new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("a")); c.enqueue(null); await new Promise((r) => setTimeout(r, 5)); c.enqueue(undefined); c.enqueue(new TextEncoder().encode("b")); c.close(); } })),
  chunkBuffers: async () => new Response(new ReadableStream({ start(c) { const e = (t) => new TextEncoder().encode(t); c.enqueue(e("ab").buffer); c.enqueue(new DataView(e("dv").buffer)); c.enqueue(new Uint16Array([0x6968])); c.close(); } })),
  overCap: async () => { let n = 0; const sizes = [60, 50, 1, 30]; return new Response(new ReadableStream({ pull(c) { if (n < sizes.length) c.enqueue(new Uint8Array(sizes[n++] * MiB)); else c.close(); } })); },
  bodyCallsCtx: async (ctx) => { let n = 0; return new Response(new ReadableStream({ async pull(c) { if (n++ < 3) { const x = await ctx.runQuery("cases:q", { n }); console.log("chunk", n, x); c.enqueue(new TextEncoder().encode(String(x) + ";")); } else c.close(); } })); },
  bodyWrites: async (ctx) => new Response(new ReadableStream({ async start(c) { await new Promise((r) => setTimeout(r, 10)); const id = await ctx.runMutation("cases:ins", { k: 77 }); c.enqueue(new TextEncoder().encode(typeof id)); c.close(); } })),
  bodyReadsEnv: async () => new Response(new ReadableStream({ async start(c) { await new Promise((r) => setTimeout(r, 5)); c.enqueue(new TextEncoder().encode(String(process.env.ENV_SET))); c.close(); } })),
  bodyFetches: async () => new Response(new ReadableStream({ async start(c) { const r = await fetch(process.env.T + "/text"); c.enqueue(new TextEncoder().encode(await r.text())); c.close(); } })),
  // the request
  echo: async (ctx, request) => { const h = [...request.headers].filter(([k]) => k.startsWith("x-") || k === "content-type"); return Response.json({ url: request.url, method: request.method, headers: h, hasBody: request.body !== null, id: request.headers.has("bunvex-request-id"), signal: request.signal.aborted, used: request.bodyUsed }); },
  reqText: async (ctx, request) => new Response(await request.text()),
  reqJson: async (ctx, request) => Response.json(await request.json()),
  reqJsonBad: async (ctx, request) => Response.json(await request.json()),
  reqBytes: async (ctx, request) => { const b = new Uint8Array(await request.arrayBuffer()); let sum = 0; for (const x of b) sum = (sum + x) % 1000003; return Response.json([b.length, sum]); },
  reqStream: async (ctx, request) => { let n = 0, chunks = 0; for await (const c of request.body) { n += c.length; chunks++; } return Response.json([n, chunks > 0, request.bodyUsed]); },
  reqBlob: async (ctx, request) => { const b = await request.blob(); return Response.json([b.size, b.type, await b.text()]); },
  reqTwice: async (ctx, request) => { await request.text(); try { await request.text(); return new Response("read twice"); } catch (e) { return Response.json([e.name, e.message]); } },
  reqClone: async (ctx, request) => { const c = request.clone(); return Response.json([await request.text(), await c.text()]); },
  reqUnread: async () => new Response("did not read"),
  formMultipart: async (ctx, request) => { const f = await request.formData(); const out = []; for (const [k, v] of f) out.push([k, typeof v === "string" ? v : [v.name, v.type, v.size, await v.text()]]); return Response.json(out); },
  formUrlencoded: async (ctx, request) => Response.json([...(await request.formData())]),
  formBad: async (ctx, request) => { try { await request.formData(); return new Response("parsed"); } catch (e) { return Response.json([e.name, e.message]); } },
  formUnawaited: async (ctx, request) => { request.formData().catch(() => {}); return new Response("left"); },
  formThenStore: async (ctx, request) => { const f = await request.formData(); const id = await ctx.storage.store(f.get("file")); const b = await ctx.storage.get(id); return Response.json([typeof id, b.size, b.type, await b.text()]); },
  storeBody: async (ctx, request) => { const id = await ctx.storage.store(await request.blob()); const m = await ctx.storage.getMetadata(id); const b = await ctx.storage.get(id); return Response.json([m.size, m.contentType, b.type, (await b.arrayBuffer()).byteLength]); },
  storageServe: async (ctx) => { const id = await ctx.storage.store(new Blob(["served from storage"], { type: "text/plain" })); return new Response(await ctx.storage.get(id)); },
  // what the handler reaches
  runQuery: async (ctx) => Response.json(await ctx.runQuery("cases:q", { n: 4 })),
  runMutation: async (ctx) => Response.json(typeof (await ctx.runMutation("cases:ins", { k: 1 }))),
  runAction: async (ctx) => Response.json(await ctx.runAction("cases:a", {})),
  nestedThrows: async (ctx) => { try { await ctx.runQuery("cases:boom", {}); } catch (e) { return Response.json([e.name, e.message]); } },
  schedule: async (ctx) => { const id = await ctx.scheduler.runAfter(60000, "cases:ins", { k: 2 }); await ctx.scheduler.cancel(id); return new Response(typeof id); },
  auth: async (ctx) => Response.json(await ctx.auth.getUserIdentity()),
  meta: async (ctx) => Response.json([Object.keys(ctx.meta), await ctx.meta.getFunctionMetadata()]),
  ctxKeys: async (ctx) => Response.json([Object.keys(ctx), Object.keys(ctx.storage)]),
  env: async () => Response.json([process.env.ENV_SET, process.env.ENV_UNSET]),
  fetches: async () => { const r = await fetch(process.env.T + "/text"); return new Response(await r.text(), { status: r.status }); },
  logs: async () => { console.log("one", { a: [1, 2] }); console.warn("two"); console.error("three", new Error("logged")); return new Response("logged"); },
  logsMany: async () => { for (let i = 0; i < 300; i++) console.log("line", i); return new Response("many"); },
  unawaited: async (ctx) => { ctx.runQuery("cases:q", { n: 1 }); ctx.scheduler.runAfter(60000, "cases:ins", { k: 1 }); return new Response("left"); },
  unawaitedStore: async (ctx) => { ctx.storage.store(new Blob([new Uint8Array(200000)])); return new Response("left"); },
  // what fails
  throwError: async () => { throw new Error("mine"); },
  throwTypeError: async () => { null.x; },
  throwBunvex: async () => { throw new BunvexError({ code: 7 }); },
  throwString: async () => { throw "a string"; },
  notResponseObject: async () => ({ status: 200 }),
  notResponseUndefined: async () => undefined,
  notResponseString: async () => "a string",
  responseLike: async () => ({ status: 200, headers: new Headers(), body: null, ok: true }),
}`;

const HTTP_MODULE = `
import { httpRouter, httpActionGeneric as httpAction } from ${SERVER};
import { BunvexError } from ${VALUES};
const MiB = ${MiB};
const hcases = ${HTTP_CASES};
const http = httpRouter();
const run = httpAction(async (ctx, request) => hcases[new URL(request.url).pathname.slice(3)](ctx, request));
for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) http.route({ pathPrefix: "/c/", method, handler: run });
http.route({ path: "/exact", method: "GET", handler: httpAction(async (ctx, request) => new Response("exact " + request.method)) });
http.route({ path: "/exact", method: "POST", handler: httpAction(async (ctx, request) => new Response("posted " + (await request.text()))) });
http.route({ pathPrefix: "/p/", method: "GET", handler: httpAction(async (ctx, request) => new Response("prefix " + new URL(request.url).pathname)) });
http.route({ pathPrefix: "/p/longer/", method: "GET", handler: httpAction(async () => new Response("the longer prefix")) });
// A body that never ends: its first chunk at once, then nothing for 10 s. Cancelled when its client leaves; its
// request's signal aborts then.
let cancelled = "not cancelled";
let aborted = "not aborted";
http.route({ path: "/endless", method: "GET", handler: httpAction(async (ctx, request) => { request.signal.addEventListener("abort", () => { aborted = "aborted: " + request.signal.reason?.name; }); let n = 0; return new Response(new ReadableStream({ async pull(c) { if (n++ > 0) await new Promise((r) => setTimeout(r, 10000)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = "cancelled"; } })); }) });
http.route({ path: "/cancelled", method: "GET", handler: httpAction(async () => new Response(cancelled + ", " + aborted)) });
http.route({ path: "/fetchPassThrough", method: "GET", handler: httpAction(async () => fetch(process.env.T + "/text")) });
export default http;
`;

const CASES_MODULE = `
import { action, query, mutation } from ${SERVER};
import { v } from ${VALUES};
export const q = query({ args: { n: v.number() }, handler: async (ctx, { n }) => n * 2 });
export const ins = mutation({ args: { k: v.number() }, handler: async (ctx, { k }) => ctx.db.insert("items", { k }) });
export const items = query(async (ctx) => (await ctx.db.query("items").collect()).map((d) => d.k));
export const boom = query(async () => { throw new Error("callee failed"); });
export const a = action(async () => "from an action");
`;

/** What a case requests: its method, headers and body (GET with none by default). */
const big = () => {
  const b = new Uint8Array(3 * MiB + 11);
  for (let i = 0; i < b.length; i++) b[i] = (i * 13 + 5) & 0xff;
  return b;
};
const multipart = () => {
  const f = new FormData();
  f.append("a", "1");
  f.append("file", new Blob(["file body"], { type: "text/plain" }), "f.txt");
  f.append("big", new Blob([new Uint8Array(100000).fill(66)]), "big.bin");
  return f;
};
const REQUESTS: Record<string, () => RequestInit> = {
  echo: () => ({ method: "POST", headers: { "x-a": "1", "X-B": "two", "content-type": "text/plain" }, body: "x" }),
  reqText: () => ({ method: "POST", body: "hello body" }),
  reqJson: () => ({ method: "PUT", headers: { "content-type": "application/json" }, body: '{"a":[1,2]}' }),
  reqJsonBad: () => ({ method: "POST", body: "{not json" }),
  reqBytes: () => ({ method: "POST", body: big() }),
  reqStream: () => ({ method: "POST", body: big() }),
  reqBlob: () => ({ method: "POST", headers: { "content-type": "Text/Plain;Charset=UTF-8" }, body: "a blob" }),
  reqTwice: () => ({ method: "POST", body: "once" }),
  reqClone: () => ({ method: "POST", body: "cloned" }),
  reqUnread: () => ({ method: "POST", body: big() }),
  formMultipart: () => ({ method: "POST", body: multipart() }),
  formUrlencoded: () => ({ method: "POST", body: new URLSearchParams({ a: "1", b: "two words" }) }),
  formBad: () => ({
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=nope" },
    body: "not a form",
  }),
  // The body's last bytes come after the handler returned, so `formData()` is still pending then on both executors
  // (with the whole body sent at once, the process child could parse it before the check, and log no warning).
  formUnawaited: () => {
    const sent = new Response(multipart());
    const type = sent.headers.get("content-type")!;
    const body = sent.arrayBuffer().then((b) => new Uint8Array(b));
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const bytes = await body;
        c.enqueue(bytes.subarray(0, bytes.length - 8));
        await Bun.sleep(200);
        c.enqueue(bytes.subarray(bytes.length - 8));
        c.close();
      },
    });
    return { method: "POST", headers: { "content-type": type }, body: stream, duplex: "half" } as RequestInit;
  },
  formThenStore: () => ({ method: "POST", body: multipart() }),
  storeBody: () => ({ method: "POST", headers: { "content-type": "image/png" }, body: big() }),
};

type Seen = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: unknown;
  log: unknown;
};

/** Ids, times, ports and request ids, which differ between any two runs. */
const own = (t: string) =>
  t
    .replace(/\b[0-9a-z]{31,37}\b/g, "<id>")
    .replace(/\b1\d{12}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b[0-9a-f]{16}\b/g, "<request>")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/: \d+(?:\.\d+)?ms\b/g, ": <n>ms")
    .replace(/boundary=[-\w]+/g, "boundary=<b>")
    .replace(/-{2,}[-\w]*FormBoundary[-\w]*/gi, "--<b>")
    .replace(/------[0-9a-z]{10,}/gi, "--<b>");

async function deployment(sandbox: "vm" | "process") {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({
    engine,
    functions,
    port: 0,
    deployable: true,
    functionSandbox: sandbox,
    functionSandboxIsolation: "none",
    fileStorage: new TestBlobs(),
  });
  await s.codeReady;
  await s.deployCode([
    { path: "cases.js", source: CASES_MODULE, environment: "isolate" },
    { path: "http.js", source: HTTP_MODULE, environment: "isolate" },
  ]);
  await engine.mutation(async (db) =>
    engine.environment.update(
      db,
      [
        { name: "ENV_SET", value: "yes" },
        { name: "T", value: T },
      ],
      Object.keys(functions.builtinEnv),
    ),
  );
  // The function log, one request at a time: each run's lines (its Progress events, then its Completion's), its name
  // and its outcome.
  let lines: unknown[] = [];
  const runs: unknown[] = [];
  functions.functionLog = {
    append: (p: { kind: string; udfType?: string; identifier?: string } & Record<string, unknown>) => {
      if (p.udfType !== "HttpAction") return;
      for (const l of (p.logLines as { level: string; messages: string[]; systemCode?: string }[]) ?? [])
        lines.push([l.level, l.messages.map(own), l.systemCode ?? null]);
      if (p.kind !== "Completion") return;
      runs.push({ identifier: p.identifier, success: p.success, error: p.error && own(String(p.error)), lines });
      lines = [];
    },
  } as never;
  const site = () => `http://127.0.0.1:${s.site!.port}`;
  /** The next run logged. */
  const logged = async () => {
    for (let i = 0; i < 2000 && runs.length === 0; i++) await Bun.sleep(5);
    return runs.shift() ?? "not logged";
  };
  return { s, engine, functions, site, logged };
}

/** A body as compared: its text if short and readable, else its length and a checksum. */
function bodyOf(bytes: Uint8Array): unknown {
  let sum = 0;
  for (const x of bytes) sum = (sum * 31 + x) % 1000003;
  if (bytes.length > 4096) return { length: bytes.length, sum };
  return own(new TextDecoder().decode(bytes));
}

async function request(d: Awaited<ReturnType<typeof deployment>>, path: string, init: RequestInit = {}): Promise<Seen> {
  const r = await fetch(`${d.site()}${path}`, { ...init, redirect: "manual" });
  const bytes = new Uint8Array(await r.arrayBuffer());
  const headers = [...r.headers]
    .filter(([k]) => k !== "date")
    .map(
      ([k, value]) => [k, k === "content-length" && Number(value) > 4096 ? "<big>" : own(value)] as [string, string],
    );
  return { status: r.status, statusText: r.statusText, headers, body: bodyOf(bytes), log: await d.logged() };
}

let vm: Awaited<ReturnType<typeof deployment>>;
let proc: Awaited<ReturnType<typeof deployment>>;
let target: ReturnType<typeof Bun.serve>;
let T: string;
beforeAll(async () => {
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) =>
      new URL(req.url).pathname === "/text"
        ? new Response("from the target", { headers: { "x-target": "yes" } })
        : new Response("no", { status: 404 }),
  });
  T = `http://127.0.0.1:${target.port}`;
  [vm, proc] = await Promise.all([deployment("vm"), deployment("process")]);
});
afterAll(async () => {
  await vm?.s.shutdown();
  await proc?.s.shutdown();
  target?.stop(true);
});

const NAMES = [...HTTP_CASES.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]!);

describe("an HTTP action's response and log are the same in vm and in process", () => {
  for (const c of NAMES)
    test(c, async () => {
      const init = REQUESTS[c]?.() ?? {};
      // One at a time: the cases that write read the same table.
      const x = await request(vm, `/c/${c}`, init);
      const y = await request(proc, `/c/${c}`, REQUESTS[c]?.() ?? {});
      expect(y).toEqual(x);
    }, 60_000);
});

test("a fetch's response returned as it came: both executors send it as Convex does (STUDY-142 §8)", async () => {
  const y = await request(proc, "/fetchPassThrough");
  expect([y.status, y.body]).toEqual([200, "from the target"]);
  expect(y.headers).toContainEqual(["x-target", "yes"]);
  const x = await request(vm, "/fetchPassThrough");
  expect([x.status, x.body]).toEqual([200, "from the target"]);
  expect(x.headers).toContainEqual(["x-target", "yes"]);
});

describe("routing, methods and HEAD", () => {
  const cases: [string, RequestInit][] = [
    ["/exact", {}],
    ["/exact", { method: "POST", body: "a body" }],
    ["/exact", { method: "HEAD" }],
    ["/exact", { method: "PUT" }],
    ["/p/x/y?q=1", {}],
    ["/p/longer/z", {}],
    ["/c/text", { method: "HEAD" }],
    ["/c/bigBytes", { method: "HEAD" }],
    ["/c/stream", { method: "HEAD" }],
    ["/c/bytes", { method: "HEAD" }],
    ["/c/text", { method: "OPTIONS" }],
    ["/nowhere", {}],
  ];
  for (const [path, init] of cases)
    test(`${init.method ?? "GET"} ${path}`, async () => {
      const x = await request(vm, path, init);
      const y = await request(proc, path, init);
      expect(y).toEqual(x);
    }, 30_000);
});

test("the writes the cases made are the same", async () => {
  const items = async (d: typeof vm) =>
    (
      (await (
        await fetch(`http://127.0.0.1:${d.s.server.port}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "cases:items", args: {} }),
        })
      ).json()) as { value: unknown }
    ).value;
  expect(await items(proc)).toEqual(await items(vm));
});

describe("a client that leaves", () => {
  // A body that never ends; the client reads a little and goes.
  test("mid-body: the run is logged as in vm, and the body's stream is cancelled", async () => {
    const seen = async (d: typeof vm) => {
      const ac = new AbortController();
      const r = await fetch(`${d.site()}/endless`, { signal: ac.signal });
      const reader = r.body!.getReader();
      await reader.read();
      ac.abort();
      const log = await d.logged();
      // The app's stream was cancelled at once (its `cancel` ran, though a pull was waiting) and its request's signal
      // aborted: it says so to the next request.
      await Bun.sleep(100);
      const after = await request(d, "/cancelled");
      return [log, after];
    };
    expect(await seen(proc)).toEqual(await seen(vm));
  }, 30_000);
});

describe("under process only: what vm cannot do (DV-528) and the end of the call", () => {
  test("a rejection nothing handles before the head fails the run, as the same value thrown", async () => {
    await proc.s.deployCode([
      { path: "cases.js", source: CASES_MODULE, environment: "isolate" },
      { path: "http.js", source: REJECTIONS_MODULE, environment: "isolate" },
    ]);
    const y = await request(proc, "/rejected");
    const thrown = await request(proc, "/thrown");
    expect(y.status).toBe(500);
    expect(norm(y)).toEqual(norm({ ...thrown, log: { ...(thrown.log as object), identifier: "GET /rejected" } }));
  }, 30_000);

  test("after the head, it ends the body there with its error, as Convex's termination error", async () => {
    const y = await request(proc, "/rejectedInBody");
    expect(y.status).toBe(200);
    expect(y.body).toBe("before;");
    const log = y.log as { lines: [string, string[], string | null][]; done: unknown };
    // (Its lines come as Progress events and again in its Completion.)
    const lines = [...new Set(log.lines.map((l) => JSON.stringify([l[0], l[1][0]!.split("\n")[0], l[2]])))];
    expect(lines.map((l) => JSON.parse(l))).toEqual([["ERROR", "Uncaught Error: in the body", "error:httpAction"]]);
    // The rest of its code does not run: the call ended with the body.
    expect((log as unknown as { success: unknown }).success).toEqual({ status: "200" });
  }, 30_000);

  test("the call ends with its body: a timer it left never fires, a ctx it kept refuses (Convex's isolate ends)", async () => {
    const y = await request(proc, "/leftTimer");
    expect(y.body).toBe("answered");
    await Bun.sleep(300);
    const late = await request(proc, "/lateResult");
    expect(late.body).toBe(JSON.stringify([null, "refused", "the action has ended: its operations can no longer run"]));
  }, 30_000);

  test("under vm the call ends with its body too: the timer never fires, the kept ctx refuses (STUDY-77 §8)", async () => {
    await vm.s.deployCode([
      { path: "cases.js", source: CASES_MODULE, environment: "isolate" },
      { path: "http.js", source: REJECTIONS_MODULE, environment: "isolate" },
    ]);
    await request(vm, "/leftTimer");
    await Bun.sleep(300);
    const late = await request(vm, "/lateResult");
    expect(late.body).toBe(JSON.stringify([null, "refused", "the action has ended: its operations can no longer run"]));
  }, 30_000);
});

/** A response as compared across its two runs: the request ids differ. */
const norm = (s: Seen) => JSON.parse(JSON.stringify(s).replace(/\[Request ID: [0-9a-f]+\]/g, "[Request ID]"));

const REJECTIONS_MODULE = `
import { httpRouter, httpActionGeneric as httpAction } from ${SERVER};
const http = httpRouter();
const fail = (mode, value) => (mode === "reject" ? void Promise.reject(value) : (() => { throw value; })());
const failing = (mode) => httpAction(async () => { fail(mode, new Error("never handled")); return new Response("ok"); });
http.route({ path: "/rejected", method: "GET", handler: failing("reject") });
http.route({ path: "/thrown", method: "GET", handler: failing("throw") });
http.route({ path: "/rejectedInBody", method: "GET", handler: httpAction(async () => new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("before;")); await new Promise((r) => setTimeout(r, 20)); Promise.reject(new Error("in the body")); await new Promise((r) => setTimeout(r, 50)); c.enqueue(new TextEncoder().encode("after")); c.close(); } }))) });
let late = null;
let kept = null;
http.route({ path: "/leftTimer", method: "GET", handler: httpAction(async (ctx) => { kept = ctx; setTimeout(async () => { try { await ctx.runQuery("cases:q", { n: 1 }); late = ["ran"]; } catch (e) { late = ["refused", e.message]; } }, 100); return new Response("answered"); }) });
http.route({ path: "/lateResult", method: "GET", handler: httpAction(async () => { try { return new Response(JSON.stringify([late, "ran", await kept.runQuery("cases:q", { n: 1 })])); } catch (e) { return new Response(JSON.stringify([late, "refused", e.message])); } }) });
export default http;
`;

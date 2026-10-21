// An action's `fetch` reaches what Convex's runtime lets it reach (STUDY-80): `http:` and `https:` only, as
// Convex's `Request` (`udf-runtime/src/23_request.ts`), without Bun's own options (`unix`, `proxy`, `tls`,
// `s3`); a `"use node"` action as Node's `fetch`. The messages are those of Convex's local backend (run as
// an oracle, STUDY-80 §1.4) and of Node 24.
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { fetchFailure, isolateFetch, requestFailure } from "../src/action-fetch.ts";
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions, NODE_FUNCTIONS, query } from "../src/functions.ts";
import { screenFailure } from "../src/http-proxy.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** What a `fetch` gave: the status and body, or the error's type, message and cause. */
async function attempt(f: () => Promise<Response>) {
  try {
    const r = await f();
    return { status: r.status, body: await r.text() };
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return { error: err.constructor.name, message: err.message, ...(err.cause ? { cause: err.cause.message } : {}) };
  }
}

async function setup() {
  const tcp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("tcp") });
  const sock = join(tmpdir(), `bunvex-action-fetch-${process.pid}-${Date.now()}.sock`);
  const unix = Bun.serve({ unix: sock, fetch: () => new Response("unix socket") });
  stops.push(
    () => tcp.stop(true),
    () => unix.stop(true),
    () => rmSync(sock, { force: true }),
  );
  const url = `http://127.0.0.1:${tcp.port}/x`;
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const fetchAll = async (urls: string[]) => {
    const out: Record<string, unknown> = {};
    for (const u of urls) out[u] = await attempt(() => fetch(u));
    return out;
  };
  const nodeAll = action(async (_ctx, { urls }: { urls: string[] }) => fetchAll(urls));
  NODE_FUNCTIONS.add(nodeAll);
  const functions = new Functions(engine).register("m", {
    all: action(async (_ctx, { urls }: { urls: string[] }) => fetchAll(urls)),
    request: action(async () => attempt(() => fetch(new Request("file:///etc/hosts")))),
    bunOptions: action(async () => ({
      unix: await attempt(() => fetch(url, { unix: sock } as RequestInit)),
      proxy: await attempt(() => fetch(url, { proxy: "http://127.0.0.1:1" } as RequestInit)),
      tls: await attempt(() => fetch(url, { tls: { rejectUnauthorized: false } } as RequestInit)),
    })),
    nodeAll,
    inQuery: query(async () => {
      try {
        await fetch("file:///etc/hosts");
        return "fetched";
      } catch (e) {
        return (e as Error).message;
      }
    }),
  });
  // Served deployments always have a function log: it is what tells an action's fetch from the host's.
  functions.functionLog = { append: () => {} } as unknown as FunctionLog;
  return { functions, url, sock, engine };
}

const UNSUPPORTED = (scheme: string) => ({
  error: "TypeError",
  message: `Unsupported URL scheme -- http and https are supported (scheme was ${scheme})`,
});

test("an action's fetch takes http and https only, with Convex's TypeError for any other scheme", async () => {
  const { functions, url } = await setup();
  const urls = ["file:///etc/hosts", "data:text/plain,hi", "s3://bucket/key", "blob:abc", "ftp://example.com/x", url];
  expect(await functions.runAction("m:all", { urls })).toEqual({
    "file:///etc/hosts": UNSUPPORTED("file"),
    "data:text/plain,hi": UNSUPPORTED("data"),
    "s3://bucket/key": UNSUPPORTED("s3"),
    "blob:abc": UNSUPPORTED("blob"),
    "ftp://example.com/x": UNSUPPORTED("ftp"),
    [url]: { status: 200, body: "tcp" },
  });
  // A Request naming another scheme is refused the same way.
  expect(await functions.runAction("m:request", {})).toEqual(UNSUPPORTED("file"));
});

test("an action's fetch ignores Bun's own options, as Convex ignores what RequestInit lacks", async () => {
  const { functions } = await setup();
  // `unix` would have reached the Unix socket, `proxy` a closed port: the request goes to the URL instead.
  expect(await functions.runAction("m:bunOptions", {})).toEqual({
    unix: { status: 200, body: "tcp" },
    proxy: { status: 200, body: "tcp" },
    tls: { status: 200, body: "tcp" },
  });
});

test("a \"use node\" action's fetch takes what Node's does: data: too, and fails as Node on the rest", async () => {
  const { functions, url } = await setup();
  const urls = ["file:///etc/hosts", "s3://bucket/key", "data:text/plain,hi", url];
  expect(await functions.runAction("m:nodeAll", { urls })).toEqual({
    "file:///etc/hosts": { error: "TypeError", message: "fetch failed", cause: "not implemented... yet..." },
    "s3://bucket/key": { error: "TypeError", message: "fetch failed", cause: "unknown scheme" },
    "data:text/plain,hi": { status: 200, body: "hi" },
    [url]: { status: 200, body: "tcp" },
  });
});

test("an HTTP action's fetch is an action's", async () => {
  const { url, engine } = await setup();
  const http = httpRouter();
  http.route({
    path: "/f",
    method: "GET",
    handler: httpAction(async (_ctx, req) => {
      const r = await attempt(() => fetch(new URL(req.url).searchParams.get("u")!));
      return Response.json(r);
    }),
  });
  const app = createServer({ engine, functions: new Functions(engine), port: 0, sitePort: null, http });
  stops.push(() => app.stop());
  const get = async (u: string) =>
    (await fetch(`http://127.0.0.1:${app.server.port}/http/f?u=${encodeURIComponent(u)}`)).json();
  expect(await get("file:///etc/hosts")).toEqual(UNSUPPORTED("file"));
  expect(await get(url)).toEqual({ status: 200, body: "tcp" });
});

test("an HTTP action may return its fetch's response as it came (a proxy), its body read once by the server", async () => {
  const target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname === "/text")
        return new Response("from the target", { headers: { "x-target": "yes" } });
      let n = 0;
      return new Response(
        new ReadableStream({
          async pull(c) {
            await Bun.sleep(5);
            if (n++ === 2) return c.close();
            c.enqueue(new TextEncoder().encode(`${n};`));
          },
        }),
      );
    },
  });
  stops.push(() => target.stop(true));
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const http = httpRouter();
  http.route({
    path: "/proxy",
    method: "GET",
    handler: httpAction(async (_ctx, req) => fetch(new URL(req.url).searchParams.get("u")!)),
  });
  // `body` is one stream, however often it is read, as a native response's.
  http.route({
    path: "/same",
    method: "GET",
    handler: httpAction(async (_ctx, req) => {
      const r = await fetch(new URL(req.url).searchParams.get("u")!);
      const body = r.body;
      const same = body === r.body;
      const reader = r.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      return Response.json({ same, first, locked: r.body!.locked, used: r.bodyUsed });
    }),
  });
  const app = createServer({ engine, functions: new Functions(engine), port: 0, sitePort: null, http });
  stops.push(() => app.stop());
  const get = (path: string, u: string) =>
    fetch(
      `http://127.0.0.1:${app.server.port}/http${path}?u=${encodeURIComponent(`http://127.0.0.1:${target.port}${u}`)}`,
    );
  const text = await get("/proxy", "/text");
  expect([text.status, text.headers.get("x-target"), await text.text()]).toEqual([200, "yes", "from the target"]);
  const stream = await get("/proxy", "/stream");
  expect([stream.status, await stream.text()]).toEqual([200, "1;2;"]);
  expect(await (await get("/same", "/text")).json()).toEqual({
    same: true,
    first: "from the target",
    locked: true,
    used: true,
  });
});

// STUDY-142: how a request fails, the default User-Agent and redirects, as Convex's runtime (the same cases
// against Convex's backend: packages/differential/test/action-fetch.test.ts).

/** Local targets for the failure and redirect cases, and an action that reports what `fetch` gave. */
async function failures() {
  const t = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const q = u.searchParams;
      if (u.pathname === "/echo")
        return Response.json({
          method: req.method,
          body: await req.text(),
          ua: req.headers.get("user-agent"),
          auth: req.headers.get("authorization"),
          type: req.headers.get("content-type"),
          referrer: req.headers.get("referrer-policy"),
        });
      if (u.pathname === "/redirect")
        return new Response(null, {
          status: Number(q.get("status") ?? 302),
          headers: { location: q.get("to")!, ...(q.get("policy") ? { "referrer-policy": q.get("policy")! } : {}) },
        });
      if (u.pathname === "/chain") {
        const n = Number(q.get("n"));
        return n === 0 ? new Response("end") : Response.redirect(`/chain?n=${n - 1}`, 302);
      }
      if (u.pathname === "/slow") return Bun.sleep(300).then(() => new Response("late"));
      return new Response("not found", { status: 404 });
    },
  });
  const empty = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: (s) => void s.end() } });
  const truncated = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s) {
        s.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nabc");
        setTimeout(() => s.end(), 20);
      },
    },
  });
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const closedPort = closed.port;
  closed.stop(true);
  stops.push(
    () => t.stop(true),
    () => empty.stop(true),
    () => truncated.stop(true),
  );
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const report = async (url: string, init?: RequestInit & { streamBody?: string; abortAfter?: number }) => {
    const { streamBody, abortAfter, ...rest } = init ?? {};
    if (streamBody !== undefined) rest.body = new Blob([streamBody]).stream();
    if (abortAfter !== undefined) rest.signal = AbortSignal.timeout(abortAfter);
    try {
      const r = await fetch(url, rest);
      try {
        return { status: r.status, body: await r.text(), url: r.url, redirected: r.redirected };
      } catch (e) {
        return {
          body: true,
          error: (e as Error).constructor.name,
          name: (e as Error).name,
          message: (e as Error).message,
        };
      }
    } catch (e) {
      return { error: (e as Error).constructor.name, name: (e as Error).name, message: (e as Error).message };
    }
  };
  const functions = new Functions(engine).register("f", {
    get: action(async (_ctx, { url, init }: { url: string; init?: RequestInit }) => report(url, init)),
    json: action(async (_ctx, { url }: { url: string }) => {
      try {
        return await (await fetch(url)).json();
      } catch (e) {
        return (e as Error).constructor.name;
      }
    }),
    stream: action(async (_ctx, { url }: { url: string }) => {
      const reader = (await fetch(url)).body!.getReader();
      try {
        while (!(await reader.read()).done);
        return "done";
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    }),
  });
  functions.functionLog = { append: () => {} } as unknown as FunctionLog;
  const get = (url: string, init?: Record<string, unknown>) =>
    functions.runAction("f:get", init ? { url, init } : { url }) as Promise<Record<string, unknown>>;
  const json = (url: string) => functions.runAction("f:json", { url });
  const stream = (url: string) => functions.runAction("f:stream", { url });
  return {
    base: `http://127.0.0.1:${t.port}`,
    closedPort,
    emptyPort: empty.port,
    truncatedPort: truncated.port,
    get,
    json,
    stream,
  };
}

const DARWIN = process.platform === "darwin";

test("a failed request is reqwest's cause, the query string, fragment and credentials dropped", async () => {
  const { base, closedPort, emptyPort, truncatedPort, get, json, stream } = await failures();
  // Not the network's: a body that is no JSON is the parser's error, as in Convex.
  expect(await json(`${base}/missing`)).toBe("SyntaxError");
  expect(await json(`${base}/echo`)).toMatchObject({ method: "GET" });
  const refused = `tcp connect error: Connection refused (os error ${DARWIN ? 61 : 111})`;
  expect(await get(`http://user:pw@127.0.0.1:${closedPort}/p/a?token=secret#frag`)).toEqual({
    error: "TypeError",
    name: "TypeError",
    message: `error sending request for url (http://127.0.0.1:${closedPort}/p/a): client error (Connect): ${refused}`,
  });
  expect(await get(`http://127.0.0.1:${emptyPort}/x?token=s`)).toMatchObject({
    message: `error sending request for url (http://127.0.0.1:${emptyPort}/x): client error (SendRequest): connection closed before message completed`,
  });
  // A body that stops short: the cause does not name the URL, so it is prefixed.
  expect(await get(`http://127.0.0.1:${truncatedPort}/x?token=s`)).toEqual({
    body: true,
    error: "TypeError",
    name: "TypeError",
    message: `fetch to http://127.0.0.1:${truncatedPort}/x failed: error decoding response body`,
  });
  // Read from the body's stream, the same failure.
  expect(await stream(`http://127.0.0.1:${truncatedPort}/x`)).toBe(
    `TypeError: fetch to http://127.0.0.1:${truncatedPort}/x failed: error decoding response body`,
  );
});

test("Convex's causes by code: the system's words for sockets and names, Bun's for the rest", () => {
  const url = "http://h/p?q=1";
  const head = "error sending request for url (http://h/p?q=1): client error";
  const err = (code: string, message = "m") => Object.assign(new TypeError(message), { code });
  expect(requestFailure(err("ConnectionRefused"), url)).toBe(
    `${head} (Connect): tcp connect error: Connection refused (os error ${DARWIN ? 61 : 111})`,
  );
  expect(requestFailure(screenFailure("ECONNREFUSED"), url)).toBe(requestFailure(err("ConnectionRefused"), url));
  expect(requestFailure(screenFailure("EHOSTUNREACH"), url)).toBe(
    `${head} (Connect): tcp connect error: No route to host (os error ${DARWIN ? 65 : 113})`,
  );
  expect(requestFailure(err("ENOTFOUND"), url)).toBe(
    `${head} (Connect): dns error: failed to lookup address information: ${DARWIN ? "nodename nor servname provided, or not known" : "Name or service not known"}`,
  );
  expect(requestFailure(err("ECONNRESET"), url)).toBe(
    `${head} (SendRequest): connection closed before message completed`,
  );
  expect(requestFailure(err("CERT_HAS_EXPIRED", "certificate has expired"), url)).toBe(
    `${head} (Connect): certificate has expired`,
  );
  // Bun's pointer to `verbose`, and the URL it names, are dropped.
  expect(
    requestFailure(
      err(
        "Malformed_HTTP_Response",
        'Malformed_HTTP_Response fetching "http://h/p?q=1". For more information, pass `verbose: true` in the second argument to fetch()',
      ),
      url,
    ),
  ).toBe("error sending request for url (http://h/p?q=1): Malformed_HTTP_Response");
  expect(fetchFailure("http://u:p@h/p?q=1#f", requestFailure(new Error("x"), "http://h/p?q=1#f")).message).toBe(
    "error sending request for url (http://h/p): x",
  );
  expect(fetchFailure("http://h/p?q=1", "no url here").message).toBe("fetch to http://h/p failed: no url here");
});

test("the default User-Agent is Bunvex/1.0 (Convex's Convex/1.0, DV-456); the app's own wins; Bun's options are dropped", async () => {
  const { base, get } = await failures();
  const ua = async (init?: Record<string, unknown>) => JSON.parse((await get(`${base}/echo`, init)).body as string).ua;
  expect(await ua()).toBe("Bunvex/1.0");
  expect(await ua({ headers: { "User-Agent": "mine/2" } })).toBe("mine/2");
  // `timeout` (Bun's idle timeout) and `maxRedirects` are not the web's: ignored, as Convex ignores them.
  expect(await get(`${base}/slow`, { timeout: 1 })).toMatchObject({ status: 200, body: "late" });
  expect(await get(`${base}/chain?n=3`, { maxRedirects: 0 })).toMatchObject({ status: 200, body: "end" });
});

test("redirects follow Convex's loop: 20 at most, its errors, the method, body and headers it keeps", async () => {
  const { base, get } = await failures();
  expect(await get(`${base}/chain?n=19`)).toEqual({
    status: 200,
    body: "end",
    url: `${base}/chain?n=0`,
    redirected: true,
  });
  expect(await get(`${base}/chain?n=20`)).toMatchObject({ error: "TypeError", message: "fetch too many redirects" });
  expect(await get(`${base}/chain?n=1`, { redirect: "error" })).toMatchObject({ message: "fetch attempted redirect" });
  expect(await get(`${base}/chain?n=1`, { redirect: "manual" })).toMatchObject({ status: 302, redirected: false });
  const post = {
    method: "POST",
    body: "payload",
    headers: { "content-type": "text/plain", authorization: "Bearer t" },
  };
  const echoed = async (status: number, to = "/echo", extra = "") =>
    JSON.parse(
      (await get(`${base}/redirect?status=${status}&to=${encodeURIComponent(to)}${extra}`, post)).body as string,
    );
  const kept = {
    method: "POST",
    body: "payload",
    ua: "Bunvex/1.0",
    auth: "Bearer t",
    type: "text/plain",
    referrer: null,
  };
  const toGet = { ...kept, method: "GET", body: "", type: null };
  expect(await echoed(301)).toEqual(toGet);
  expect(await echoed(302)).toEqual(toGet);
  expect(await echoed(303)).toEqual(toGet);
  expect(await echoed(307)).toEqual(kept);
  expect(await echoed(308)).toEqual(kept);
  // Another origin loses Authorization; the redirect's Referrer-Policy goes on as a request header.
  expect(await echoed(307, `${base.replace("127.0.0.1", "localhost")}/echo`)).toEqual({ ...kept, auth: null });
  expect(await echoed(307, "/echo", "&policy=no-referrer")).toEqual({ ...kept, referrer: "no-referrer" });
  // A streamed body cannot be sent again: refused, but for a 303 (which drops it).
  const stream = { method: "POST", streamBody: "streamed" };
  expect(await get(`${base}/redirect?status=307&to=/echo`, stream)).toMatchObject({
    message: "fetch cannot redirect with streamed body",
  });
  expect(await get(`${base}/redirect?status=303&to=/echo`, stream)).toMatchObject({ status: 200, redirected: true });
});

test("an abort is Convex's AbortError, whatever the signal's reason", async () => {
  const { base, get } = await failures();
  expect(await get(`${base}/slow`, { abortAfter: 50 })).toEqual({
    error: "DOMException",
    name: "AbortError",
    message: "The signal has been aborted",
  });
});

test("the host's own fetch, outside any function, is untouched; a query still refuses fetch", async () => {
  const { functions, sock } = await setup();
  expect(await (await fetch("data:text/plain,host")).text()).toBe("host");
  expect(await (await fetch("http://localhost/", { unix: sock } as RequestInit)).text()).toBe("unix socket");
  expect(await functions.runQuery("m:inQuery", {})).toContain("fetch()");
});

test("a response of another Response (a subclass, or a DOM's in tests) keeps its reads, mapped as Convex's", async () => {
  class Other extends Response {}
  const send = (async () => new Other("hello", { status: 200 })) as unknown as typeof fetch;
  const r = await isolateFetch(send)("https://example.com/");
  expect(r).toBeInstanceOf(Other);
  expect(r.redirected).toBe(false);
  expect(await r.text()).toBe("hello");
  const s = await isolateFetch(send)("https://example.com/");
  expect(new TextDecoder().decode(await new Response(s.body).arrayBuffer())).toBe("hello");
});

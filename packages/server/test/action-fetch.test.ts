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
import type { FunctionLog } from "../src/function-log.ts";
import { action, Functions, NODE_FUNCTIONS, query } from "../src/functions.ts";
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

test("the host's own fetch, outside any function, is untouched; a query still refuses fetch", async () => {
  const { functions, sock } = await setup();
  expect(await (await fetch("data:text/plain,host")).text()).toBe("host");
  expect(await (await fetch("http://localhost/", { unix: sock } as RequestInit)).text()).toBe("unix socket");
  expect(await functions.runQuery("m:inQuery", {})).toContain("fetch()");
});

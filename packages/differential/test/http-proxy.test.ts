// An HTTP action that returns its `fetch`'s response as it came (a proxy route), on Convex's backend (the oracle) and
// on bunvex's (owner, 2026-10-21): the target's status, its headers and its body are sent on. Each target route answers
// another kind of body (text, JSON, bytes, none, a 404, a stream, a redirect's end); the status, the target's own
// headers, the body's framing and the body are compared off a raw socket. Local only: skipped, with a note, when
// Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-proxy: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-proxy-app");

let convex: Backend;
let bunvex: Backend;
let target: ReturnType<typeof Bun.serve> | undefined;

const ROUTES: Record<string, () => Response> = {
  text: () => new Response("from the target", { headers: { "x-target": "yes" } }),
  json: () => Response.json({ a: 1 }, { headers: { "x-target": "json" } }),
  bytes: () =>
    new Response(new Uint8Array([0, 1, 2, 255]), { headers: { "content-type": "application/octet-stream" } }),
  empty: () => new Response(null, { status: 204, headers: { "x-target": "none" } }),
  notFound: () => new Response("nope", { status: 404, headers: { "x-target": "404" } }),
  stream: () => {
    let n = 0;
    return new Response(
      new ReadableStream({
        async pull(c) {
          await Bun.sleep(20);
          if (n++ === 3) return c.close();
          c.enqueue(new TextEncoder().encode(`chunk ${n};`));
        },
      }),
      { headers: { "content-type": "text/plain", "x-target": "stream" } },
    );
  },
  redirected: () => Response.redirect("/text", 302),
};

beforeAll(async () => {
  if (!ready) return;
  target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (ROUTES[new URL(req.url).pathname.slice(1)] ?? (() => new Response("?", { status: 400 })))(),
  });
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  target?.stop(true);
});

/** The raw response off a socket: its status line, its headers (lowercased) and its body as sent (framing included). */
async function raw(
  b: Backend,
  path: string,
): Promise<{ status: string; headers: Record<string, string>; body: string }> {
  const u = new URL(`${b.url}/http${path}`);
  const bytes = await new Promise<Buffer>((done, fail) => {
    const parts: Buffer[] = [];
    const s = connect(Number(u.port), u.hostname, () =>
      s.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nhost: ${u.host}\r\nconnection: close\r\n\r\n`),
    );
    s.on("data", (d: Buffer) => parts.push(d));
    s.on("end", () => done(Buffer.concat(parts)));
    s.on("error", fail);
  });
  const text = bytes.toString("latin1");
  const at = text.indexOf("\r\n\r\n");
  const [status, ...lines] = text.slice(0, at).split("\r\n");
  const headers: Record<string, string> = {};
  for (const l of lines) {
    const i = l.indexOf(":");
    headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: status!, headers, body: text.slice(at + 4) };
}

/** What is compared: the status, the target's headers and the body's framing, the body. */
async function seen(b: Backend, route: string) {
  const r = await raw(b, `/proxy?url=${encodeURIComponent(`http://127.0.0.1:${target!.port}/${route}`)}`);
  const h = r.headers;
  return {
    status: r.status,
    type: h["content-type"],
    target: h["x-target"],
    length: h["content-length"],
    chunked: h["transfer-encoding"],
    // A chunked body's text without its framing.
    body: h["transfer-encoding"] === "chunked" ? unchunk(r.body) : r.body,
  };
}

function unchunk(body: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const eol = body.indexOf("\r\n", at);
    const n = Number.parseInt(body.slice(at, eol), 16);
    if (!(n > 0)) return out;
    out += body.slice(eol + 2, eol + 2 + n);
    at = eol + 2 + n + 2;
  }
}

describe.skipIf(!ready)("an HTTP action returning its fetch's response, against Convex's backend", () => {
  for (const route of Object.keys(ROUTES))
    test(route, async () => {
      const c = await seen(convex, route);
      const b = await seen(bunvex, route);
      expect(b).toEqual(c);
    });
});

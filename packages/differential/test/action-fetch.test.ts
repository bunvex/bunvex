// An action's `fetch` (STUDY-142) on Convex's backend (the oracle) and on bunvex's: the same requests to the
// same local targets, compared answer by answer — how a request fails (reqwest's causes, the URL's query
// string dropped, `fetch to <url> failed: …` for a body), the default `User-Agent`, redirects (Convex's loop:
// the limit, the method, the body, `Authorization`, `Referrer-Policy`, a streamed body), the 407 refusal and
// aborts. The rewrites are the decided ones:
// - `Convex/1.0` is `Bunvex/1.0` (rule 5, DV-456);
// - a name that does not resolve is refused by bunvex's screen, on by default (DV-325).
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`action-fetch: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../fetch-app");

let convex: Backend;
let bunvex: Backend;
const stops: (() => unknown)[] = [];

/** What a request carried, as the target saw it. */
const echo = (req: Request, body: string) =>
  Response.json({
    method: req.method,
    url: req.url,
    body,
    ua: req.headers.get("user-agent"),
    auth: req.headers.get("authorization"),
    type: req.headers.get("content-type"),
    referrer: req.headers.get("referrer-policy"),
  });

let base = "";
let other = ""; // the same server, another origin (localhost)
let closedPort = 0;
let emptyPort = 0;
let truncatedPort = 0;

beforeAll(async () => {
  if (!ready) return;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const q = u.searchParams;
      switch (u.pathname) {
        case "/echo":
          return echo(req, await req.text());
        case "/redirect":
          return new Response(null, {
            status: Number(q.get("status") ?? 302),
            headers: {
              location: q.get("to")!,
              ...(q.get("policy") ? { "referrer-policy": q.get("policy")! } : {}),
            },
          });
        case "/chain": {
          const n = Number(q.get("n"));
          return n === 0 ? new Response("end") : Response.redirect(`/chain?n=${n - 1}`, 302);
        }
        case "/loop":
          return new Response(null, { status: 302, headers: { location: "/loop?again=1" } });
        case "/no-location":
          return new Response("no location", { status: 302 });
        case "/407":
          return new Response("refused", { status: 407, headers: { "x-proxy-detail": "secret" } });
        case "/slow":
          return Bun.sleep(3000).then(() => new Response("late"));
        case "/drip":
          return new Response(
            new ReadableStream({
              async pull(c) {
                await Bun.sleep(100);
                c.enqueue(new TextEncoder().encode("x"));
              },
            }),
          );
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  stops.push(() => srv.stop(true));
  base = `http://127.0.0.1:${srv.port}`;
  other = `http://localhost:${srv.port}`;
  // A target that closes at once, and one whose body stops short.
  const empty = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: (s) => void s.end() } });
  const truncated = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s) {
        s.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nabc");
        setTimeout(() => s.end(), 50);
      },
    },
  });
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  closedPort = closed.port;
  closed.stop(true);
  stops.push(
    () => empty.stop(true),
    () => truncated.stop(true),
  );
  emptyPort = empty.port;
  truncatedPort = truncated.port;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
  for (const s of stops.splice(0)) await s();
});

/** The answer of `fetch:get`, with the decided rewrites (DV-456). */
async function get(b: Backend, url: string, init?: Record<string, unknown>) {
  const r = await b.call("action", "fetch:get", init === undefined ? { url } : { url, init });
  if (!r.ok) throw new Error(`${b.name}: ${r.status} ${JSON.stringify(r.body)}`);
  return JSON.parse(JSON.stringify((r.body as { value: unknown }).value).replaceAll("Convex/1.0", "Bunvex/1.0"));
}

/** Both backends' answers, which must be the same. */
async function same(url: string, init?: Record<string, unknown>) {
  const c = await get(convex, url, init);
  expect(await get(bunvex, url, init)).toEqual(c);
  return c;
}

describe.skipIf(!ready)("an action's fetch, against Convex's backend", () => {
  test("the default User-Agent (Bunvex/1.0 for Convex/1.0, DV-456); the app's own wins", async () => {
    expect((await same(`${base}/echo`)).body).toContain('"ua":"Bunvex/1.0"');
    const own = await same(`${base}/echo`, { headers: { "user-agent": "mine/2" } });
    expect(JSON.parse(own.body).ua).toBe("mine/2");
  });

  test("a target that refuses the connection, or closes at once: reqwest's cause, the query string dropped", async () => {
    const refused = await same(`http://127.0.0.1:${closedPort}/p/a?token=secret#frag`);
    expect(refused).toMatchObject({ where: "request", class: "TypeError", name: "TypeError" });
    expect(refused.message).toStartWith(
      `error sending request for url (http://127.0.0.1:${closedPort}/p/a): client error (Connect): tcp connect error: Connection refused (os error `,
    );
    // Credentials, an encoded path, no path at all: the URL as Convex prints it.
    await same(`http://user:pw@127.0.0.1:${closedPort}/p?token=s`);
    await same(`http://127.0.0.1:${closedPort}/a b/é?token=s`);
    await same(`http://127.0.0.1:${closedPort}?token=s`);
    expect((await same(`http://127.0.0.1:${emptyPort}/x?token=s`)).message).toBe(
      `error sending request for url (http://127.0.0.1:${emptyPort}/x): client error (SendRequest): connection closed before message completed`,
    );
  });

  test("a body that fails to read: fetch to <url> failed: error decoding response body", async () => {
    expect(await same(`http://127.0.0.1:${truncatedPort}/x?token=s`)).toEqual({
      where: "body",
      class: "TypeError",
      name: "TypeError",
      message: `fetch to http://127.0.0.1:${truncatedPort}/x failed: error decoding response body`,
    });
  });

  test("a 407 is the refusal, naming the hop that got it, without its query string", async () => {
    expect((await same(`${base}/407?token=secret`)).message).toBe(`Request to ${base}/407 forbidden`);
    const hop = `${base}/redirect?to=${encodeURIComponent(`${base}/407?token=hop`)}`;
    expect((await same(hop)).message).toBe(`Request to ${base}/407 forbidden`);
  });

  test("a name that does not resolve: reqwest's DNS error on Convex, the screen's refusal on bunvex (DV-325)", async () => {
    const url = "http://nonexistent-host.invalid/x?token=secret";
    expect((await get(convex, url)).message).toStartWith(
      "error sending request for url (http://nonexistent-host.invalid/x): client error (Connect): dns error: failed to lookup address information: ",
    );
    expect((await get(bunvex, url)).message).toBe("Request to http://nonexistent-host.invalid/x forbidden");
  });

  test("redirects: followed (url, redirected), at most 20, manual, error, without a Location", async () => {
    expect(await same(`${base}/redirect?to=/echo`)).toMatchObject({ status: 200, redirected: true });
    expect(await same(`${base}/chain?n=19`)).toMatchObject({ status: 200, body: "end", redirected: true });
    expect((await same(`${base}/chain?n=20`)).message).toBe("fetch too many redirects");
    expect((await same(`${base}/loop`)).message).toBe("fetch too many redirects");
    expect(await same(`${base}/redirect?to=/echo`, { redirect: "manual" })).toMatchObject({
      status: 302,
      redirected: false,
    });
    expect((await same(`${base}/redirect?to=/echo`, { redirect: "error" })).message).toBe("fetch attempted redirect");
    expect(await same(`${base}/no-location`)).toMatchObject({ status: 302, body: "no location", redirected: false });
  });

  test("redirects: the method and body, Authorization across origins, Referrer-Policy, a streamed body", async () => {
    const post = {
      method: "POST",
      body: "payload",
      headers: { "content-type": "text/plain", authorization: "Bearer t" },
    };
    for (const status of [301, 302, 303, 307, 308]) await same(`${base}/redirect?status=${status}&to=/echo`, post);
    await same(`${base}/redirect?to=${encodeURIComponent(`${other}/echo`)}`, post);
    await same(`${base}/redirect?status=307&to=/echo&policy=no-referrer`, post);
    const stream = { method: "POST", streamBody: "streamed" };
    expect((await same(`${base}/redirect?status=307&to=/echo`, stream)).message).toBe(
      "fetch cannot redirect with streamed body",
    );
    expect(await same(`${base}/redirect?status=303&to=/echo`, stream)).toMatchObject({ status: 200 });
  });

  test("an abort, while waiting or while reading the body: Convex's AbortError", async () => {
    expect(await same(`${base}/slow`, { abortAfter: 200 })).toEqual({
      where: "request",
      class: "DOMException",
      name: "AbortError",
      message: "The signal has been aborted",
    });
    expect(await same(`${base}/drip`, { abortBody: true })).toMatchObject({
      where: "body",
      name: "AbortError",
      message: "The signal has been aborted",
    });
  });
});

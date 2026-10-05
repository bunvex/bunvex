// The health routes (STUDY-112): Convex's `health_check_routes` (`/instance_name`, `/instance_version`, `/`,
// `/echo`) and the meta `/version`, with what Convex's local backend answers (probed, STUDY-112 §1).
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import pkg from "../package.json";
import { Functions } from "../src/functions.ts";
import { MAX_ECHO_BYTES, maxEchoBytesFromEnv, ROOT_TEXT, SERVER_VERSION } from "../src/health.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

async function setup(opts: { maxEchoBytes?: number } = {}) {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const s = createServer({ engine, functions: new Functions(engine), port: 0, ...opts });
  stops.push(s.stop);
  return { api: `http://127.0.0.1:${s.server!.port}`, site: `http://127.0.0.1:${s.site!.port}`, port: s.server!.port! };
}

const ORIGIN = "https://app.example";

test("the version is @bunvex/server's semver, on /version, /instance_version and the site's /version", async () => {
  const { api, site } = await setup();
  expect(SERVER_VERSION).toBe(pkg.version);
  expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  for (const url of [`${api}/version`, `${api}/instance_version`, `${site}/version`]) {
    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain;\s?charset=utf-8$/);
    expect(await r.text()).toBe(pkg.version);
  }
});

test("GET / answers bunvex's own sentence", async () => {
  const { api } = await setup();
  const r = await fetch(`${api}/`);
  expect(r.status).toBe(200);
  expect(await r.text()).toBe(ROOT_TEXT);
  expect(ROOT_TEXT.toLowerCase()).not.toContain("convex");
});

test("no auth: a bad admin key changes nothing", async () => {
  const { api } = await setup();
  const headers = { authorization: "Bunvex nope" };
  expect(await (await fetch(`${api}/instance_version`, { headers })).text()).toBe(pkg.version);
  expect(await (await fetch(`${api}/`, { headers })).text()).toBe(ROOT_TEXT);
  expect(await (await fetch(`${api}/echo`, { method: "POST", headers, body: "x" })).text()).toBe("x");
});

test("Convex's methods: GET routes 405 another (allow GET,HEAD), /echo 405 a GET (allow POST)", async () => {
  const { api } = await setup();
  for (const path of ["/", "/instance_version", "/instance_name", "/version"]) {
    const r = await fetch(`${api}${path}`, { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET,HEAD");
    expect((await fetch(`${api}${path}`, { method: "HEAD" })).status).toBe(200);
  }
  const g = await fetch(`${api}/echo`);
  expect(g.status).toBe(405);
  expect(g.headers.get("allow")).toBe("POST");
});

test("CORS on the health routes (Convex's layer), not on the meta /version", async () => {
  const { api } = await setup();
  for (const path of ["/", "/instance_version", "/instance_name"]) {
    const r = await fetch(`${api}${path}`, { headers: { origin: ORIGIN } });
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
  }
  const e = await fetch(`${api}/echo`, { method: "POST", headers: { origin: ORIGIN }, body: "hi" });
  expect(e.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const pre = await fetch(`${api}/echo`, {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST" },
  });
  expect(pre.status).toBe(200);
  expect(pre.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS,PATCH,DELETE,PUT");
  expect(
    (await fetch(`${api}/version`, { headers: { origin: ORIGIN } })).headers.get("access-control-allow-origin"),
  ).toBeNull();
});

test("/echo: 4 MiB of random bytes come back unchanged, with no content type of their own", async () => {
  const { api } = await setup();
  const data = new Uint8Array(4 * 1024 * 1024);
  // getRandomValues fills at most 64 KiB at a time.
  for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
  const r = await fetch(`${api}/echo`, { method: "POST", body: data, headers: { "content-type": "application/json" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBeNull();
  expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  const empty = await fetch(`${api}/echo`, { method: "POST" });
  expect(empty.status).toBe(200);
  expect(await empty.text()).toBe("");
});

/** A raw request declaring `length` bytes, of which only `send` are sent; the status line of the answer. */
async function declared(port: number, length: number, send: number): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let got = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        got += chunk.toString();
        if (got.includes("\r\n")) resolve(got.slice(0, got.indexOf("\r\n")));
      },
      close() {
        resolve(got.slice(0, got.indexOf("\r\n")));
      },
    },
  });
  socket.write(`POST /echo HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: ${length}\r\n\r\n`);
  socket.write(new Uint8Array(send));
  const line = await promise;
  // Dropped, not half-closed: an echo still waiting for the rest of its body would hold up the server's stop.
  socket.terminate();
  return line;
}

test("/echo: a declared length just past 128 MiB is a 413 before the body is read; 128 MiB itself is not", async () => {
  const { port } = await setup();
  expect(MAX_ECHO_BYTES).toBe(128 * 1024 * 1024);
  expect(await declared(port, MAX_ECHO_BYTES + 1, 1024)).toBe("HTTP/1.1 413 Payload Too Large");
  // Exactly the limit is taken: the echo starts streaming back before the body is all sent.
  expect(await declared(port, MAX_ECHO_BYTES, 1024)).toBe("HTTP/1.1 200 OK");
});

/**
 * POSTs `total` bytes with no declared length (one reused 1 MiB chunk) from another process, and prints how many
 * bytes came back, or -1 when the answer broke off: a real client, apart from the server's event loop.
 */
const STREAM_CLIENT = `
const [url, total] = [process.argv[1], Number(process.argv[2])];
const chunk = new Uint8Array(1024 * 1024);
let sent = 0;
const body = new ReadableStream({
  pull(c) {
    if (sent >= total) return c.close();
    const n = Math.min(chunk.length, total - sent);
    sent += n;
    c.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
  },
});
let got = 0;
try {
  const r = await fetch(url, { method: "POST", body, duplex: "half" });
  for await (const part of r.body) got += part.byteLength;
} catch {
  got = -1;
}
console.log(got);
`;

async function streamed(url: string, total: number): Promise<number> {
  const p = Bun.spawn([process.execPath, "-e", STREAM_CLIENT, url, String(total)], { stdout: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return Number(out.trim());
}

test("/echo: a body without a length is cut off past 128 MiB (streamed, one reused chunk)", async () => {
  const { api } = await setup();
  expect(await streamed(`${api}/echo`, 3_000_000)).toBe(3_000_000);
  expect(await streamed(`${api}/echo`, MAX_ECHO_BYTES + 1)).toBe(-1);
}, 60_000);

test("MAX_ECHO_BYTES, Convex's knob: unset or empty is 128 MiB; a bad value is refused", () => {
  expect(maxEchoBytesFromEnv({})).toBe(MAX_ECHO_BYTES);
  expect(maxEchoBytesFromEnv({ MAX_ECHO_BYTES: "" })).toBe(MAX_ECHO_BYTES);
  expect(maxEchoBytesFromEnv({ MAX_ECHO_BYTES: "1000" })).toBe(1000);
  expect(() => maxEchoBytesFromEnv({ MAX_ECHO_BYTES: "-1" })).toThrow("MAX_ECHO_BYTES: not a non-negative integer: -1");
  expect(() => maxEchoBytesFromEnv({ MAX_ECHO_BYTES: "1.5" })).toThrow("MAX_ECHO_BYTES");
});

test("/echo with a configured limit of 1000 bytes: 1000 echo, 1001 is a 413, a longer chunked body is cut off", async () => {
  const { api, port } = await setup({ maxEchoBytes: 1000 });
  const at = await fetch(`${api}/echo`, { method: "POST", body: new Uint8Array(1000).fill(3) });
  expect(at.status).toBe(200);
  expect((await at.arrayBuffer()).byteLength).toBe(1000);
  const over = await fetch(`${api}/echo`, { method: "POST", body: new Uint8Array(1001) });
  expect(over.status).toBe(413);
  expect(await declared(port, 1001, 10)).toBe("HTTP/1.1 413 Payload Too Large");
  expect(await streamed(`${api}/echo`, 999)).toBe(999);
  expect(await streamed(`${api}/echo`, 2 * 1024 * 1024)).toBe(-1);
});

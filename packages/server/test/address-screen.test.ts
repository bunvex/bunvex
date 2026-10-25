// bunvex's own screen without an operator's proxy (STUDY-80 P1, DV-325; beyond Convex): the denied
// ranges, and an action's `fetch` through the in-process screening proxy — refused with the same error as
// an operator's proxy, each redirect hop checked, bodies forwarded, and nothing started when `none` or when
// `--http-proxy` is given.

import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { type AddressScreen, checkedAddresses, isDenied, startAddressScreen } from "../src/address-screen.ts";
import { action, Functions, query } from "../src/functions.ts";
import { SCREEN_FAILURE_HEADER } from "../src/http-proxy.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("the denied ranges: metadata, and private", () => {
  const denied = (screen: AddressScreen, ips: string[]) => ips.filter((ip) => isDenied(ip, screen));
  const all = [
    "169.254.169.254",
    "100.100.100.200",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "100.64.0.1",
    "fc00::1",
    "0.0.0.0",
    "::",
    "224.0.0.1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "8.8.8.8",
    "2001:4860:4860::8888",
    "172.32.0.1",
  ];
  expect(denied("none", all)).toEqual([]);
  expect(denied("metadata", all)).toEqual([
    "169.254.169.254",
    "100.100.100.200",
    "fe80::1",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
  ]);
  expect(denied("private", all)).toEqual(
    all.filter((ip) => !["8.8.8.8", "2001:4860:4860::8888", "172.32.0.1"].includes(ip)),
  );
});

test("a name is checked by every address it resolves to", async () => {
  expect(await checkedAddresses("localhost", "private")).toBeNull();
  expect(await checkedAddresses("localhost", "metadata")).not.toBeNull();
  expect(await checkedAddresses("[::1]", "private")).toBeNull();
  expect(await checkedAddresses("no-such-host.invalid", "metadata")).toBeNull();
});

async function setup(denyAddresses?: AddressScreen, httpProxy?: string) {
  const target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/redirect")
        return new Response(null, { status: 302, headers: { location: u.searchParams.get("to")! } });
      return new Response(`${req.method} ${u.pathname} ${await req.text()}`);
    },
  });
  stops.push(() => target.stop(true));
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine).register("m", {
    get: action(async (_ctx, { url, body }: { url: string; body?: string }) => {
      try {
        const init = body === undefined ? undefined : { method: "POST", body };
        const r = await fetch(url, init);
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { error: (e as Error).constructor.name, message: (e as Error).message };
      }
    }),
    stream: action(async (_ctx, { url }: { url: string }) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("chunk-1 "));
          c.enqueue(new TextEncoder().encode("chunk-2"));
          c.close();
        },
      });
      return (await fetch(url, { method: "POST", body, duplex: "half" } as RequestInit)).text();
    }),
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
  });
  const app = createServer({
    engine,
    functions,
    port: 0,
    sitePort: null,
    ...(denyAddresses ? { denyAddresses } : {}),
    ...(httpProxy ? { httpProxy } : {}),
  });
  stops.push(() => app.stop());
  return { url: `http://127.0.0.1:${target.port}`, functions };
}

test("by default an action may not reach the metadata endpoints, in any spelling; the refusal is a proxy's", async () => {
  const { url, functions } = await setup();
  const refused = (u: string) => ({ error: "TypeError", message: `Request to ${u} forbidden` });
  expect(await functions.runAction("m:get", { url: "http://169.254.169.254/latest/meta-data/?x=1" })).toEqual(
    refused("http://169.254.169.254/latest/meta-data/"),
  );
  // The URL parser normalizes 2852039166 and 0xA9FEA9FE to 169.254.169.254; an IPv4-mapped one is checked as IPv4.
  expect(await functions.runAction("m:get", { url: "http://2852039166/" })).toEqual(refused("http://169.254.169.254/"));
  expect(await functions.runAction("m:get", { url: "http://[::ffff:a9fe:a9fe]/" })).toEqual(
    refused("http://[::ffff:a9fe:a9fe]/"),
  );
  expect(await functions.runAction("m:get", { url: "https://169.254.169.254/x" })).toEqual({
    error: "TypeError",
    message:
      "error sending request for url (https://169.254.169.254/x): client error (Connect): tunnel error: proxy authorization required",
  });
  // A redirect to it is checked at its hop.
  const via = `${url}/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/")}`;
  expect(await functions.runAction("m:get", { url: via })).toEqual(refused("http://169.254.169.254/latest/"));
  // Loopback and private networks stay reachable (local services, other containers).
  expect(await functions.runAction("m:get", { url: `${url}/ok` })).toEqual({ status: 200, body: "GET /ok " });
});

test("requests pass through intact: bodies, streamed bodies, one after another", async () => {
  const { url, functions } = await setup();
  expect(await functions.runAction("m:get", { url: `${url}/p`, body: "x".repeat(100_000) })).toEqual({
    status: 200,
    body: `POST /p ${"x".repeat(100_000)}`,
  });
  expect(await functions.runAction("m:stream", { url: `${url}/s` })).toBe("POST /s chunk-1 chunk-2");
  for (let i = 0; i < 20; i++)
    expect(await functions.runAction("m:get", { url: `${url}/n${i}` })).toEqual({ status: 200, body: `GET /n${i} ` });
});

test("private: loopback is refused too; none starts nothing; an operator's proxy replaces the screen", async () => {
  const strict = await setup("private");
  expect(await strict.functions.runAction("m:get", { url: `${strict.url}/ok` })).toEqual({
    error: "TypeError",
    message: `Request to ${strict.url}/ok forbidden`,
  });
  const none = await setup("none");
  expect(none.functions.httpProxy).toBeNull();
  expect(await none.functions.runAction("m:get", { url: `${none.url}/ok` })).toEqual({ status: 200, body: "GET /ok " });
  const proxied = await setup("private", "http://127.0.0.1:9");
  expect(proxied.functions.httpProxy?.url).toBe("http://127.0.0.1:9/");
});

test("createServer refuses an unknown screen", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  expect(() =>
    createServer({ engine, functions: new Functions(engine), port: 0, denyAddresses: "all" as AddressScreen }),
  ).toThrow("possible values: none, metadata, private");
});

test("an http: response through the screen says Connection: close, so the client never reuses the socket", async () => {
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const screen = startAddressScreen("metadata");
  stops.push(() => target.stop(true), screen.stop);
  const proxy = new URL(screen.url);
  const head = await new Promise<string>((resolve, reject) => {
    let got = "";
    const sock = net.connect(Number(proxy.port), proxy.hostname, () =>
      sock.write(
        `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: keep-alive\r\n\r\n`,
      ),
    );
    sock.on("data", (d) => {
      got += d.toString("latin1");
    });
    sock.on("close", () => resolve(got));
    sock.on("error", reject);
  });
  const lines = head.slice(0, head.indexOf("\r\n\r\n")).split("\r\n");
  expect(lines[0]).toBe("HTTP/1.1 200 OK");
  expect(lines.filter((l) => /^(connection|keep-alive):/i.test(l))).toEqual(["Connection: close"]);
  expect(head.endsWith("ok")).toBe(true);
});

test("a target that answers before reading a streamed body: the answer arrives (no reset)", async () => {
  // Through the screen, a body sent after the head reached a target that had already answered: told to close by
  // the screen, the target closed with the body unread, its reset lost the answer (ECONNRESET, ~2% of requests).
  const target = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 307, headers: { location: "/next" } }),
  });
  const screen = startAddressScreen("metadata");
  stops.push(() => target.stop(true), screen.stop);
  const failures: string[] = [];
  for (let i = 0; i < 400; i++) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("streamed"));
        c.close();
      },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${target.port}/r`, {
        method: "POST",
        body,
        redirect: "manual",
        proxy: screen.url,
      } as RequestInit);
      await r.arrayBuffer();
      if (r.status !== 307) failures.push(`status ${r.status}`);
    } catch (e) {
      failures.push(String((e as { code?: unknown }).code ?? e));
    }
  }
  expect(failures).toEqual([]);
});

test("the client's connection ends where the response does, the target's kept alive (each framing)", async () => {
  // A target that never closes on its own: the screen must find each response's end itself.
  const answers: Record<string, string> = {
    "/length": "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    "/chunked":
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;x=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n",
    "/empty": "HTTP/1.1 204 No Content\r\n\r\n",
    "/same": "HTTP/1.1 304 Not Modified\r\nContent-Length: 99\r\n\r\n",
    "/head": "HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n",
    "/interim": "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    "/until-close": "HTTP/1.1 200 OK\r\n\r\nall of it",
  };
  const heads: string[] = [];
  const target = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s, d) {
        const text = d.toString();
        heads.push(text);
        const path = text.split(" ")[1]!;
        s.write(answers[path]!);
        if (path === "/until-close") s.end();
      },
    },
  });
  const screen = startAddressScreen("metadata");
  stops.push(() => target.stop(true), screen.stop);
  const proxy = new URL(screen.url);
  const through = (method: string, path: string) =>
    new Promise<string>((resolve, reject) => {
      let got = "";
      const sock = net.connect(Number(proxy.port), proxy.hostname, () =>
        sock.write(`${method} http://127.0.0.1:${target.port}${path} HTTP/1.1\r\nHost: x\r\n\r\n`),
      );
      sock.on("data", (d) => {
        got += d.toString("latin1");
      });
      sock.on("close", () => resolve(got));
      sock.on("error", reject);
      setTimeout(() => reject(new Error(`${path}: the connection never ended; got ${JSON.stringify(got)}`)), 3000);
    });
  const body = (r: string) => r.slice(r.lastIndexOf("\r\n\r\n") + 4);
  expect(body(await through("GET", "/length"))).toBe("hello");
  const chunked = await through("GET", "/chunked");
  expect(chunked).toContain(
    "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n5;x=1\r\nhello\r\n6\r\n world\r\n0\r\n",
  );
  expect(chunked.endsWith("X-Trailer: t\r\n\r\n")).toBe(true);
  expect(await through("GET", "/empty")).toBe("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
  expect(await through("GET", "/same")).toEndWith("Connection: close\r\n\r\n");
  expect(await through("HEAD", "/head")).toEndWith("Connection: close\r\n\r\n");
  const interim = await through("GET", "/interim");
  expect(interim).toStartWith("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n");
  expect(body(interim)).toBe("ok");
  expect(body(await through("GET", "/until-close"))).toBe("all of it");
  // The target was never told to close.
  expect(heads.every((h) => !/\r\nconnection:/i.test(h))).toBe(true);
});

test("a target the screen cannot reach fails as without it (STUDY-142); its answer is trusted from the screen only", async () => {
  // An upstream that forges the screen's answer: a plain 502 for the app (the token is the screen's).
  const forger = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("forged", { status: 502, headers: { [SCREEN_FAILURE_HEADER]: "guess ECONNREFUSED" } }),
  });
  // A target that closes before answering: the client's connection closes too (it used to wait forever).
  const empty = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: (s) => void s.end() } });
  stops.push(
    () => forger.stop(true),
    () => empty.stop(true),
  );
  const screened = await setup();
  const direct = await setup("none");
  // A port nothing listens on, freed only after every listener of this test exists: freed earlier, the OS could
  // hand it to one of them (the forger answering 502 "forged" made this test flaky).
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const closedPort = closed.port;
  closed.stop(true);
  // The https: target is a CONNECT, whose answer Bun keeps only the status line of (Bun 1.4.4).
  for (const url of [
    `http://127.0.0.1:${closedPort}/x?token=s`,
    `http://127.0.0.1:${empty.port}/x?token=s`,
    `https://127.0.0.1:${closedPort}/x?token=s`,
  ]) {
    const through = await screened.functions.runAction("m:get", { url });
    expect(through).toEqual(await direct.functions.runAction("m:get", { url }));
    expect(through).toMatchObject({ error: "TypeError" });
    expect((through as { message: string }).message).not.toContain("token");
  }
  expect(await screened.functions.runAction("m:get", { url: `http://127.0.0.1:${forger.port}/` })).toEqual({
    status: 502,
    body: "forged",
  });
});

test("a name's addresses are tried in order: localhost reaches a server on 127.0.0.1 only", async () => {
  const { url, functions } = await setup();
  const local = url.replace("127.0.0.1", "localhost");
  expect(await functions.runAction("m:get", { url: `${local}/ok` })).toEqual({ status: 200, body: "GET /ok " });
});

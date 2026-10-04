// bunvex's own screen without an operator's proxy (STUDY-80 P1, DV-325; beyond Convex): the denied
// ranges, and an action's `fetch` through the in-process screening proxy — refused with the same error as
// an operator's proxy, each redirect hop checked, bodies forwarded, and nothing started when `none` or when
// `--http-proxy` is given.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { type AddressScreen, checkedAddress, isDenied } from "../src/address-screen.ts";
import { action, Functions, query } from "../src/functions.ts";
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
  expect(await checkedAddress("localhost", "private")).toBeNull();
  expect(await checkedAddress("localhost", "metadata")).not.toBeNull();
  expect(await checkedAddress("[::1]", "private")).toBeNull();
  expect(await checkedAddress("no-such-host.invalid", "metadata")).toBeNull();
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

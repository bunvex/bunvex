// The operator's proxy (STUDY-80 §3.2), as Convex's `--convex-http-proxy`: what goes through it (an isolate
// or HTTP action's `fetch`, OIDC discovery and JWKS, the webhook and provider sinks; not Sentry's, not a
// `"use node"` action's), named by the instance (`Proxy-Authorization`), and a 407 answered with Convex's
// messages (those of its local backend run as an oracle, STUDY-80 §1.4). Against a local screening proxy.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { action, Functions, mutation, NODE_FUNCTIONS, query } from "../src/functions.ts";
import { localBackendMain, NO_PROXY_WARNING, parseLocalBackendFlags } from "../src/local-backend.ts";
import { httpAction, httpRouter } from "../src/router.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { startIssuer } from "./issuer.ts";
import { startScreeningProxy } from "./screening-proxy.ts";

const NAME = "proxy-test-instance";
const SECRET = "4361726e697461732c206c69746572616c6c7920646f6e6b65792c206d61696e";
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function attempt(f: () => Promise<Response>) {
  try {
    const r = await f();
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { error: (e as Error).constructor.name, message: (e as Error).message };
  }
}

/** Local targets: `/ok`, `/redirect?to=`, and `/407` (a target that itself answers 407). */
function target() {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/redirect")
        return new Response(null, { status: 302, headers: { location: u.searchParams.get("to")! } });
      if (u.pathname === "/407") return new Response("no", { status: 407 });
      return new Response(`ok ${u.pathname}`);
    },
  });
  stops.push(() => s.stop(true));
  return { port: s.port!, url: `http://127.0.0.1:${s.port}` };
}

async function setup(opts: { proxy?: boolean; server?: Partial<ServerOptions> } = {}) {
  const t = target();
  const refusedPort = target().port; // a second target the proxy refuses
  const proxy = await startScreeningProxy((host, port) => port === refusedPort || host.endsWith(".refused.test"));
  stops.push(proxy.stop);
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const nodeGet = action(async (_ctx, { url }: { url: string }) => attempt(() => fetch(url)));
  NODE_FUNCTIONS.add(nodeGet);
  const functions = new Functions(engine).register("m", {
    get: action(async (_ctx, { url, redirect }: { url: string; redirect?: "follow" | "manual" | "error" }) =>
      attempt(() => fetch(url, redirect ? { redirect } : undefined)),
    ),
    nodeGet,
    whoami: query(async ({ auth }) => (await auth.getUserIdentity())?.subject ?? null),
  });
  const http = httpRouter();
  http.route({
    path: "/f",
    method: "GET",
    handler: httpAction(async (_ctx, req) =>
      Response.json(await attempt(() => fetch(new URL(req.url).searchParams.get("u")!))),
    ),
  });
  const app = createServer({
    engine,
    functions,
    port: 0,
    sitePort: null,
    http,
    httpProxy: opts.proxy === false ? null : proxy.url,
    ...opts.server,
  });
  stops.push(() => app.stop());
  const refused = `http://127.0.0.1:${refusedPort}`;
  return { t, refused, proxy, functions, app, engine };
}

test("an action's fetch goes through the proxy, named by the instance; a refusal is Convex's TypeError", async () => {
  const { t, refused, proxy, functions } = await setup();
  expect(await functions.runAction("m:get", { url: `${t.url}/ok?tok=1` })).toEqual({ status: 200, body: "ok /ok" });
  expect(proxy.seen.at(-1)).toEqual({ method: "GET", target: `${t.url}/ok?tok=1`, auth: NAME });
  // Refused: the URL without its query string, nothing of the proxy's answer.
  expect(await functions.runAction("m:get", { url: `${refused}/blocked?tok=secret` })).toEqual({
    error: "TypeError",
    message: `Request to ${refused}/blocked forbidden`,
  });
  // An https: target: a CONNECT with the name; refused, reqwest's tunnel error as Convex reports it.
  expect(await functions.runAction("m:get", { url: "https://api.refused.test/x?tok=s" })).toEqual({
    error: "TypeError",
    message:
      "error sending request for url (https://api.refused.test/x): client error (Connect): tunnel error: proxy authorization required",
  });
  expect(proxy.seen.at(-1)).toEqual({ method: "CONNECT", target: "api.refused.test:443", auth: NAME });
});

test("a redirect is another request through the proxy; its refusal names the hop; manual keeps the 302", async () => {
  const { t, refused, proxy, functions } = await setup();
  const url = `${t.url}/redirect?to=${encodeURIComponent(`${refused}/after?x=1`)}`;
  expect(await functions.runAction("m:get", { url })).toEqual({
    error: "TypeError",
    message: `Request to ${refused}/after forbidden`,
  });
  expect(proxy.seen.slice(-2).map((r) => [r.target, r.auth])).toEqual([
    [url, NAME],
    [`${refused}/after?x=1`, NAME],
  ]);
  expect(await functions.runAction("m:get", { url, redirect: "manual" })).toMatchObject({ status: 302 });
});

test("an HTTP action's fetch goes through the proxy too", async () => {
  const { refused, proxy, app } = await setup();
  const r = await fetch(`http://127.0.0.1:${app.server.port}/http/f?u=${encodeURIComponent(`${refused}/z?q=1`)}`);
  expect(await r.json()).toEqual({ error: "TypeError", message: `Request to ${refused}/z forbidden` });
  expect(proxy.seen.at(-1)?.auth).toBe(NAME);
});

test("a \"use node\" action's fetch does not go through the proxy, as Convex's local Node executor", async () => {
  const { refused, proxy, functions } = await setup();
  expect(await functions.runAction("m:nodeGet", { url: `${refused}/n` })).toEqual({ status: 200, body: "ok /n" });
  expect(proxy.seen).toEqual([]);
});

test("a 407 from anywhere is the refusal, without a proxy too (Convex checks the status)", async () => {
  const { t, proxy, functions } = await setup({ proxy: false });
  expect(await functions.runAction("m:get", { url: `${t.url}/407?x=1` })).toEqual({
    error: "TypeError",
    message: `Request to ${t.url}/407 forbidden`,
  });
  expect(await functions.runAction("m:get", { url: `${t.url}/ok` })).toEqual({ status: 200, body: "ok /ok" });
  expect(proxy.seen).toEqual([]);
});

test("OIDC discovery and JWKS go through the proxy; refused, the provider fails with Convex's messages", async () => {
  const issuer = await startIssuer();
  stops.push(issuer.stop);
  const issuerPort = Number(new URL(issuer.url).port);
  const call = async (port: number, token: string) =>
    (
      await fetch(`http://127.0.0.1:${port}/api/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: "m:whoami", args: {} }),
      })
    ).json();
  // Allowed: verified through the proxy.
  const ok = await setup({ server: { auth: { providers: [{ domain: issuer.url, applicationID: "app" }] } } });
  expect(((await call(ok.app.server.port!, await issuer.sign({ sub: "ada" }))) as { value: unknown }).value).toBe(
    "ada",
  );
  expect(ok.proxy.seen.map((r) => [r.target, r.auth])).toEqual([
    [`${issuer.url}/.well-known/openid-configuration`, NAME],
    [`${issuer.url}/jwks.json`, NAME],
  ]);
  // Refused: the proxy refuses the issuer's port.
  const refusing = await startScreeningProxy((_h, port) => port === issuerPort);
  stops.push(refusing.stop);
  const oidc = await setup({
    server: { httpProxy: refusing.url, auth: { providers: [{ domain: issuer.url, applicationID: "app" }] } },
  });
  expect(await call(oidc.app.server.port!, await issuer.sign())).toMatchObject({
    code: "AuthProviderDiscoveryFailed",
    message: `Auth provider discovery of ${issuer.url} failed`,
  });
  const jwks = `${issuer.url}/jwks.json`;
  const custom = await setup({
    server: {
      httpProxy: refusing.url,
      auth: { providers: [{ type: "customJwt", issuer: issuer.url, jwks, algorithm: "RS256", applicationID: "app" }] },
    },
  });
  expect(await call(custom.app.server.port!, await issuer.sign())).toMatchObject({
    code: "InvalidAuthHeader",
    message: `Could not fetch JWKS from URL '${jwks}': Request to ${jwks} forbidden. Check that the URL is correct and accessible.`,
  });
});

test("log sinks: the webhook and providers go through the proxy, Sentry's does not", async () => {
  // The sinks' HTTP client records each request and whether it was given the proxy, and answers 200.
  const sent: { url: string; via: string | null }[] = [];
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    const via = (init as { proxy?: { headers: Record<string, string> } } | undefined)?.proxy?.headers;
    sent.push({ url: String(input), via: via?.["Proxy-Authorization"] ?? null });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  // The webhook goes over the network (the `fetch` option is the providers'): through a real proxy.
  const proxy = await startScreeningProxy(() => false);
  stops.push(proxy.stop);
  const hook = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 200 }) });
  stops.push(() => hook.stop(true));
  const hookUrl = `http://127.0.0.1:${hook.port}/hook`;
  const fail = mutation(() => {
    throw new Error("boom");
  });
  const key = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 2 });
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false }), {
    instanceName: NAME,
    instanceSecret: SECRET,
  }).init();
  const app = createServer({
    engine,
    functions: new Functions(engine).register("m", { fail }),
    port: 0,
    sitePort: null,
    httpProxy: proxy.url,
    logSinks: { aggregationMs: 20, webhookBackoffMs: [1, 2], providerBackoffMs: [1, 2], random: () => 0, fetch: base },
  });
  stops.push(() => app.stop());
  await app.logSinksReady;
  const api = `http://127.0.0.1:${app.server.port}/api`;
  const create = (body: object) =>
    fetch(`${api}/v1/create_log_stream`, {
      method: "POST",
      headers: { authorization: `Bunvex ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const b of [
    { logStreamType: "webhook", url: hookUrl, format: "json" },
    { logStreamType: "datadog", siteLocation: "US1", ddApiKey: "k", ddTags: [] },
    { logStreamType: "sentry", dsn: "https://k@o1.ingest.example.io/42" },
  ])
    expect((await create(b)).status).toBe(200);
  for (let i = 0; i < 400 && !sent.some((x) => x.url.includes("ingest.example.io")); i++) {
    await fetch(`${api}/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "m:fail", args: {} }),
    });
    await Bun.sleep(10);
  }
  const via = (host: string) => [...new Set(sent.filter((x) => x.url.includes(host)).map((x) => x.via))];
  expect(proxy.seen.filter((r) => r.target === hookUrl).map((r) => [r.method, r.auth])).toContainEqual(["POST", NAME]);
  expect(via("datadoghq.com")).toEqual([NAME]);
  expect(via("ingest.example.io")).toEqual([null]);
});

test("bunvex-local-backend --http-proxy: checked as clap checks a URL; without it, Convex's warning", async () => {
  const flags = (extra: string[]) => parseLocalBackendFlags(["--instance-secret", SECRET, ...extra]);
  expect(flags(["--http-proxy", "http://proxy:4750"])).toMatchObject({ httpProxy: "http://proxy:4750" });
  expect(flags(["--http-proxy", "notaurl"])).toBe(
    "invalid value 'notaurl' for '--http-proxy <HTTP_PROXY>': relative URL without a base",
  );
  expect(flags(["--http-proxy", "socks5://p:1"])).toContain("the proxy's scheme must be http or https");
  expect(flags([])).not.toHaveProperty("httpProxy");
  // Running: the warning without a proxy, none with one.
  for (const proxy of [[], ["--http-proxy", "http://127.0.0.1:9"]]) {
    const cwd = mkdtempSync(join(tmpdir(), "bunvex-proxy-lb-"));
    stops.push(() => rmSync(cwd, { recursive: true, force: true }));
    const err: string[] = [];
    const io = { env: {}, cwd, out: () => {}, err: (l: string) => err.push(l) };
    const exit = localBackendMain(
      ["--instance-secret", SECRET, "--port", "0", "--site-proxy-port", "0", ...proxy],
      io,
      "v1",
    );
    for (let i = 0; i < 500 && err.length < 2; i++) await Bun.sleep(10);
    await Bun.sleep(20);
    expect(err.includes(NO_PROXY_WARNING)).toBe(proxy.length === 0);
    process.emit("SIGTERM");
    expect(await exit).toBe(0);
  }
});

test("createServer refuses a proxy URL it cannot use", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  expect(() => createServer({ engine, functions: new Functions(engine), port: 0, httpProxy: "ftp://x" })).toThrow(
    "invalid proxy URL 'ftp://x': the scheme must be http or https",
  );
});

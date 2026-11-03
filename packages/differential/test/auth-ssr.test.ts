// Built-in auth under server rendering (STUDY-202 §5): Convex Auth v2's `./ssr` at the pin (built from the reference
// clone by harness/convex-auth.ts) in front of Convex's backend, and `@bunvex/auth/ssr` in front of bunvex's, both
// serving the app of auth-app/. Each side's own HTTP client, pointed at the sign-in route as a page's would be, and a
// browser's cookie jar make the same calls through the same routes: sign-up and sign-in through the proxy (completed,
// refused, a function not on the list, a result that is not a sign-in's, a function that throws, malformed calls,
// another site), refresh and sign-out from the cookies, the server-side session check. Compared, call by call: the
// status, the content type, the body and every `Set-Cookie` line, with the cookie names mapped (DV-577), tokens, ids
// and dates by their form, and the proxy's wire names (DV-307, DV-315) and words (rule 5) mapped. Local only: skipped,
// with a note, without Convex's backend or a convex-auth clone to build the pin from.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { BunvexHttpClient } from "@bunvex/client";
import { anyApi as bunvexApi } from "@bunvex/server";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as convexApi } from "convex/server";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";
import { authAppPreparer, convexAuthModules } from "../harness/convex-auth.ts";

const pin = existsSync(ORACLE_BIN) ? convexAuthModules() : { missing: `no Convex backend at ${ORACLE_BIN}` };
const ready = "modules" in pin;
if (!ready) console.warn(`auth-ssr: skipped, ${(pin as { missing: string }).missing} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../auth-app");
const PASSWORD = "correct horse battery staple";
const ORIGIN = { origin: "https://app.test", host: "app.test" };
let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  const prepare = authAppPreparer((pin as { modules: string }).modules);
  [convex, bunvex] = await startAll([startConvex({ app: APP, prepare }), startBunvex({ app: APP, prepare })]);
}, 600_000);
afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

type Handler = (request: Request) => Promise<Response>;
type Side = {
  routes: Record<"/auth/signin" | "/auth/refresh" | "/auth/signout", Handler>;
  isAuthenticated: (token: string | null) => Promise<boolean>;
  /** The side's HTTP client, its address the sign-in route, its requests sent with `fetch`. */
  client: (fetch: typeof globalThis.fetch) => {
    mutation: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
};

const SIGN_INS = [
  "signUpWithUsernamePassword",
  "signInWithUsernamePassword",
  "signInAnonymously",
  // A query on the list, which returns no sign-in result.
  "me",
];

async function v2Side(b: Backend): Promise<Side> {
  const ssr = await import(join((pin as { modules: string }).modules, "@convex-dev/auth/dist/ssr/index.js"));
  const api = convexApi.auth;
  const routes = ssr.setupConvexAuthServer({
    convexUrl: b.url,
    refreshSession: api.refreshSession,
    signOut: api.signOut,
    signIn: SIGN_INS.map((name) => api[name]),
    cookieOptions: { secure: true },
  });
  return {
    routes: {
      "/auth/signin": routes.convexProxyHandler,
      "/auth/refresh": routes.refreshHandler,
      "/auth/signout": routes.signOutHandler,
    },
    isAuthenticated: ssr.createServerAuthChecker({ convexUrl: b.url, isAuthenticated: api.isAuthenticated }),
    client: (fetch) => {
      const c = new ConvexHttpClient("/auth/signin?path=", {
        skipConvexDeploymentUrlCheck: true,
        logger: false,
        fetch,
      });
      return {
        mutation: (name, args) => c.mutation(convexApi.auth[name] as never, args as never),
        query: (name, args) => c.query(convexApi.auth[name] as never, args as never),
      };
    },
  };
}

async function bunvexSide(b: Backend): Promise<Side> {
  const ssr = await import("@bunvex/auth/ssr");
  const api = bunvexApi.auth;
  const routes = ssr.setupBunvexAuthServer({
    bunvexUrl: b.url,
    refreshSession: api.refreshSession as never,
    signOut: api.signOut as never,
    signIn: SIGN_INS.map((name) => api[name] as never),
    cookieOptions: { secure: true },
  });
  return {
    routes: {
      "/auth/signin": routes.bunvexProxyHandler,
      "/auth/refresh": routes.refreshHandler,
      "/auth/signout": routes.signOutHandler,
    },
    isAuthenticated: ssr.createServerAuthChecker({ bunvexUrl: b.url, isAuthenticated: api.isAuthenticated as never }),
    client: (fetch) => {
      const c = new BunvexHttpClient("/auth/signin?path=", { skipDeploymentUrlCheck: true, logger: false, fetch });
      return {
        mutation: (name, args) => c.mutation(bunvexApi.auth[name] as never, args as never),
        query: (name, args) => c.query(bunvexApi.auth[name] as never, args as never),
      };
    },
  };
}

type Exchange = { status: number; contentType: string | null; body: string; setCookie: string[] };

/** A browser on the app's pages: its cookie jar, and each request to a route and its answer. */
function browser(side: Side) {
  const jar = new Map<string, string>();
  const log: Record<string, Exchange[]> = {};
  let step = "";
  async function send(path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
    const url = new URL(path, "https://app.test");
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const request = new Request(url.href, {
      method: "POST",
      headers: { ...ORIGIN, ...(cookie && { cookie }), ...init.headers },
      body: init.body ?? "{}",
    });
    const response = await side.routes[url.pathname as keyof Side["routes"]](request);
    const setCookie = response.headers.getSetCookie();
    for (const line of setCookie) {
      const [pair = "", ...attributes] = line.split("; ");
      const name = pair.slice(0, pair.indexOf("="));
      if (attributes.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf("=") + 1));
    }
    const exchanges = log[step] ?? [];
    log[step] = exchanges;
    exchanges.push({
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.clone().text(),
      setCookie,
    });
    return response;
  }
  // What a page's HTTP client sends: the route's path and query, its own headers and body.
  const fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    send(String(input), {
      body: init?.body as string,
      headers: init?.headers as Record<string, string>,
    })) as typeof globalThis.fetch;
  const client = side.client(fetch);
  return {
    jar,
    log,
    send,
    client,
    at(name: string) {
      step = name;
    },
  };
}

/** A call's outcome as the page sees it: the value, or the error's message. */
async function outcome(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The whole scenario through one side's routes: each step's outcome, and the exchanges it made. */
async function scenario(side: Side) {
  const page = browser(side);
  const results: Record<string, unknown> = {};
  const step = async (name: string, run: () => Promise<unknown>) => {
    page.at(name);
    results[name] = await run();
    return results[name] as never;
  };
  const m = (name: string, args: Record<string, unknown>) => outcome(() => page.client.mutation(name, args));

  await step("sign up", () => m("signUpWithUsernamePassword", { username: "alice", password: PASSWORD }));
  await step("sign up: the username taken", () =>
    m("signUpWithUsernamePassword", { username: "Alice", password: PASSWORD }),
  );
  await step("sign in: a wrong password", () =>
    m("signInWithUsernamePassword", { username: "alice", password: "wrong horse battery staple" }),
  );
  const signedIn = (await step("sign in", () =>
    m("signInWithUsernamePassword", { username: "alice", password: PASSWORD }),
  )) as { value: { tokens: { accessToken: string } } };
  await step("a function not on the list", () => m("changePassword", { currentPassword: "a", newPassword: "b" }));
  await step("a function on the list that returns no sign-in result", () => outcome(() => page.client.query("me", {})));
  await step("a function that throws (its arguments refused)", () => m("signUpWithUsernamePassword", { username: 1 }));
  await step("a body that is not JSON", () => page.send("/auth/signin?path=/api/mutation", { body: "not json" }));
  await step("a path that is not a function endpoint", () => page.send("/auth/signin?path=/api/query_ts"));
  await step("another site's sign-in", () =>
    page.send("/auth/signin?path=/api/mutation", { headers: { origin: "https://evil.test" } }),
  );
  await step("another site's refresh", () => page.send("/auth/refresh", { headers: { origin: "https://evil.test" } }));
  await step("another site's sign-out", () => page.send("/auth/signout", { headers: { origin: "https://evil.test" } }));
  await step("no Origin", () => page.send("/auth/refresh", { headers: { origin: "" } }));

  await step("the session checked on the server", () => side.isAuthenticated(signedIn.value.tokens.accessToken));
  const refreshed = (await step("refresh", async () => (await page.send("/auth/refresh")).json())) as {
    tokens: { accessToken: string };
  };
  await step("the refreshed session checked", () => side.isAuthenticated(refreshed.tokens.accessToken));
  const spent = new Map(page.jar);
  await step("sign out", () => page.send("/auth/signout"));
  await step("refresh, signed out", () => page.send("/auth/refresh"));
  await step("the session checked once signed out", () => side.isAuthenticated(refreshed.tokens.accessToken));
  for (const [name, value] of spent) page.jar.set(name, value);
  await step("refresh with the signed-out session's cookie", () => page.send("/auth/refresh"));
  await step("sign out, signed out", () => page.send("/auth/signout"));
  await step("the session check, no token", () => side.isAuthenticated(null));
  await step("the session check, not a token", () => side.isAuthenticated("garbage"));
  await step("sign in anonymously", () => m("signInAnonymously", {}));
  await step("refresh, anonymous", () => page.send("/auth/refresh"));
  return { results, log: page.log };
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Tokens, ids and dates by their form; each side's names as bunvex's. */
function normalize(value: unknown): unknown {
  const ids = new Map<string, string>();
  const text = (s: string): string => {
    if (JWT.test(s)) return "<jwt>";
    if (REFRESH_TOKEN.test(s)) return "<refresh token>";
    return s
      .replaceAll("__convexAuthJWT", "__bunvexAuthJWT")
      .replaceAll("__convexAuthRefreshToken", "__bunvexAuthRefreshToken")
      .replaceAll("Malformed Convex function call.", "Malformed function call.")
      .replace(/=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+);/, "=<jwt>;")
      .replace(/=([A-Za-z0-9_-]{43});/, "=<refresh token>;")
      .replace(/Expires=(?!Thu, 01 Jan 1970)[^;]+/, "Expires=<date>")
      .replace(/\[Request ID: [0-9a-f]+\] /, "");
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v !== "string") return v;
    if (key === "userId") {
      if (!ids.has(v)) ids.set(v, `user${ids.size + 1}`);
      return ids.get(v);
    }
    if (key === "body" && v.startsWith("{")) return walk(JSON.parse(v));
    return text(v);
  };
  return walk(value);
}

describe.skipIf(!ready)("built-in auth under server rendering, v2's ./ssr vs @bunvex/auth/ssr", () => {
  let c: Awaited<ReturnType<typeof scenario>>;
  let x: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    c = await scenario(await v2Side(convex));
    x = await scenario(await bunvexSide(bunvex));
  }, 300_000);

  test("every step: the same outcome", () => {
    expect(normalize(x.results)).toEqual(normalize(c.results));
  });

  test("every request to a route: the same status, body and cookies", () => {
    for (const name of Object.keys(c.log))
      expect({ step: name, exchanges: normalize(x.log[name]) }).toEqual({
        step: name,
        exchanges: normalize(c.log[name]),
      });
    expect(Object.keys(x.log)).toEqual(Object.keys(c.log));
  });

  test("the refresh token never reaches the page", () => {
    for (const exchange of Object.values(x.log).flat()) expect(exchange.body).not.toMatch(/refreshToken/);
  });
});

// The session's routes on the app's server (STUDY-202 §1.3–§1.6): upstream's `ssr/origin.test.ts`,
// `ssr/session.test.ts`, `ssr/handlers.test.ts`, `ssr/isAuthenticated.test.ts` and `ssr/signInProxy.test.ts` ported.
// Where upstream stubs the HTTP client or `fetch`, these run against a stand-in deployment over real HTTP, which records
// each call and answers what the test sets, so the wire (bunvex's `encoded_json` and `Bunvex-Client`) is checked too.
// The real deployment is in `packages/differential/test/auth-ssr.test.ts`.
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { BunvexHttpClient } from "@bunvex/client";
import { makeFunctionReference } from "@bunvex/server";
import type { IsAuthenticatedFn, RefreshResult, RefreshSessionFn, SignOutFn, TokenBundle } from "../src/lib/types.ts";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
} from "../src/ssr/cookies.ts";
import { refreshHandler, signOutHandler } from "../src/ssr/handlers.ts";
import { createServerAuthChecker } from "../src/ssr/isAuthenticated.ts";
import { isTrustedOrigin } from "../src/ssr/origin.ts";
import { type RefreshSession, ServerAuthSession } from "../src/ssr/session.ts";
import { bunvexProxyHandler, type ExposedSignInFn } from "../src/ssr/signInProxy.ts";

/** A response's JSON body, read as the test expects it. */
// biome-ignore lint/suspicious/noExplicitAny: the tests read the fields they assert
const json = (response: Response): Promise<any> => response.json();

/** A JWT, unsigned, whose payload has this expiry (seconds). */
function jwt(expSeconds: number, sub = "user-1"): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub, exp: expSeconds })}.sig`;
}

// "Now", fixed, so expiries are exact.
const NOW = 1_000_000; // seconds
const nowMs = NOW * 1000;

// The deployment as the routes reach it: each call recorded, each answered with what the test set.
type Recorded = {
  endpoint: string;
  headers: Record<string, string>;
  body: { path: string; format: string; args: unknown[] };
};
let reply: { status: number; body: unknown } = { status: 200, body: { status: "success", value: null, logLines: [] } };
const calls: Recorded[] = [];
const deployment = Bun.serve({
  port: 0,
  async fetch(request) {
    calls.push({
      endpoint: new URL(request.url).pathname,
      headers: Object.fromEntries(request.headers),
      body: (await request.json()) as Recorded["body"],
    });
    return Response.json(reply.body, { status: reply.status });
  },
});
const URL_ = `http://127.0.0.1:${deployment.port}`;
afterAll(() => deployment.stop(true));
beforeEach(() => {
  calls.length = 0;
  answer({ value: null });
});
afterEach(() => setSystemTime());

/** Answer the next calls with a function's success: `value`, and these log lines. */
function answer(success: { value: unknown; logLines?: string[] }) {
  reply = { status: 200, body: { status: "success", logLines: [], ...success } };
}
/** Answer the next calls with this body and status. */
function answerRaw(body: unknown, status: number) {
  reply = { status, body };
}

function bundle(n: number): TokenBundle {
  return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, refreshTokenExpiresAt: 2_000, userId: "user-1" };
}

const refreshSessionRef = makeFunctionReference<"mutation">("auth:refreshSession") as unknown as RefreshSessionFn;
const signOutRef = makeFunctionReference<"mutation">("auth:signOut") as unknown as SignOutFn;
const isAuthenticatedRef = makeFunctionReference<"query">("auth:isAuthenticated") as unknown as IsAuthenticatedFn;

describe("isTrustedOrigin", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://app.test/auth/refresh", { method: "POST", headers });

  test("trusts an Origin matching the Host header", () => {
    expect(isTrustedOrigin(request({ origin: "https://app.test", host: "app.test" }))).toBe(true);
  });

  test("host comparison includes the port", () => {
    expect(isTrustedOrigin(request({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(isTrustedOrigin(request({ origin: "http://localhost:4000", host: "localhost:3000" }))).toBe(false);
  });

  test("refuses a cross-site Origin", () => {
    expect(isTrustedOrigin(request({ origin: "https://evil.test", host: "app.test" }))).toBe(false);
  });

  test("refuses a subdomain of the Host", () => {
    expect(isTrustedOrigin(request({ origin: "https://sub.app.test", host: "app.test" }))).toBe(false);
  });

  test("refuses a missing Origin", () => {
    expect(isTrustedOrigin(request({ host: "app.test" }))).toBe(false);
  });

  test('refuses the literal "null" origin (sandboxed iframe)', () => {
    expect(isTrustedOrigin(request({ origin: "null", host: "app.test" }))).toBe(false);
  });

  test("refuses an unparseable Origin", () => {
    expect(isTrustedOrigin(request({ origin: "not a url", host: "app.test" }))).toBe(false);
  });

  test("trusts a configured allowed origin", () => {
    const req = request({ origin: "https://public.test", host: "internal" });
    expect(isTrustedOrigin(req, ["https://public.test"])).toBe(true);
    // A bare host works too.
    expect(isTrustedOrigin(req, ["public.test"])).toBe(true);
    expect(isTrustedOrigin(req, ["https://other.test"])).toBe(false);
  });

  test("trusts a configured localhost allowed origin", () => {
    const req = request({ origin: "http://localhost:3000", host: "http://app.test" });
    expect(isTrustedOrigin(req, ["http://localhost:3000"])).toBe(true);
    expect(isTrustedOrigin(req, ["localhost:3000"])).toBe(true);
    expect(isTrustedOrigin(req, ["http://localhost:5173"])).toBe(false);
  });
});

/** A cookie store in memory that keeps each cookie's attributes, and each deletion's. */
class FakeCookies implements CookieStore {
  values = new Map<string, string>();
  options = new Map<string, CookieOptions | undefined>();
  deletions = new Map<string, CookieDeleteOptions | undefined>();
  get(name: string) {
    return this.values.get(name);
  }
  set(name: string, value: string, options?: CookieOptions) {
    this.values.set(name, value);
    this.options.set(name, options);
  }
  delete(name: string, options?: CookieDeleteOptions) {
    this.values.delete(name);
    this.options.delete(name);
    this.deletions.set(name, options);
  }
}

describe("ServerAuthSession", () => {
  function tokens(n: number): TokenBundle {
    return {
      accessToken: jwt(NOW + 60),
      refreshToken: `refresh-${n}`,
      refreshTokenExpiresAt: nowMs + 30 * 24 * 3600 * 1000,
      userId: "user-1",
    };
  }
  const rotated = (b: TokenBundle): RefreshResult => ({ kind: "rotated", tokens: b });

  /** A refresh that records the tokens it was given. */
  function exchange(result: RefreshResult) {
    const given: string[] = [];
    const refreshSession: RefreshSession = async (refreshToken) => {
      given.push(refreshToken);
      return result;
    };
    return { given, refreshSession };
  }

  function newSession(
    refreshSession: RefreshSession,
    cookies = new FakeCookies(),
    cookieOptions: AuthCookieOptions = { secure: false },
  ) {
    return { session: new ServerAuthSession({ refreshSession, cookies, cookieOptions }), cookies };
  }

  beforeEach(() => setSystemTime(new Date(nowMs)));

  test("getToken returns a comfortably-valid cookie token without refreshing", async () => {
    const { given, refreshSession } = exchange(rotated(tokens(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 60));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);
    expect(await session.getToken()).toBe(jwt(NOW + 60));
    expect(given).toEqual([]);
  });

  test("getToken refreshes a near-expiry token and rewrites both cookies", async () => {
    const next = tokens(2);
    const { given, refreshSession } = exchange(rotated(next));
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5)); // within the 10 s skew
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);
    expect(await session.getToken()).toBe(next.accessToken);
    expect(given).toEqual(["refresh-1"]);
    expect(cookies.get(AUTH_JWT_COOKIE)).toBe(next.accessToken);
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBe("refresh-2");
    expect(cookies.options.get(AUTH_REFRESH_COOKIE)?.httpOnly).toBe(true);
  });

  test("getToken refreshes when the JWT cookie is missing", async () => {
    const { given, refreshSession } = exchange(rotated(tokens(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(refreshSession, cookies);
    expect(await session.getToken()).toBe(tokens(2).accessToken);
    expect(given).toHaveLength(1);
  });

  test("a noSession refresh clears both cookies and yields no token", async () => {
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(exchange({ kind: "noSession" }).refreshSession, cookies);
    expect(await session.getToken()).toBeNull();
    expect(cookies.get(AUTH_JWT_COOKIE)).toBeUndefined();
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBeUndefined();
  });

  test("clearing on a failed refresh deletes with the configured path and domain", async () => {
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(exchange({ kind: "noSession" }).refreshSession, cookies, {
      secure: false,
      path: "/app",
      domain: "example.com",
    });
    expect(await session.getToken()).toBeNull();
    for (const name of [AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE])
      expect(cookies.deletions.get(name)).toEqual({ path: "/app", domain: "example.com" });
  });

  test("getToken returns null when there is no refresh cookie", async () => {
    const { given, refreshSession } = exchange(rotated(tokens(2)));
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5)); // expiring, and nothing to refresh with
    const { session } = newSession(refreshSession, cookies);
    expect(await session.getToken()).toBeNull();
    expect(given).toEqual([]);
  });

  test("setTokens writes both cookies httpOnly", async () => {
    const { session, cookies } = newSession(exchange({ kind: "noSession" }).refreshSession);
    await session.setTokens(tokens(1));
    expect(cookies.get(AUTH_JWT_COOKIE)).toBe(tokens(1).accessToken);
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBe("refresh-1");
    expect(cookies.options.get(AUTH_JWT_COOKIE)?.httpOnly).toBe(true);
    expect(cookies.options.get(AUTH_REFRESH_COOKIE)?.httpOnly).toBe(true);
  });

  test("a failing exchange throws and leaves the cookies as they were", async () => {
    const cookies = new FakeCookies();
    cookies.set(AUTH_JWT_COOKIE, jwt(NOW + 5));
    cookies.set(AUTH_REFRESH_COOKIE, "refresh-1");
    const { session } = newSession(async () => {
      throw new Error("deployment down");
    }, cookies);
    await expect(session.getToken()).rejects.toThrow("deployment down");
    expect(cookies.get(AUTH_REFRESH_COOKIE)).toBe("refresh-1");
    expect(cookies.deletions.size).toBe(0);
  });
});

// Same-origin unless a test says otherwise: the Origin check refuses anything else before the handler's own logic.
const requestWithRefresh = (token?: string, headers?: Record<string, string>) =>
  new Request("https://app.test/auth/refresh", {
    method: "POST",
    headers: {
      origin: "https://app.test",
      host: "app.test",
      ...(token ? { cookie: `${AUTH_REFRESH_COOKIE}=${token}` } : {}),
      ...headers,
    },
  });

const refresh = (extra: { allowedOrigins?: string[] } = {}) =>
  refreshHandler({ bunvexUrl: URL_, refreshSession: refreshSessionRef, cookieOptions: { secure: false }, ...extra });
const signOut = () => signOutHandler({ bunvexUrl: URL_, signOut: signOutRef, cookieOptions: { secure: false } });

describe("refreshHandler", () => {
  test("rotates the session and returns access-only tokens", async () => {
    answer({ value: { kind: "rotated", tokens: bundle(2) } });
    const res = await refresh()(requestWithRefresh("refresh-1"));
    expect(res.status).toBe(200);
    const body = await json(res);
    // Access-only: no refresh token in the body.
    expect(body.tokens).toEqual({ accessToken: "access-2", userId: "user-1" });
    expect(calls.map((c) => [c.endpoint, c.body.path, c.body.args])).toEqual([
      ["/api/mutation", "auth:refreshSession", [{ refreshToken: "refresh-1" }]],
    ]);
    // Both cookies rewritten, both httpOnly.
    const lines = res.headers.getSetCookie();
    const access = lines.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refreshLine = lines.find((c) => c.startsWith(`${AUTH_REFRESH_COOKIE}=`));
    expect(access).toContain("access-2");
    expect(access).toContain("HttpOnly");
    expect(refreshLine).toContain("refresh-2");
    expect(refreshLine).toContain("HttpOnly");
  });

  test("with no refresh cookie replies 401 without calling the deployment", async () => {
    const res = await refresh()(requestWithRefresh());
    expect(res.status).toBe(401);
    expect((await json(res)).tokens).toBeNull();
    expect(calls).toEqual([]);
  });

  test("replies 401 and clears cookies when the refresh token is unknown", async () => {
    answer({ value: { kind: "noSession" } });
    const res = await refresh()(requestWithRefresh("stale"));
    expect(res.status).toBe(401);
    expect((await json(res)).tokens).toBeNull();
    expect(res.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("signOutHandler", () => {
  test("revokes and clears both cookies", async () => {
    answer({ value: null });
    const res = await signOut()(requestWithRefresh("refresh-1"));
    expect(res.status).toBe(200);
    expect((await json(res)).tokens).toBeNull();
    expect(calls.map((c) => [c.body.path, c.body.args])).toEqual([["auth:signOut", [{ refreshToken: "refresh-1" }]]]);
    expect(res.headers.getSetCookie().filter((c) => c.includes("Max-Age=0")).length).toBeGreaterThanOrEqual(2);
  });

  test("with no refresh cookie clears without calling the deployment", async () => {
    const res = await signOut()(requestWithRefresh());
    expect(res.status).toBe(200);
    expect((await json(res)).tokens).toBeNull();
    expect(calls).toEqual([]);
    expect(res.headers.getSetCookie().filter((c) => c.includes("Max-Age=0")).length).toBeGreaterThanOrEqual(2);
  });

  test("a refused revocation still clears the cookies", async () => {
    answerRaw({ status: "error", errorMessage: "gone", logLines: [] }, 560);
    const res = await signOut()(requestWithRefresh("refresh-1"));
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().filter((c) => c.includes("Max-Age=0"))).toHaveLength(2);
  });
});

// Both routes refuse a cross-site request before they call the deployment or touch a cookie. Sign-out matters most:
// it clears the cookies whatever the deployment says, so without the check another site could sign a user out.
describe("cross-site requests", () => {
  const crossSite = { origin: "https://evil.test", host: "app.test" };
  const sameSite = { origin: "https://app.test", host: "app.test" };

  test("refreshHandler refuses without calling the deployment or writing cookies", async () => {
    const res = await refresh()(requestWithRefresh("refresh-1", crossSite));
    expect(res.status).toBe(403);
    expect((await json(res)).tokens).toBeNull();
    expect(calls).toEqual([]);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("signOutHandler refuses without revoking or clearing cookies", async () => {
    const res = await signOut()(requestWithRefresh("refresh-1", crossSite));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("a same-site Origin is served", async () => {
    answer({ value: { kind: "rotated", tokens: bundle(2) } });
    const res = await refresh()(requestWithRefresh("refresh-1", sameSite));
    expect(res.status).toBe(200);
    expect((await json(res)).tokens).not.toBeNull();
  });

  test("allowedOrigins admits a cross-host but trusted Origin", async () => {
    answer({ value: { kind: "rotated", tokens: bundle(2) } });
    const res = await refresh({ allowedOrigins: ["https://public.test"] })(
      requestWithRefresh("refresh-1", { origin: "https://public.test", host: "internal:8080" }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).tokens).not.toBeNull();
  });
});

describe("createServerAuthChecker", () => {
  const checker = () => createServerAuthChecker({ bunvexUrl: URL_, isAuthenticated: isAuthenticatedRef });
  beforeEach(() => setSystemTime(new Date(nowMs)));

  test("a null token is unauthenticated without a round trip", async () => {
    expect(await checker()(null)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an expired token is rejected by the local gate without a round trip", async () => {
    expect(await checker()(jwt(NOW - 1))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a non-expired token is verified against the deployment, which accepts it", async () => {
    answer({ value: true });
    const token = jwt(NOW + 60);
    expect(await checker()(token)).toBe(true);
    // The deployment gets the token, to verify its signature and its session.
    expect(calls.map((c) => [c.endpoint, c.body.path, c.headers.authorization])).toEqual([
      ["/api/query", "auth:isAuthenticated", `Bearer ${token}`],
    ]);
  });

  test("a forged token with a future exp is rejected by the deployment", async () => {
    answer({ value: false });
    expect(await checker()(jwt(NOW + 60))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("fails closed to false when the deployment errors", async () => {
    answerRaw({ status: "error", errorMessage: "down", logLines: [] }, 560);
    expect(await checker()(jwt(NOW + 60))).toBe(false);
    answerRaw("bad gateway", 502);
    expect(await checker()(jwt(NOW + 60))).toBe(false);
  });
});

describe("bunvexProxyHandler", () => {
  const signIn = makeFunctionReference<"action">("auth:signInWithUsernamePassword") as unknown as ExposedSignInFn;
  const proxy = bunvexProxyHandler({ bunvexUrl: URL_, signIn: [signIn], cookieOptions: { secure: true } });

  /** A request as the HTTP client makes one, its endpoint in `path`; same-origin unless the test says otherwise. */
  const call = (body: unknown, opts: { kind?: string; headers?: Record<string, string> } = {}) =>
    new Request(`https://app.test/auth/proxy?path=/api/${opts.kind ?? "action"}`, {
      method: "POST",
      headers: { origin: "https://app.test", host: "app.test", "content-type": "application/json", ...opts.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const envelope = (args: unknown = {}) => ({
    path: "auth:signInWithUsernamePassword",
    format: "encoded_json",
    args: [args],
  });
  const tokensOf = () => ({
    accessToken: "access-1",
    refreshToken: "refresh-1",
    refreshTokenExpiresAt: 2_000,
    userId: "user-1",
  });
  const setCookies = (response: Response) => response.headers.getSetCookie().join("\n");

  describe("token interception", () => {
    test("moves the refresh token into an httpOnly cookie and slims the body", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() } });
      const response = await proxy(call(envelope()));
      expect(response.status).toBe(200);
      const body = await json(response);
      // The result's shape stays; only the refresh token is gone from it.
      expect(body.value.status).toBe("complete");
      expect(body.value.tokens).toEqual({ accessToken: "access-1", userId: "user-1" });
      expect(JSON.stringify(body)).not.toContain("refresh-1");
      const cookies = setCookies(response);
      expect(cookies).toContain(`${AUTH_REFRESH_COOKIE}=refresh-1`);
      expect(cookies).toContain(`${AUTH_JWT_COOKIE}=access-1`);
      expect(cookies).toContain("HttpOnly");
    });

    test("keeps the fields a method adds beside the bundle", async () => {
      // A passkey's `finishSignIn` returns the username with the tokens; only the refresh token is removed.
      answer({ value: { status: "complete", tokens: tokensOf(), username: "alice" } });
      const body = await json(await proxy(call(envelope())));
      expect(body.value.username).toBe("alice");
      expect(body.value.tokens.refreshToken).toBeUndefined();
    });

    test("passes a failure arm through untouched and writes no cookies", async () => {
      answer({ value: { status: "error", userError: { error: "INVALID_CREDENTIALS" } } });
      const response = await proxy(call(envelope()));
      expect((await json(response)).value).toEqual({ status: "error", userError: { error: "INVALID_CREDENTIALS" } });
      // A refused sign-in is a call that succeeded: 200, the reason in the result.
      expect(response.status).toBe(200);
      expect(setCookies(response)).toBe("");
    });

    test("refuses a challenge-minting function, which is why those bypass the proxy", async () => {
      // A passkey's `startSignIn`: not a sign-in result, so a method runs it on the backend client, not this route.
      answer({ value: { success: true, step: "register", rpId: "app.test" } });
      const response = await proxy(call(envelope()));
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("did not return a sign-in result");
    });

    test("refuses a status this handler does not know", async () => {
      // A method newer than the route: it does not guess, since forwarding an arm it cannot read is how a refresh
      // token would reach the page.
      answer({ value: { status: "requires-second-factor", challenge: "abc" } });
      const response = await proxy(call(envelope()));
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("did not return a sign-in result");
      expect(setCookies(response)).toBe("");
    });

    test("fails closed when an exposed function returns an unrecognized shape", async () => {
      // The dangerous one: forwarded, the refresh token would reach the page.
      answer({ value: tokensOf() });
      const response = await proxy(call(envelope()));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        "auth:signInWithUsernamePassword did not return a sign-in result. The sign-in functions must return the " +
          'shared envelope ({ status: "complete", tokens } or { status: "error", userError }).',
      );
      expect(setCookies(response)).toBe("");
    });
  });

  describe("what the proxy refuses", () => {
    test("a function that is not allowlisted", async () => {
      const response = await proxy(call({ ...envelope(), path: "auth:somethingElse" }));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("auth:somethingElse is not exposed through the auth proxy.");
      // Refused before the deployment hears of it.
      expect(calls).toEqual([]);
    });

    test("a cross-site request, before reading the body", async () => {
      const response = await proxy(call(envelope(), { headers: { origin: "https://evil.test" } }));
      expect(response.status).toBe(403);
      expect(calls).toEqual([]);
    });

    test("an unknown args encoding", async () => {
      for (const format of ["some_future_format", "convex_encoded_json", "json"]) {
        const response = await proxy(call({ ...envelope(), format }));
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Malformed function call.");
      }
      expect(calls).toEqual([]);
    });

    test("a path that is not a function endpoint", async () => {
      const response = await proxy(call(envelope(), { kind: "query_ts" }));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not an auth proxy endpoint.");
      expect(calls).toEqual([]);
    });

    test("a request that names no endpoint at all", async () => {
      const response = await proxy(
        new Request("https://app.test/auth/proxy", {
          method: "POST",
          headers: { origin: "https://app.test", host: "app.test" },
          body: JSON.stringify(envelope()),
        }),
      );
      expect(response.status).toBe(404);
      expect(calls).toEqual([]);
    });

    test("a malformed body", async () => {
      for (const body of ["not json", "[]", "null", JSON.stringify({ ...envelope(), args: [{}, {}] })]) {
        const response = await proxy(call(body));
        expect(response.status).toBe(400);
      }
      expect(calls).toEqual([]);
    });
  });

  describe("forwarding", () => {
    test("forwards args in the caller's encoding, and the caller's auth and client headers", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() } });
      await proxy(
        call(envelope({ username: "alice", password: "hunter2", n: { $integer: "AQAAAAAAAAA=" } }), {
          headers: { authorization: "Bearer caller-token", "bunvex-client": "npm-1.46.0" },
        }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.endpoint).toBe("/api/action");
      expect(calls[0]!.body).toEqual({
        path: "auth:signInWithUsernamePassword",
        format: "encoded_json",
        args: [{ username: "alice", password: "hunter2", n: { $integer: "AQAAAAAAAAA=" } }],
      });
      expect(calls[0]!.headers.authorization).toBe("Bearer caller-token");
      expect(calls[0]!.headers["bunvex-client"]).toBe("npm-1.46.0");
    });

    test("routes each endpoint to its counterpart on the deployment", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() } });
      for (const kind of ["query", "mutation", "action"]) await proxy(call(envelope(), { kind }));
      expect(calls.map((c) => c.endpoint)).toEqual(["/api/query", "/api/mutation", "/api/action"]);
    });

    test("never forwards the browser's cookies to the deployment", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() } });
      await proxy(call(envelope(), { headers: { cookie: `${AUTH_REFRESH_COOKIE}=refresh-0` } }));
      expect(Object.keys(calls[0]!.headers)).not.toContain("cookie");
    });

    test("forwards server log lines so a proxied call logs like a direct one", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() }, logLines: ["from the function's console.log"] });
      const body = await json(await proxy(call(envelope())));
      expect(body.logLines).toEqual(["from the function's console.log"]);
    });

    test("passes a thrown function's error through so the client rethrows it", async () => {
      answerRaw(
        { status: "error", errorMessage: "rate limited", errorData: { code: "RATE_LIMITED" }, logLines: [] },
        560,
      );
      const response = await proxy(call(envelope()));
      // 560 is "the function ran and threw" to the client; any other failing status, it throws the raw body.
      expect(response.status).toBe(560);
      expect(await json(response)).toMatchObject({ status: "error", errorData: { code: "RATE_LIMITED" } });
    });

    test("forwards a transport-level failure as-is", async () => {
      answerRaw({ nope: true }, 502);
      const response = await proxy(call(envelope()));
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('{"nope":true}');
    });
  });

  // The route relies on how the HTTP client talks to a deployment (the address it builds, the body, the 560): a change
  // there fails here rather than in an app.
  describe("the HTTP client's wire", () => {
    /** A client whose address is the route, its requests run through the proxy as from the app's own page. */
    function clientThroughProxy(posted: string[]) {
      return new BunvexHttpClient("/auth/proxy?path=", {
        skipDeploymentUrlCheck: true,
        logger: false,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          posted.push(url);
          return proxy(
            new Request(`https://app.test${url}`, {
              method: "POST",
              headers: { ...(init?.headers as Record<string, string>), origin: "https://app.test", host: "app.test" },
              body: init?.body as string,
            }),
          );
        }) as typeof fetch,
      });
    }

    test("a real client's request is one the proxy understands, and its reply parses", async () => {
      answer({ value: { status: "complete", tokens: tokensOf() } });
      const posted: string[] = [];
      const result = await clientThroughProxy(posted).action(
        makeFunctionReference<"action", { username: string }, unknown>("auth:signInWithUsernamePassword"),
        { username: "alice" },
      );
      // The endpoint went into the query string, so the route is one static path, not a catch-all.
      expect(posted).toEqual(["/auth/proxy?path=/api/action"]);
      expect(result).toEqual({ status: "complete", tokens: { accessToken: "access-1", userId: "user-1" } });
      expect(calls[0]!.headers["bunvex-client"]).toMatch(/^npm-/);
    });

    test("a thrown function surfaces to a real client as an error", async () => {
      answerRaw({ status: "error", errorMessage: "boom", logLines: [] }, 560);
      await expect(
        clientThroughProxy([]).action(
          makeFunctionReference<"action", Record<string, never>, unknown>("auth:signInWithUsernamePassword"),
          {},
        ),
      ).rejects.toThrow("boom");
    });
  });
});

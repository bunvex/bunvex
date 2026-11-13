// The Next.js auth example end to end: built with `next build`, served by `next start` against a deployment of its own,
// and driven as a browser drives it, with a cookie jar. A sign-up through the sign-in route, with the page's own HTTP
// client pointed at the route, returns the access token alone and sets both cookies httpOnly; the home page then
// renders the user on the server; signed out it redirects to the sign-in page, and the sign-in page home when signed
// in; the proxy refreshes a request that lost its access token; another site's requests are refused; signing out
// clears the cookies and ends the session.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexHttpClient } from "@bunvex/client";
import { build, type Deployment, deploy } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const PASSWORD = "correct horse battery staple";
let d: Deployment;
let next: Bun.Subprocess | undefined;
let base = "";

/** A port nothing listens on. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

beforeAll(async () => {
  d = await deploy(DIR);
  const env = { NEXT_PUBLIC_BUNVEX_URL: d.url, NEXT_TELEMETRY_DISABLED: "1" };
  await build(DIR, env);
  const port = freePort();
  base = `http://127.0.0.1:${port}`;
  next = Bun.spawn([process.execPath, "run", "start", "--", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: DIR,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let i = 0; ; i++) {
    const up = await fetch(`${base}/signin`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (next.exitCode !== null || i > 600)
      throw new Error(`next start did not start:\n${await new Response(next.stderr as ReadableStream).text()}`);
    await Bun.sleep(100);
  }
}, 300_000);
afterAll(async () => {
  next?.kill("SIGTERM");
  await next?.exited;
  await d?.stop();
});

/** A browser: its cookie jar, and requests from the app's own pages (their `Origin`). */
function browser() {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      if (/; Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf("=") + 1));
    }
    return response;
  };
  const request = async (path: string, init: RequestInit = {}) =>
    keep(
      await fetch(new URL(path, base), {
        redirect: "manual",
        ...init,
        headers: {
          origin: base,
          ...(jar.size > 0 && { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }),
          ...(init.headers as Record<string, string>),
        },
      }),
    );
  const lines: string[] = [];
  // The page's HTTP client, its address the sign-in route, as the Next.js provider makes it.
  const signInClient = new BunvexHttpClient(`${base}/auth/signin?path=`, {
    logger: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await request(String(input), { method: "POST", ...init });
      lines.push(...response.headers.getSetCookie());
      return response;
    }) as typeof fetch,
  });
  return { jar, request, signInClient, setCookieLines: lines };
}

test("a sign-up through the sign-in route: the access token alone in the page, both tokens in httpOnly cookies", async () => {
  const page = browser();
  const result = await page.signInClient.mutation(api.auth.signUpWithUsernamePassword, {
    username: "ada",
    password: PASSWORD,
  });
  expect(result.status).toBe("complete");
  expect(Object.keys((result as { tokens: object }).tokens).sort()).toEqual(["accessToken", "userId"]);
  expect([...page.jar.keys()].sort()).toEqual(["__bunvexAuthJWT", "__bunvexAuthRefreshToken"]);
  for (const line of page.setCookieLines) {
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    // `next start` runs in production: HTTPS only.
    expect(line).toContain("Secure");
  }
});

test("pages: rendered signed in on the server, redirected when signed out, the sign-in page skipped when signed in", async () => {
  const signedOut = browser();
  const away = await signedOut.request("/");
  expect(away.status).toBe(307);
  expect(new URL(away.headers.get("location")!, base).pathname).toBe("/signin");

  const page = browser();
  await page.signInClient.mutation(api.auth.signUpWithUsernamePassword, { username: "grace", password: PASSWORD });
  const home = await page.request("/");
  expect(home.status).toBe(200);
  // In the HTML from the server, before any client JavaScript runs.
  expect(await home.text()).toMatch(/data-testid="user">grace</);
  const signIn = await page.request("/signin");
  expect(signIn.status).toBe(307);
  expect(new URL(signIn.headers.get("location")!, base).pathname).toBe("/");
});

test("the proxy refreshes a request without an access token, and the page renders signed in", async () => {
  const page = browser();
  await page.signInClient.mutation(api.auth.signUpWithUsernamePassword, { username: "linus", password: PASSWORD });
  const refreshToken = page.jar.get("__bunvexAuthRefreshToken")!;
  page.jar.delete("__bunvexAuthJWT");
  const home = await page.request("/");
  expect(home.status).toBe(200);
  expect(await home.text()).toMatch(/data-testid="user">linus</);
  // Both rotated, on the page's own response.
  expect(page.jar.get("__bunvexAuthJWT")).toBeDefined();
  expect(page.jar.get("__bunvexAuthRefreshToken")).not.toBe(refreshToken);
});

test("the refresh route rotates the session; another site's requests are refused", async () => {
  const page = browser();
  await page.signInClient.mutation(api.auth.signUpWithUsernamePassword, { username: "alan", password: PASSWORD });
  const refreshed = await page.request("/auth/refresh", { method: "POST", body: "{}" });
  expect(refreshed.status).toBe(200);
  const body = (await refreshed.json()) as { tokens: Record<string, string> };
  expect(Object.keys(body.tokens).sort()).toEqual(["accessToken", "userId"]);
  expect(await (await page.request("/")).text()).toMatch(/data-testid="user">alan</);
  for (const route of ["/auth/signin?path=/api/mutation", "/auth/refresh", "/auth/signout"]) {
    const refused = await page.request(route, { method: "POST", body: "{}", headers: { origin: "https://evil.test" } });
    expect({ route, status: refused.status }).toEqual({ route, status: 403 });
    expect(refused.headers.getSetCookie()).toEqual([]);
  }
});

test("signing out clears the cookies and ends the session", async () => {
  const page = browser();
  await page.signInClient.mutation(api.auth.signUpWithUsernamePassword, { username: "barbara", password: PASSWORD });
  const kept = new Map(page.jar);
  const out = await page.request("/auth/signout", { method: "POST", body: "{}" });
  expect(out.status).toBe(200);
  expect(page.jar.size).toBe(0);
  // The old cookies, replayed: the session is gone, so the page sends them to sign in.
  for (const [k, v] of kept) page.jar.set(k, v);
  const away = await page.request("/");
  expect(away.status).toBe(307);
  expect(new URL(away.headers.get("location")!, base).pathname).toBe("/signin");
});

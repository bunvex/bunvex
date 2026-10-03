// The Next.js helpers (@bunvex/nextjs) against a real bunvex server (STUDY-46): fetchQuery / fetchMutation /
// fetchAction over the HTTP client with `cache: "no-store"`, the deployment URL and its errors, and preloadQuery's
// payload, checked against the official `convex/nextjs` on the same server.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import { fetchAction, fetchMutation, fetchQuery, preloadedQueryResult, preloadQuery } from "@bunvex/nextjs";
import type { BunvexError } from "@bunvex/values";
import * as oracle from "convex/nextjs";
import { anyApi as oracleApi } from "convex/server";
import { startServer } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const h = await startServer();
  cleanup.push(h.stop);
  // Every request the helpers make, as `fetch` saw it.
  const requests: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation(((url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return realFetch(url, init);
  }) as typeof fetch);
  cleanup.push(() => spy.mockRestore());
  return { h, requests };
}

/** Run `f` with `NEXT_PUBLIC_BUNVEX_URL` set to `value` (or unset), then put it back. */
async function withEnv<T>(value: string | undefined, f: () => Promise<T>): Promise<T> {
  const before = process.env.NEXT_PUBLIC_BUNVEX_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_BUNVEX_URL;
  else process.env.NEXT_PUBLIC_BUNVEX_URL = value;
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_BUNVEX_URL;
    else process.env.NEXT_PUBLIC_BUNVEX_URL = before;
  }
}

describe("@bunvex/nextjs", () => {
  test("fetchQuery, fetchMutation, fetchAction: each call over HTTP with cache: no-store", async () => {
    const { h, requests } = await setup();
    const url = h.url;
    expect(await fetchQuery(api.messages.count, {}, { url })).toBe(0);
    expect(await fetchQuery(api.messages.count, undefined, { url })).toBe(0);
    expect(await fetchMutation(api.messages.send, { body: "hi" }, { url })).toBe("HI");
    expect(await fetchQuery(api.messages.list, {}, { url })).toEqual(["hi"]);
    expect(await fetchAction(api.messages.echo, { x: 5n }, { url })).toBe(5n);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/query",
      "/api/query",
      "/api/mutation",
      "/api/query",
      "/api/action",
    ]);
    for (const r of requests) expect(r.init.cache).toBe("no-store");
  });

  test("a function's error rejects with its data", async () => {
    const { h } = await setup();
    const e = (await fetchMutation(api.messages.fail, {}, { url: h.url }).catch((x) => x)) as BunvexError<{
      code: string;
      n: bigint;
    }>;
    expect(e.data).toEqual({ code: "nope", n: 7n });
  });

  test("token is sent as Bearer; adminToken as the admin header", async () => {
    const { h, requests } = await setup();
    await fetchQuery(api.messages.count, {}, { url: h.url, token: "the-token" }).catch(() => {});
    await fetchQuery(api.messages.count, {}, { url: h.url, adminToken: "the-key" }).catch(() => {});
    const auth = requests.map((r) => (r.init.headers as Record<string, string>).Authorization);
    expect(auth).toEqual(["Bearer the-token", "Bunvex the-key"]);
  });

  test("the URL: NEXT_PUBLIC_BUNVEX_URL by default, `url` over it, and Convex's errors", async () => {
    const { h, requests } = await setup();
    expect(await withEnv(h.url, () => fetchQuery(api.messages.count))).toBe(0);
    expect(await withEnv("http://127.0.0.1:1", () => fetchQuery(api.messages.count, {}, { url: h.url }))).toBe(0);
    expect(requests.map((r) => r.url)).toEqual([`${h.url}/api/query`, `${h.url}/api/query`]);
    await withEnv(undefined, async () => {
      await expect(fetchQuery(api.messages.count)).rejects.toThrow(
        "Environment variable NEXT_PUBLIC_BUNVEX_URL is not set.",
      );
      await expect(fetchQuery(api.messages.count, {}, { url: 7 as unknown as string })).rejects.toThrow(
        "Function called with invalid deployment address.",
      );
    });
    // An explicit `url: undefined` (an unset variable passed along) warns, then uses the default.
    const error = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => error.mockRestore());
    expect(await withEnv(h.url, () => fetchQuery(api.messages.count, {}, { url: undefined }))).toBe(0);
    expect(error.mock.calls).toEqual([
      [
        "deploymentUrl is undefined, are your environment variables set? In the future explicitly passing undefined will cause an error. To explicitly use the default, pass `process.env.NEXT_PUBLIC_BUNVEX_URL`.",
      ],
    ]);
    // The address is checked unless skipDeploymentUrlCheck.
    await expect(fetchQuery(api.messages.count, {}, { url: "localhost:1" })).rejects.toThrow(
      'Invalid deployment address: Must start with "https://" or "http://". Found "localhost:1".',
    );
    const skipped = await fetchQuery(
      api.messages.count,
      {},
      { url: "localhost:1", skipDeploymentUrlCheck: true },
    ).catch((e: Error) => e.message);
    expect(skipped).not.toContain("Invalid deployment address");
  });

  test("preloadQuery: the same payload as convex/nextjs; preloadedQueryResult decodes it", async () => {
    const { h } = await setup();
    const args = { x: { n: 1234567890123456789n, b: new Uint8Array([1, 2, 255]).buffer, f: 1.5 } };
    const preloaded = await preloadQuery(api.messages.echoQuery, args, { url: h.url });
    const theirs = await oracle.preloadQuery(oracleApi.messages.echoQuery, args, {
      url: h.url,
      skipConvexDeploymentUrlCheck: true,
    });
    expect(preloaded as unknown).toEqual(theirs as unknown);
    expect(preloaded._name).toBe("messages:echoQuery");
    expect(preloaded._argsJSON as unknown).toEqual({
      x: { n: { $integer: expect.any(String) }, b: { $bytes: "AQL/" }, f: 1.5 },
    });
    expect(preloadedQueryResult(preloaded)).toEqual(args.x);
    // No arguments: `{}`, as Convex.
    const none = await preloadQuery(api.messages.count, undefined, { url: h.url });
    expect(none as unknown).toEqual({ _name: "messages:count", _argsJSON: {}, _valueJSON: 0 });
  });
});

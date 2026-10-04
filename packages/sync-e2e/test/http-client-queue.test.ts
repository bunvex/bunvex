// The HTTP client's mutation queue and its fetch (STUDY-65 G-C18, G-C19), as Convex's
// `browser/http_client.test.ts` checks them: a failed mutation does not block the ones queued after it, and a
// client's own `fetch` wins over a module-level one and the global one. Differential: each case runs with
// BunvexHttpClient and with the official ConvexHttpClient (the oracle), over the same fetch stand-in.
import { describe, expect, test } from "bun:test";
import { anyApi, BunvexHttpClient, setFetch } from "@bunvex/client";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as oracleApi } from "convex/server";

type Fetch = typeof globalThis.fetch;
type AnyHttpClient = { mutation(ref: unknown, args: object): Promise<unknown> };
const quiet = { log() {}, warn() {}, error() {}, logVerbose() {} };
const clients: [string, (fetch?: Fetch) => AnyHttpClient, unknown][] = [
  [
    "BunvexHttpClient",
    (fetch) => new BunvexHttpClient("http://test", { logger: quiet, ...(fetch ? { fetch } : {}) }) as never,
    anyApi.test.mutation,
  ],
  [
    "official ConvexHttpClient",
    (fetch) =>
      new ConvexHttpClient("http://test", {
        logger: quiet,
        skipConvexDeploymentUrlCheck: true,
        ...(fetch ? { fetch } : {}),
      } as never) as never,
    oracleApi.test.mutation,
  ],
];

const answer = (body: object) =>
  new Response(JSON.stringify({ logLines: [], ...body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

for (const [name, make, mutation] of clients)
  describe(name, () => {
    test("a failed mutation does not block the queue (G-C18)", async () => {
      const calls: string[] = [];
      let resolveSecond!: (r: Response) => void;
      const fetch = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { path: string; args: { value: string }[] };
        calls.push(body.args[0]!.value);
        if (body.args[0]!.value === "first") return answer({ status: "error", errorMessage: "First mutation failed" });
        return new Promise<Response>((r) => {
          resolveSecond = r;
        });
      }) as unknown as Fetch;
      const client = make(fetch);
      const first = client.mutation(mutation, { value: "first" });
      const second = client.mutation(mutation, { value: "second" });
      await expect(first).rejects.toThrow("First mutation failed");
      for (let i = 0; i < 100 && calls.length < 2; i++) await Bun.sleep(1);
      expect(calls).toEqual(["first", "second"]);
      resolveSecond(answer({ status: "success", value: "second result" }));
      expect(await second).toBe("second result");
    });

    test("the client's own fetch wins over the global one (G-C19)", async () => {
      const used: string[] = [];
      const own = (async () => {
        used.push("own");
        return answer({ status: "success", value: "own fetch result" });
      }) as unknown as Fetch;
      const global = globalThis.fetch;
      globalThis.fetch = (async () => {
        used.push("global");
        return answer({ status: "success", value: "global fetch result" });
      }) as unknown as Fetch;
      try {
        expect(await make(own).mutation(mutation, { value: "x" })).toBe("own fetch result");
        expect(await make().mutation(mutation, { value: "x" })).toBe("global fetch result");
      } finally {
        globalThis.fetch = global;
      }
      expect(used).toEqual(["own", "global"]);
    });
  });

// bunvex exports `setFetch` (Convex's is module-internal): a client's own fetch wins over it, and it over the
// global one.
test("BunvexHttpClient: own fetch, then setFetch, then the global one (G-C19)", async () => {
  const used: string[] = [];
  const fetchNamed = (n: string) =>
    (async () => {
      used.push(n);
      return answer({ status: "success", value: n });
    }) as unknown as Fetch;
  setFetch(fetchNamed("module"));
  try {
    expect(
      await new BunvexHttpClient("http://test", { fetch: fetchNamed("own") }).mutation(anyApi.test.mutation, {}),
    ).toBe("own");
    expect(await new BunvexHttpClient("http://test").mutation(anyApi.test.mutation, {})).toBe("module");
  } finally {
    setFetch(undefined as never);
  }
  expect(used).toEqual(["own", "module"]);
});

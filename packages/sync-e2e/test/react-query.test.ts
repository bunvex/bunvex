// The TanStack Query integration on the server (STUDY-55): no `window` here, so `BunvexQueryClient` reads over
// HTTP, every query of a render at one snapshot (or each at the latest when inconsistent), and never subscribes.
// The official `@convex-dev/react-query` runs the same prefetches against the same server.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { anyApi, BunvexHttpClient } from "@bunvex/client";
import { BunvexQueryClient, bunvexAction, bunvexQuery } from "@bunvex/react-query";
import { ConvexQueryClient, convexQuery } from "@convex-dev/react-query";
import { dehydrate, hashKey, QueryClient } from "@tanstack/react-query";
import { anyApi as oracleApi } from "convex/server";
import { renameFormat, startServer } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(options: { dangerouslyUseInconsistentQueriesDuringSSR?: boolean } = {}) {
  const h = await startServer();
  cleanup.push(h.stop);
  const paths: string[] = [];
  const realFetch = renameFormat(globalThis.fetch); // Convex's clients run here too (DV-307)
  const spy = spyOn(globalThis, "fetch").mockImplementation(((url: string, init: RequestInit) => {
    paths.push(new URL(String(url)).pathname);
    return realFetch(url, init);
  }) as typeof fetch);
  cleanup.push(() => spy.mockRestore());
  const bunvex = new BunvexQueryClient(h.url, { logger: false, ...options });
  cleanup.push(() => bunvex.bunvexClient.close());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { queryFn: bunvex.queryFn(), queryKeyHashFn: bunvex.hashFn(), retry: false } },
  });
  bunvex.connect(queryClient);
  // Writes from elsewhere, between the prefetches of one render.
  const other = new BunvexHttpClient(h.url, { logger: false });
  return { h, bunvex, queryClient, paths, other };
}

describe("@bunvex/react-query on the server", () => {
  test("prefetches over HTTP at one snapshot; nothing subscribes; dehydrate holds the values", async () => {
    const { bunvex, queryClient, paths, other } = await setup();
    await queryClient.prefetchQuery(bunvexQuery(api.messages.count));
    await other.mutation(api.messages.send, { body: "later" });
    await queryClient.prefetchQuery(bunvexQuery(api.messages.list));
    // The list is read at the count's snapshot: it does not see the later write.
    expect(queryClient.getQueryData<unknown>(bunvexQuery(api.messages.count).queryKey)).toBe(0);
    expect(queryClient.getQueryData<unknown>(bunvexQuery(api.messages.list).queryKey)).toEqual([]);
    expect(paths.filter((p) => p !== "/api/mutation")).toEqual([
      "/api/query_ts",
      "/api/query_at_ts",
      "/api/query_at_ts",
    ]);
    expect(Object.keys(bunvex.subscriptions)).toEqual([]);
    const state = dehydrate(queryClient);
    expect(state.queries.map((q) => [q.queryHash, q.state.data])).toEqual([
      ["bunvexQuery|messages:count|{}", 0],
      ["bunvexQuery|messages:list|{}", []],
    ]);
  });

  test("dangerouslyUseInconsistentQueriesDuringSSR: each query at the latest", async () => {
    const { queryClient, paths, other } = await setup({ dangerouslyUseInconsistentQueriesDuringSSR: true });
    await queryClient.prefetchQuery(bunvexQuery(api.messages.count));
    await other.mutation(api.messages.send, { body: "later" });
    await queryClient.prefetchQuery(bunvexQuery(api.messages.list));
    expect(queryClient.getQueryData<unknown>(bunvexQuery(api.messages.list).queryKey)).toEqual(["later"]);
    expect(paths.filter((p) => p !== "/api/mutation")).toEqual(["/api/query", "/api/query"]);
  });

  test("args in the key are JSON-encoded: a bigint and bytes survive dehydration as JSON (R3)", async () => {
    const { queryClient } = await setup();
    const x = { n: 1234567890123456789n, b: new Uint8Array([1, 2, 255]).buffer };
    const options = bunvexQuery(api.messages.echoQuery, { x });
    expect(options.queryKey as unknown).toEqual([
      "bunvexQuery",
      "messages:echoQuery",
      { x: { n: { $integer: expect.any(String) }, b: { $bytes: "AQL/" } } },
    ]);
    await queryClient.prefetchQuery(options);
    expect(queryClient.getQueryData<unknown>(options.queryKey)).toEqual(x);
    // Plain JSON args make the same key as Convex's.
    expect(bunvexQuery(api.messages.echoQuery, { x: { a: [1, "s", null] } }).queryKey as unknown).toEqual([
      "bunvexQuery",
      "messages:echoQuery",
      { x: { a: [1, "s", null] } },
    ]);
    expect(() => JSON.stringify(dehydrate(queryClient).queries.map((q) => q.queryKey))).not.toThrow();
  });

  test("actions as queries; skip; queryFn and hashFn for other keys; connect twice", async () => {
    const { bunvex, queryClient } = await setup();
    expect(await queryClient.fetchQuery(bunvexAction(api.messages.echo, { x: 3n }))).toBe(3n);
    expect(bunvexQuery(api.messages.count, "skip")).toEqual({
      queryKey: ["bunvexQuery", "messages:count", "skip"],
      staleTime: Number.POSITIVE_INFINITY,
      enabled: false,
    } as never);
    const fn = bunvex.queryFn();
    const context = (queryKey: unknown[]) => ({ queryKey }) as never;
    await expect(fn(context(["bunvexQuery", "messages:count", "skip"]))).rejects.toThrow(
      "Skipped query should not actually be run, should { enabled: false }",
    );
    await expect(fn(context(["todos", 1]))).rejects.toThrow("Query key is not for a bunvex query: todos,1");
    expect(await bunvex.queryFn(async () => "other")(context(["todos", 1]))).toBe("other");
    const hash = bunvex.hashFn();
    expect(hash(["bunvexQuery", "messages:count", {}])).toBe("bunvexQuery|messages:count|{}");
    expect(hash(["todos", { b: 1, a: 2 }])).toBe(hashKey(["todos", { b: 1, a: 2 }]));
    expect(() => bunvex.connect(queryClient)).toThrow("already subscribed!");
    expect(() => new BunvexQueryClient(bunvex.bunvexClient).queryClient).toThrow(
      "BunvexQueryClient not connected to TanStack QueryClient.",
    );
  });

  test("oracle: @convex-dev/react-query prefetches the same values with the same requests", async () => {
    const { h, queryClient, paths, other } = await setup();
    const theirs = new ConvexQueryClient(h.url, { skipConvexDeploymentUrlCheck: true, logger: false });
    cleanup.push(() => theirs.convexClient.close());
    const theirCache = new QueryClient({
      defaultOptions: { queries: { queryFn: theirs.queryFn(), queryKeyHashFn: theirs.hashFn(), retry: false } },
    });
    theirs.connect(theirCache);
    await other.mutation(api.messages.send, { body: "a" });
    paths.length = 0;
    await queryClient.prefetchQuery(bunvexQuery(api.messages.list));
    await queryClient.prefetchQuery(bunvexQuery(api.messages.echoQuery, { x: { n: 5 } }));
    const ours = paths.splice(0);
    expect(ours).toEqual(["/api/query_ts", "/api/query_at_ts", "/api/query_at_ts"]);
    await theirCache.prefetchQuery(convexQuery(oracleApi.messages.list, {}));
    await theirCache.prefetchQuery(convexQuery(oracleApi.messages.echoQuery, { x: { n: 5 } }));
    expect(paths).toEqual(ours);
    expect(dehydrate(queryClient).queries.map((q) => q.state.data)).toEqual([["a"], { n: 5 }]);
    expect(dehydrate(theirCache).queries.map((q) => q.state.data)).toEqual(
      dehydrate(queryClient).queries.map((q) => q.state.data),
    );
    // The hashes differ only by the prefix (R2).
    expect(dehydrate(theirCache).queries.map((q) => q.queryHash.replace(/^convexQuery/, "bunvexQuery"))).toEqual(
      dehydrate(queryClient).queries.map((q) => q.queryHash),
    );
  });
});

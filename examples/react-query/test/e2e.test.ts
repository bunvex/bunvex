// The TanStack Query example end to end (STUDY-90). There is no `window` here, so `BunvexQueryClient` takes its
// server path (a Server Component's): prefetches over HTTP, every query of one render at one snapshot. The live
// path is the functions' own subscription, checked through the client.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { BunvexQueryClient, bunvexQuery } from "@bunvex/react-query";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { BunvexReactClient } from "bunvex/react";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("server rendering: prefetch into a QueryClient, then dehydrate", async () => {
  await d.http.mutation(api.messages.send, { body: "hi", author: "Ada" });
  const bunvex = new BunvexQueryClient(new BunvexReactClient(d.url, { logger: false }));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { queryKeyHashFn: bunvex.hashFn(), queryFn: bunvex.queryFn(), retry: false } },
  });
  bunvex.connect(queryClient);
  try {
    await queryClient.prefetchQuery(bunvexQuery(api.messages.list, {}));
    const state = dehydrate(queryClient);
    expect(state.queries.map((q) => q.queryHash)).toEqual(["bunvexQuery|messages:list|{}"]);
    expect((state.queries[0]!.state.data as { body: string }[]).map((m) => m.body)).toEqual(["hi"]);
  } finally {
    await bunvex.bunvexClient.close();
  }
});

test("the list follows new messages live", async () => {
  let latest: { body: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest?.length === 1, "the first result");
  await d.http.mutation(api.messages.send, { body: "hello", author: "Grace" });
  const after = await until(() => latest?.length === 2 && latest, "the new message");
  expect(after.map((m) => m.body)).toEqual(["hi", "hello"]);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

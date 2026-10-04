// The Next.js App Router example end to end (STUDY-90): its functions through the client and through
// `bunvex/nextjs` as its Server Components call them, and `next build` (which loads bunvex's packages in Node:
// STUDY-91's isomorphic `bunvex/server`).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fetchMutation, fetchQuery, preloadedQueryResult, preloadQuery } from "bunvex/nextjs";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("a counter: the server reads it, a client follows it live", async () => {
  const url = d.url;
  const preloaded = await preloadQuery(api.counters.get, { name: "clicks" }, { url });
  expect(preloadedQueryResult(preloaded)).toBe(0);
  let live: number | undefined;
  d.client().onUpdate(api.counters.get, { name: "clicks" }, (n) => {
    live = n;
  });
  await until(() => live === 0, "the first value");
  await d.http.mutation(api.counters.increment, { name: "clicks" });
  await d.http.mutation(api.counters.increment, { name: "clicks" });
  await until(() => live === 2, "two increments");
  // A Server Action's path: fetchMutation, then fetchQuery.
  await fetchMutation(api.counters.increment, { name: "server-only" }, { url });
  expect(await fetchQuery(api.counters.get, { name: "server-only" }, { url })).toBe(1);
  expect(await fetchQuery(api.counters.get, { name: "clicks" }, { url })).toBe(2);
});

test(
  "the front end typechecks and builds",
  () => build(DIR, { NEXT_PUBLIC_BUNVEX_URL: d.url, NEXT_TELEMETRY_DISABLED: "1" }),
  120_000,
);

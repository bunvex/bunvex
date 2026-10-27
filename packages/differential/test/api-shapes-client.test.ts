// The client side's references, against `convex` 1.48.0's types: every API 1.48 widens to take a
// `FunctionReference_future` as well as a `FunctionReference` takes one on bunvex too, typed by its `_fn` — the React
// hooks and client (`useQuery`, `useMutation`, `useAction`, `usePreloadedQuery`, `useQueries`, `watchQuery`,
// `prewarmQuery`, `mutation`, `action`, `query`), the browser and HTTP clients, optimistic updates' local store,
// `QueryOptions`, and `bunvex/nextjs`'s `fetchQuery` / `fetchMutation` / `fetchAction` / `preloadQuery`. Checked by
// `tsc` (`bun run typecheck` compiles this file); `takesFutures` is never run. The runtime test is a placeholder.
import { expect, test } from "bun:test";
import type * as bb from "bunvex/browser";
import * as bn from "bunvex/nextjs";
import * as br from "bunvex/react";
import type * as b from "bunvex/server";
import type * as cb from "convex/browser";
import type * as cr from "convex/react";
import type * as c from "convex/server";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const check = <T extends true>(_: T) => {};

type BQuery = b.FunctionReference_future<"query", "public", { a: number }, string>;
type CQuery = c.FunctionReference_future<"query", "public", { a: number }, string>;
type BMutation = b.FunctionReference_future<"mutation", "public", { id: string }, null>;
type BAction = b.FunctionReference_future<"action", "public", Record<string, never>, number>;

// The types that carry a reference's arguments read a future one's `_fn`, as Convex's.
check<Equal<br.OptionalRestArgsOrSkip<BQuery>, cr.OptionalRestArgsOrSkip<CQuery>>>(true);
check<Equal<keyof bb.QueryOptions<BQuery>, keyof cb.QueryOptions<CQuery>>>(true);
check<Equal<bb.QueryOptions<BQuery>["args"], cb.QueryOptions<CQuery>["args"]>>(true);
check<Equal<br.Preloaded<BQuery>["_argsJSON"], cr.Preloaded<CQuery>["_argsJSON"]>>(true);

// biome-ignore lint/correctness/noUnusedVariables: checked by `tsc`, never run
async function takesFutures(
  q: BQuery,
  m: BMutation,
  a: BAction,
  react: br.BunvexReactClient,
  browser: bb.BunvexClient,
  http: bb.BunvexHttpClient,
  preloaded: br.Preloaded<BQuery>,
) {
  // React.
  const s: string | undefined = br.useQuery(q, { a: 1 });
  const skipped: string | undefined = br.useQuery(q, "skip");
  const mutate = br.useMutation(m).withOptimisticUpdate((store, args) => {
    const id: string = args.id;
    const current: string | undefined = store.getQuery(q, { a: 1 });
    store.setQuery(q, { a: 1 }, `${current}${id}`);
    for (const { args: qa, value } of store.getAllQueries(q)) void [qa.a, value];
  });
  const n: null = await mutate({ id: "x" });
  const k: number = await br.useAction(a)();
  const p: string = br.usePreloadedQuery(preloaded);
  br.useQueries({ one: { query: q, args: { a: 1 } } });
  react.watchQuery(q, { a: 1 }).localQueryResult();
  react.prewarmQuery({ query: q, args: { a: 1 } });
  const viaClient: [string, null, number] = [
    await react.query(q, { a: 1 }),
    await react.mutation(m, { id: "x" }),
    await react.action(a),
  ];
  // The browser and HTTP clients.
  browser.onUpdate(q, { a: 1 }, (r: string) => r);
  const viaBrowser: [string, null, number] = [
    await browser.query(q, { a: 1 }),
    await browser.mutation(m, { id: "x" }),
    await browser.action(a, {}),
  ];
  const viaHttp: [string, null, number] = [
    await http.query(q, { a: 1 }),
    await http.mutation(m, { id: "x" }),
    await http.action(a),
  ];
  // `bunvex/nextjs`.
  const viaNext: [string, null, number] = [
    await bn.fetchQuery(q, { a: 1 }),
    await bn.fetchMutation(m, { id: "x" }),
    await bn.fetchAction(a),
  ];
  await bn.preloadQuery(q, { a: 1 });
  // @ts-expect-error a future reference's arguments are checked
  br.useQuery(q, { a: "one" });
  // @ts-expect-error as above
  await browser.mutation(m, { id: 1 });
  return [s, skipped, n, k, p, viaClient, viaBrowser, viaHttp, viaNext];
}

test("the client side's references are checked by tsc", () => {
  expect(typeof br.useQuery).toBe("function");
});

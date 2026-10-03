// BunvexClient.onPaginatedUpdate_experimental against a real bunvex server (STUDY-26 §8.4): the loaded pages as
// one list, `loadMore`, exhaustion, live growth and page splits, checked step by step against the official
// client's `onPaginatedUpdate_experimental` on the same server.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient, type PaginatedQueryResult } from "@bunvex/client";
import { ConvexClient } from "convex/browser";
import { anyApi as oracleApi } from "convex/server";
import { startServer, until } from "./harness.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Result = PaginatedQueryResult<{ body: string }>;
type Paginated = (
  args: Record<string, unknown>,
  initialNumItems: number,
  onResult: (r: Result) => unknown,
  onError?: (e: Error) => unknown,
) => (() => void) & { getCurrentValue(): Result | undefined };

async function setup(n: number) {
  const h = await startServer();
  cleanup.push(h.stop);
  const c = new BunvexClient(h.url, { logger: false });
  cleanup.push(() => c.close());
  // m0 … m{n-1}, oldest first: `paged` lists them newest first.
  if (n > 0) await c.mutation(api.messages.sendMany, { prefix: "m", n });
  return { h, c };
}

/** The same steps for any client: what `onPaginatedUpdate_experimental` reported at each one. */
async function scenario(paginated: Paginated, send: (body: string) => Promise<unknown>) {
  const seen: Result[] = [];
  const last = () => seen[seen.length - 1];
  const snap = () => ({ status: last().status, bodies: last().results.map((m) => m.body) });
  const steps: unknown[] = [];
  const unsubscribe = paginated({}, 3, (r) => seen.push(r));
  await until(() => seen.length > 0, "first result");
  // Soon after subscribing, before or after the first page arrives (timing): "LoadingFirstPage" or the page.
  steps.push(["first callback", ["LoadingFirstPage", "CanLoadMore"].includes(seen[0].status)]);
  await until(() => last().status === "CanLoadMore", "first page");
  steps.push(snap());
  steps.push(["loadMore", last().loadMore(3)]);
  steps.push(["status right after loadMore", last().status]);
  await until(() => last().results.length === 6 && last().status === "CanLoadMore", "second page");
  steps.push(snap());
  steps.push(["loadMore", last().loadMore(3)]);
  await until(() => last().status === "Exhausted", "exhausted");
  steps.push(snap());
  steps.push(["loadMore when exhausted", last().loadMore(3)]);
  await send("new");
  await until(() => last().results.length === 8, "growth");
  steps.push(snap());
  steps.push(["getCurrentValue", unsubscribe.getCurrentValue()?.results.length]);
  const callbacks = seen.length;
  unsubscribe();
  await send("after");
  await Bun.sleep(100);
  steps.push(["callbacks after unsubscribe", seen.length - callbacks]);
  return steps;
}

describe("BunvexClient.onPaginatedUpdate_experimental", () => {
  test("first page, loadMore, exhaustion, live growth, unsubscribe: the same steps as the official client", async () => {
    const ours = await setup(7);
    const mine = await scenario(
      (args, initialNumItems, cb, onError) =>
        ours.c.onPaginatedUpdate_experimental(api.messages.paged, args, { initialNumItems }, cb as never, onError),
      (body) => ours.c.mutation(api.messages.send, { body }),
    );
    expect(mine).toEqual([
      ["first callback", true],
      { status: "CanLoadMore", bodies: ["m6", "m5", "m4"] },
      ["loadMore", true],
      ["status right after loadMore", "LoadingMore"],
      { status: "CanLoadMore", bodies: ["m6", "m5", "m4", "m3", "m2", "m1"] },
      ["loadMore", true],
      { status: "Exhausted", bodies: ["m6", "m5", "m4", "m3", "m2", "m1", "m0"] },
      ["loadMore when exhausted", false],
      { status: "Exhausted", bodies: ["new", "m6", "m5", "m4", "m3", "m2", "m1", "m0"] },
      ["getCurrentValue", 8],
      ["callbacks after unsubscribe", 0],
    ]);

    const theirs = await startServer();
    cleanup.push(theirs.stop);
    const oracle = new ConvexClient(theirs.url, { skipConvexDeploymentUrlCheck: true });
    cleanup.push(() => oracle.close());
    await oracle.mutation(oracleApi.messages.sendMany, { prefix: "m", n: 7 });
    const official = await scenario(
      (args, initialNumItems, cb, onError) =>
        oracle.onPaginatedUpdate_experimental(
          oracleApi.messages.paged,
          args,
          { initialNumItems },
          cb as never,
          onError,
        ) as never,
      (body) => oracle.mutation(oracleApi.messages.send, { body }),
    );
    expect(mine).toEqual(official);
  });

  test("a page that grows too large is split, and the results stay whole", async () => {
    const { c } = await setup(3);
    const seen: Result[] = [];
    const bodies = () => seen[seen.length - 1]?.results.map((m) => m.body);
    c.onPaginatedUpdate_experimental(api.messages.paged, { tight: true }, { initialNumItems: 3 }, (r) =>
      seen.push(r as Result),
    );
    await until(() => bodies()?.length === 3, "first page");
    // The first page now holds 13 rows and may read 8: the server asks for a split, the client splits it.
    await c.mutation(api.messages.sendMany, { prefix: "x", n: 10 });
    const all = [...Array.from({ length: 10 }, (_, i) => `x${9 - i}`), "m2", "m1", "m0"];
    await until(() => JSON.stringify(bodies()) === JSON.stringify(all), "split pages");
  });

  test("equal subscriptions share one; each unsubscribes on its own", async () => {
    const { c } = await setup(2);
    const a: Result[] = [];
    const b: Result[] = [];
    const ua = c.onPaginatedUpdate_experimental(api.messages.paged, {}, { initialNumItems: 5 }, (r) =>
      a.push(r as Result),
    );
    c.onPaginatedUpdate_experimental(api.messages.paged, {}, { initialNumItems: 5 }, (r) => b.push(r as Result));
    await until(() => a.at(-1)?.results.length === 2 && b.at(-1)?.results.length === 2, "both");
    ua();
    await c.mutation(api.messages.send, { body: "x" });
    await until(() => b.at(-1)?.results.length === 3, "b still live");
    expect(a.at(-1)?.results.length).toBe(2);
  });

  test("a failed page reaches onError (DV-250), and the subscription's value throws it", async () => {
    const { c } = await setup(6);
    const seen: Result[] = [];
    const errors: Error[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    cleanup.push(() => process.off("uncaughtException", onUncaught));
    const sub = c.onPaginatedUpdate_experimental(
      api.messages.flippable,
      {},
      { initialNumItems: 2 },
      (r) => seen.push(r as Result),
      (e) => errors.push(e),
    );
    await until(() => seen.at(-1)?.status === "CanLoadMore", "first page");
    seen.at(-1)!.loadMore(2);
    await until(() => seen.at(-1)?.results.length === 4, "second page");
    // The query now reads in the other order: page 2's cursor belongs to the old query.
    await c.mutation(api.messages.flip, {});
    await until(() => errors.length > 0, "onError");
    expect(errors[0].message).toContain("InvalidCursor");
    expect(() => sub.getCurrentValue()).toThrow("InvalidCursor");
    expect(uncaught).toEqual([]);
  });

  test("a disabled client subscribes to nothing", () => {
    const c = new BunvexClient("http://127.0.0.1:1", { disabled: true });
    const sub = c.onPaginatedUpdate_experimental(api.messages.paged, {}, { initialNumItems: 1 }, () => {
      throw new Error("never called");
    });
    expect(sub.getCurrentValue()).toBeUndefined();
    sub();
  });
});

// The TanStack Query integration in the browser (STUDY-48), against a real bunvex server: a cached
// `bunvexQuery` is one live subscription, its new results are pushed into the cache with no refetch, and it is
// dropped `gcTime` after its last observer leaves. The official `@convex-dev/react-query` runs the same
// scenario on the same server.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, type EmptyObject, makeFunctionReference } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient } from "@bunvex/react";
import { BunvexQueryClient, bunvexAction, bunvexQuery, useBunvexMutation } from "@bunvex/react-query";
import type { BunvexError } from "@bunvex/values";
import { ConvexQueryClient, convexQuery } from "@convex-dev/react-query";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { anyApi as oracleApi } from "convex/server";
import { type ReactNode, Suspense, useState } from "react";
import { startServer, until } from "../test/harness.ts";

const api = anyApi;
/** Typed references, as `_generated/api` gives: the factories' and hooks' types follow them. */
const typed = {
  count: makeFunctionReference<"query", EmptyObject, number>("messages:count"),
  echoQuery: makeFunctionReference<"query", { x: bigint }, bigint>("messages:echoQuery"),
  echo: makeFunctionReference<"action", { x: bigint }, bigint>("messages:echo"),
  send: makeFunctionReference<"mutation", { body: string }, string>("messages:send"),
};
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(gcTime = 5 * 60_000) {
  const h = await startServer();
  cleanup.push(h.stop);
  const client = new BunvexReactClient(h.url, {
    logger: false,
    webSocketConstructor: BunWebSocket,
    unsavedChangesWarning: false,
  });
  cleanup.push(() => client.close());
  const bunvex = new BunvexQueryClient(client);
  // Every queryFn run: a pushed update must not cause one.
  const runs: string[] = [];
  const queryFn = bunvex.queryFn();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: (context) => {
          runs.push(String(context.queryKey[1]));
          return queryFn(context);
        },
        queryKeyHashFn: bunvex.hashFn(),
        retry: false,
        gcTime,
      },
    },
  });
  bunvex.connect(queryClient);
  cleanup.push(() => queryClient.clear());
  const mount = (ui: ReactNode) =>
    render(
      <BunvexProvider client={client}>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </BunvexProvider>,
    );
  return { h, client, bunvex, queryClient, runs, mount };
}

function List() {
  const { data, status } = useQuery(bunvexQuery(api.messages.list));
  return <p>{status === "success" ? `list ${(data as string[]).join(",") || "empty"}` : status}</p>;
}

describe("@bunvex/react-query in the browser", () => {
  test("loads, then every change is pushed into the cache, with no refetch", async () => {
    const { client, bunvex, runs, mount } = await setup();
    mount(<List />);
    expect(screen.getByText("pending")).toBeTruthy();
    await screen.findByText("list empty");
    await act(() => client.mutation(api.messages.send, { body: "a" }));
    await screen.findByText("list a");
    await act(() => client.mutation(api.messages.send, { body: "b" }));
    await screen.findByText("list a,b");
    expect(runs).toEqual(["messages:list"]);
    expect(Object.keys(bunvex.subscriptions)).toEqual(["bunvexQuery|messages:list|{}"]);
  });

  test("one subscription per key, kept while cached, dropped gcTime after the last observer", async () => {
    const { bunvex, mount } = await setup(50);
    function Two() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            hide
          </button>
          {shown && <List />}
          {shown && <List />}
        </>
      );
    }
    mount(<Two />);
    await until(() => screen.queryAllByText("list empty").length === 2, "both lists");
    expect(Object.keys(bunvex.subscriptions)).toHaveLength(1);
    await act(async () => screen.getByText("hide").click());
    await until(() => Object.keys(bunvex.subscriptions).length === 0, "the subscription dropped after gcTime");
  });

  test("skip: no request and no subscription", async () => {
    const { bunvex, runs, mount } = await setup();
    function Skipped() {
      const { status, fetchStatus } = useQuery(bunvexQuery(api.messages.list, "skip"));
      return <p>{`${status} ${fetchStatus}`}</p>;
    }
    mount(<Skipped />);
    await Bun.sleep(50);
    expect(screen.getByText("pending idle")).toBeTruthy();
    expect(runs).toEqual([]);
    expect(bunvex.subscriptions).toEqual({});
  });

  test("errors: a failing first read, and an error that arrives live", async () => {
    const { client, mount } = await setup();
    function Show(props: { name: "broken" | "fragile" }) {
      const { data, error, status } = useQuery(bunvexQuery(api.messages[props.name]));
      return (
        <p>{`${props.name} ${status} ${status === "error" ? String((error as BunvexError<string>).data) : data}`}</p>
      );
    }
    mount(
      <>
        <Show name="broken" />
        <Show name="fragile" />
      </>,
    );
    await screen.findByText("broken error query says no");
    await screen.findByText("fragile success ok");
    await act(() => client.mutation(api.messages.send, { body: "a" }));
    await screen.findByText("fragile error now broken");
  });

  test("actions as queries, mutations through useMutation, useSuspenseQuery, bigint args", async () => {
    const { mount } = await setup();
    function App() {
      const echoed = useQuery(bunvexAction(typed.echo, { x: 2n }));
      const { data: count } = useSuspenseQuery(bunvexQuery(typed.count));
      const { data: big } = useSuspenseQuery(bunvexQuery(typed.echoQuery, { x: 9007199254740993n }));
      const send = useMutation({ mutationFn: useBunvexMutation(typed.send) });
      // The types follow the references, as with a generated api.
      count satisfies number;
      big satisfies bigint;
      send.data satisfies string | undefined;
      return (
        <>
          <p>{`echo ${String(echoed.data)} count ${count} big ${typeof big} ${big}`}</p>
          <button type="button" onClick={() => send.mutate({ body: "x" })}>
            send
          </button>
          <p>{`sent ${String(send.data)}`}</p>
        </>
      );
    }
    mount(
      <Suspense fallback={<p>suspended</p>}>
        <App />
      </Suspense>,
    );
    expect(screen.getByText("suspended")).toBeTruthy();
    await screen.findByText("echo 2 count 0 big bigint 9007199254740993");
    await act(async () => screen.getByText("send").click());
    await screen.findByText("sent X");
    await screen.findByText("echo 2 count 1 big bigint 9007199254740993");
  });

  test("oracle: @convex-dev/react-query shows the same sequence on the same server", async () => {
    const { h, client, mount } = await setup();
    const convexClient = new ConvexReactClient(h.url, {
      skipConvexDeploymentUrlCheck: true,
      webSocketConstructor: BunWebSocket,
      unsavedChangesWarning: false,
      logger: false,
    });
    cleanup.push(() => convexClient.close());
    const theirs = new ConvexQueryClient(convexClient);
    const theirCache = new QueryClient({
      defaultOptions: { queries: { queryFn: theirs.queryFn(), queryKeyHashFn: theirs.hashFn(), retry: false } },
    });
    theirs.connect(theirCache);
    cleanup.push(() => theirCache.clear());
    const seen = { ours: [] as string[], theirs: [] as string[] };
    function Ours() {
      const { data, status } = useQuery(bunvexQuery(api.messages.list));
      const text = status === "success" ? `ours ${(data as string[]).join(",") || "empty"}` : `ours ${status}`;
      if (seen.ours.at(-1) !== text) seen.ours.push(text);
      return <p>{text}</p>;
    }
    function Theirs() {
      const { data, status } = useQuery(convexQuery(oracleApi.messages.list, {}));
      const text = status === "success" ? `theirs ${(data as string[]).join(",") || "empty"}` : `theirs ${status}`;
      if (seen.theirs.at(-1) !== text) seen.theirs.push(text);
      return <p>{text}</p>;
    }
    mount(
      <>
        <Ours />
        <QueryClientProvider client={theirCache}>
          <Theirs />
        </QueryClientProvider>
      </>,
    );
    await screen.findByText("ours empty");
    await screen.findByText("theirs empty");
    for (const body of ["a", "b"]) {
      await act(() => client.mutation(api.messages.send, { body }));
      await screen.findByText(`ours ${body === "a" ? "a" : "a,b"}`);
      await screen.findByText(`theirs ${body === "a" ? "a" : "a,b"}`);
    }
    expect(seen.ours.map((s) => s.replace("ours", ""))).toEqual(seen.theirs.map((s) => s.replace("theirs", "")));
  });
});

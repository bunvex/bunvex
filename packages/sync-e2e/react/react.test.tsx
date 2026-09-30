// The React bindings against a real bunvex server (STUDY-26 §7): hooks load, update, stay consistent
// with each other, and a mutation's `await` returns only once the page already shows its write.
import { afterEach, describe, expect, test } from "bun:test";
import { type AnyFunctionReference, anyApi } from "@bunvex/client";
import {
  BunvexProvider,
  BunvexReactClient,
  type ReactMutation,
  useAction,
  useBunvexConnectionState,
  useMutation,
  useQuery,
  useQuery_experimental,
  useSubscription,
} from "@bunvex/react";
import type { BunvexError } from "@bunvex/values";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode, useState } from "react";
import { startServer } from "../test/harness.ts";

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup() {
  const h = await startServer();
  cleanup.push(h.stop);
  const client = new BunvexReactClient(h.url, {
    logger: false,
    webSocketConstructor: BunWebSocket,
    unsavedChangesWarning: false,
    webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 100 },
  });
  cleanup.push(() => client.close());
  const mount = (ui: ReactNode) => render(<BunvexProvider client={client}>{ui}</BunvexProvider>);
  return { h, client, mount };
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <p>caught: {String((this.state.error as BunvexError<string>).data)}</p>
    ) : (
      this.props.children
    );
  }
}

describe("@bunvex/react", () => {
  test("useQuery: undefined while loading, then the value, then every change", async () => {
    const { client, mount } = await setup();
    function Count() {
      const n = useQuery(api.messages.count);
      return <p>{n === undefined ? "loading" : `count ${n}`}</p>;
    }
    mount(<Count />);
    expect(screen.getByText("loading")).toBeTruthy();
    await screen.findByText("count 0");
    await act(() => client.mutation(api.messages.send, { body: "a" }));
    expect(screen.getByText("count 1")).toBeTruthy();
  });

  test("read-your-writes: after `await mutate()`, the rendered page already shows the write", async () => {
    const { mount } = await setup();
    let mutate!: (args: { body: string }) => Promise<unknown>;
    function App() {
      const list = useQuery(api.messages.list) as string[] | undefined;
      mutate = useMutation(api.messages.send);
      return <p>{list === undefined ? "loading" : list.join(",") || "empty"}</p>;
    }
    mount(<App />);
    await screen.findByText("empty");
    for (const body of ["x", "y", "z"]) {
      let result: unknown;
      await act(async () => {
        result = await mutate({ body });
      });
      expect(result).toBe(body.toUpperCase());
      expect(screen.getByText(["x", "y", "z"].slice(0, ["x", "y", "z"].indexOf(body) + 1).join(","))).toBeTruthy();
    }
  });

  test("two queries a mutation changes render together, never one without the other", async () => {
    const { client, mount } = await setup();
    const renders: [number | undefined, number | undefined][] = [];
    function Both() {
      const list = useQuery(api.messages.list) as string[] | undefined;
      const count = useQuery(api.messages.count) as number | undefined;
      renders.push([list?.length, count]);
      return <p>{count ?? "…"}</p>;
    }
    mount(<Both />);
    await screen.findByText("0");
    for (let i = 0; i < 5; i++) await act(() => client.mutation(api.messages.send, { body: `m${i}` }));
    await screen.findByText("5");
    const loaded = renders.filter(([l, c]) => l !== undefined && c !== undefined);
    expect(loaded.every(([l, c]) => l === c)).toBe(true);
  });

  test('"skip" renders undefined without subscribing; arguments turn it on', async () => {
    const { mount } = await setup();
    let setOn!: (on: boolean) => void;
    function Maybe() {
      const [on, set] = useState(false);
      setOn = set;
      const r = useQuery_experimental({ query: api.messages.count, args: on ? {} : "skip" });
      return <p>{r.status === "success" ? `n=${r.data}` : r.status}</p>;
    }
    mount(<Maybe />);
    await Bun.sleep(50);
    expect(screen.getByText("pending")).toBeTruthy();
    act(() => setOn(true));
    await screen.findByText("n=0");
  });

  test("a failed query throws to the error boundary, with the server's data", async () => {
    const { mount } = await setup();
    function Broken() {
      useQuery(api.messages.broken);
      return <p>fine</p>;
    }
    const spy = console.error;
    console.error = () => {}; // React logs the caught error
    try {
      mount(
        <Boundary>
          <Broken />
        </Boundary>,
      );
      await screen.findByText("caught: query says no");
    } finally {
      console.error = spy;
    }
  });

  test("withOptimisticUpdate renders the guess at once; only one per mutation", async () => {
    const { h, mount } = await setup();
    let mutate!: ReactMutation<AnyFunctionReference & { _type: "mutation" }>;
    let base!: ReturnType<typeof useMutation>;
    function App() {
      const list = useQuery(api.messages.list) as string[] | undefined;
      base = useMutation(api.messages.send);
      mutate = base.withOptimisticUpdate((store, args) => {
        const cur = store.getQuery(api.messages.list, {}) as string[] | undefined;
        if (cur) store.setQuery(api.messages.list, {}, [...cur, `${(args as { body: string }).body}?`]);
      });
      return <p>{list === undefined ? "loading" : list.join(",") || "empty"}</p>;
    }
    mount(<App />);
    await screen.findByText("empty");
    const open = h.gate("held");
    let done!: Promise<unknown>;
    act(() => {
      done = mutate({ body: "held" });
    });
    expect(screen.getByText("held?")).toBeTruthy();
    open();
    await act(() => done);
    expect(screen.getByText("held")).toBeTruthy();
    expect(() => mutate.withOptimisticUpdate(() => {})).toThrow(
      "Already specified optimistic update for mutation messages:send",
    );
    expect(typeof base.withOptimisticUpdate).toBe("function");
  });

  test("useAction and the connection state", async () => {
    const { mount } = await setup();
    let echo!: (args: { x: unknown }) => Promise<unknown>;
    function App() {
      echo = useAction(api.messages.echo);
      const s = useBunvexConnectionState();
      return <p>{s.isWebSocketConnected ? "online" : "offline"}</p>;
    }
    mount(<App />);
    // The socket opens on first use.
    let r: unknown;
    await act(async () => {
      r = await echo({ x: [1n, "b"] });
    });
    expect(r).toEqual([1n, "b"]);
    await waitFor(() => expect(screen.getByText("online")).toBeTruthy());
  });

  test("useSubscription sees a change made between render and subscribe, without a notification", async () => {
    let value = "before";
    const getCurrentValue = () => value;
    // The store changes while subscribing (as a query's result can arrive then) and never notifies.
    const subscribe = () => {
      value = "after";
      return () => {};
    };
    function Show() {
      return <p>{useSubscription({ getCurrentValue, subscribe })}</p>;
    }
    render(<Show />);
    await screen.findByText("after");
  });

  test("a hook outside BunvexProvider says so", () => {
    function Orphan() {
      useQuery(api.messages.count);
      return null;
    }
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Orphan />)).toThrow(
        "Could not find bunvex client! `useQuery` must be used in the React component tree under `BunvexProvider`.",
      );
    } finally {
      console.error = spy;
    }
  });
});

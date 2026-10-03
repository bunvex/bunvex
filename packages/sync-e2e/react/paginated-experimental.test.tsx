// usePaginatedQuery_experimental and BunvexReactClient.watchPaginatedQuery against a real bunvex server
// (STUDY-26 §8.4): the pages live in the client's paginated query client; both forms of the hook load, grow,
// split, restart on InvalidCursor, skip, and report errors their way.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, type PaginatedQueryResult } from "@bunvex/client";
import {
  BunvexProvider,
  BunvexReactClient,
  type UsePaginatedQueryObjectReturnType,
  type UsePaginatedQueryResult,
  usePaginatedQuery_experimental,
} from "@bunvex/react";
import { act, render, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { startServer } from "../test/harness.ts";

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(n: number) {
  const h = await startServer();
  cleanup.push(h.stop);
  const client = new BunvexReactClient(h.url, {
    logger: false,
    webSocketConstructor: BunWebSocket,
    unsavedChangesWarning: false,
  });
  cleanup.push(() => client.close());
  // m0 … m{n-1}, oldest first: the query lists them newest first.
  if (n > 0) await client.mutation(api.messages.sendMany, { prefix: "m", n });
  const mount = (ui: ReactNode) => render(<BunvexProvider client={client}>{ui}</BunvexProvider>);
  return { h, client, mount };
}

type Item = { body: string };
type Positional = UsePaginatedQueryResult<Item>;
// biome-ignore lint/suspicious/noExplicitAny: an untyped reference
type ObjectResult = UsePaginatedQueryObjectReturnType<any>;
const desc = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${n - 1 - i}`);
const bodies = (items: Item[] | undefined) => items?.map((m) => m.body);

/** Render the positional form and expose its latest result. */
function positional(query: unknown, args: Record<string, unknown> | "skip", initialNumItems: number) {
  const box: { r?: Positional } = {};
  function Pages() {
    box.r = usePaginatedQuery_experimental(query as typeof api.messages.paged, args as never, { initialNumItems });
    return null;
  }
  return { box, Pages };
}

/** Render the object form and expose its latest result. */
function objectForm(query: unknown, args: Record<string, unknown> | "skip", initialNumItems: number) {
  const box: { r?: ObjectResult } = {};
  function Pages() {
    box.r = usePaginatedQuery_experimental({
      query: query as typeof api.messages.paged,
      args: args as never,
      initialNumItems,
    }) as ObjectResult;
    return null;
  }
  return { box, Pages };
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p>caught: {this.state.error.message}</p> : this.props.children;
  }
}

describe("usePaginatedQuery_experimental, positional form", () => {
  test("first page, loadMore, and exhaustion", async () => {
    const { mount } = await setup(7);
    const { box, Pages } = positional(api.messages.paged, {}, 3);
    mount(<Pages />);
    expect(box.r?.status).toBe("LoadingFirstPage");
    await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
    expect(bodies(box.r?.results)).toEqual(desc("m", 7).slice(0, 3));
    act(() => box.r!.loadMore(3));
    expect(box.r?.status).toBe("LoadingMore");
    // The loaded page stays while the next one loads.
    expect(bodies(box.r?.results)).toEqual(desc("m", 7).slice(0, 3));
    await waitFor(() => expect(bodies(box.r?.results)).toHaveLength(6));
    act(() => box.r!.loadMore(3));
    await waitFor(() => expect(box.r?.status).toBe("Exhausted"));
    expect(bodies(box.r?.results)).toEqual(desc("m", 7));
  });

  test("loaded pages grow with new data; an oversized page is split and the results stay whole", async () => {
    const { client, mount } = await setup(3);
    const { box, Pages } = positional(api.messages.paged, { tight: true }, 3);
    mount(<Pages />);
    await waitFor(() => expect(bodies(box.r?.results)).toEqual(desc("m", 3)));
    // The first page now holds 13 rows and may read 8: the server asks for a split, the client does it.
    await act(() => client.mutation(api.messages.sendMany, { prefix: "x", n: 10 }));
    await waitFor(() => expect(bodies(box.r?.results)).toEqual([...desc("x", 10), ...desc("m", 3)]), {
      timeout: 3000,
    });
  });

  test("a cursor the query no longer accepts (InvalidCursor) restarts the pagination from the first page", async () => {
    const { client, mount } = await setup(6);
    const { box, Pages } = positional(api.messages.flippable, {}, 2);
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      mount(<Pages />);
      await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
      act(() => box.r!.loadMore(2));
      await waitFor(() => expect(bodies(box.r?.results)).toEqual(desc("m", 6).slice(0, 4)));
      // The query now reads in the other order: page 2's cursor belongs to the old query.
      await act(() => client.mutation(api.messages.flip, {}));
      await waitFor(() => expect(bodies(box.r?.results)).toEqual(["m0", "m1"]));
      expect(box.r?.status).toBe("CanLoadMore");
      expect(warnings.join("\n")).toContain("resetting pagination state: ");
    } finally {
      console.warn = warn;
    }
  });

  test('"skip" loads nothing; an error is thrown to the error boundary', async () => {
    const { mount } = await setup(2);
    const skipped = positional(api.messages.paged, "skip", 3);
    const broken = positional(api.messages.broken, {}, 3);
    const errorLog = console.error;
    console.error = () => {}; // React reports the caught error
    try {
      const view = mount(
        <>
          <skipped.Pages />
          <Boundary>
            <broken.Pages />
          </Boundary>
        </>,
      );
      await view.findByText(/caught: .*query says no/);
      expect(skipped.box.r?.status).toBe("LoadingFirstPage");
      expect(bodies(skipped.box.r?.results)).toEqual([]);
    } finally {
      console.error = errorLog;
    }
  });
});

describe("usePaginatedQuery_experimental, object form", () => {
  test("pending, then success with canLoadMore; loadMore keeps the data while pending; exhausted", async () => {
    const { mount } = await setup(5);
    const { box, Pages } = objectForm(api.messages.paged, {}, 3);
    mount(<Pages />);
    expect(box.r).toMatchObject({ status: "pending", data: undefined, canLoadMore: false, isLoading: true });
    await waitFor(() => expect(box.r?.status).toBe("success"));
    expect(box.r).toMatchObject({ canLoadMore: true, isLoading: false, error: undefined });
    expect(bodies(box.r?.data)).toEqual(desc("m", 5).slice(0, 3));
    act(() => box.r!.loadMore(3));
    expect(box.r).toMatchObject({ status: "pending", canLoadMore: false, isLoading: true });
    expect(bodies(box.r?.data)).toEqual(desc("m", 5).slice(0, 3));
    await waitFor(() => expect(box.r?.status).toBe("success"));
    expect(box.r).toMatchObject({ canLoadMore: false });
    expect(bodies(box.r?.data)).toEqual(desc("m", 5));
  });

  test("an error is returned as status error, not thrown", async () => {
    const { mount } = await setup(0);
    const { box, Pages } = objectForm(api.messages.broken, {}, 3);
    mount(<Pages />);
    await waitFor(() => expect(box.r?.status).toBe("error"));
    expect(box.r).toMatchObject({ data: [], canLoadMore: false, isLoading: false });
    expect(box.r?.error?.message).toContain("query says no");
  });

  test('"skip" is pending with no data', async () => {
    const { mount } = await setup(2);
    const { box, Pages } = objectForm(api.messages.paged, "skip", 3);
    mount(<Pages />);
    await Bun.sleep(50);
    expect(box.r).toMatchObject({ status: "pending", data: undefined, canLoadMore: false });
  });

  test("an initialNumItems that is not a positive number is refused", async () => {
    const { mount } = await setup(0);
    const { Pages } = objectForm(api.messages.paged, {}, -1);
    const errorLog = console.error;
    console.error = () => {};
    try {
      const view = mount(
        <Boundary>
          <Pages />
        </Boundary>,
      );
      await view.findByText("caught: `options.initialNumItems` must be a positive number. Received `-1`.");
    } finally {
      console.error = errorLog;
    }
  });
});

describe("BunvexReactClient.watchPaginatedQuery", () => {
  test("nothing is subscribed until onUpdate; the loaded pages as one list; loadMore", async () => {
    const { client } = await setup(4);
    const watch = client.watchPaginatedQuery(api.messages.paged, {}, { initialNumItems: 2, id: 1 });
    expect(watch.localQueryResult()).toBeUndefined();
    let updates = 0;
    const unsubscribe = watch.onUpdate(() => updates++);
    expect(watch.localQueryResult()?.status).toBe("LoadingFirstPage");
    await waitFor(() => expect(watch.localQueryResult()?.status).toBe("CanLoadMore"));
    const r = watch.localQueryResult() as PaginatedQueryResult<Item>;
    expect(bodies(r.results)).toEqual(["m3", "m2"]);
    expect(r.loadMore(2)).toBe(true);
    expect(r.loadMore(2)).toBe(false); // the new page is still loading
    await waitFor(() =>
      expect(bodies((watch.localQueryResult() as PaginatedQueryResult<Item>).results)).toHaveLength(4),
    );
    expect(updates).toBeGreaterThan(0);
    unsubscribe();
    expect(watch.localQueryResult()).toBeUndefined();
  });
});

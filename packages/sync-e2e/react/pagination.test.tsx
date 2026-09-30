// usePaginatedQuery against a real bunvex server (STUDY-26 §8): pages load and grow with the data without
// gaps, loadMore adds pages, oversized pages split, and the optimistic helpers place items.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi } from "@bunvex/client";
import {
  BunvexProvider,
  BunvexReactClient,
  insertAtTop,
  type UsePaginatedQueryResult,
  useMutation,
  usePaginatedQuery,
} from "@bunvex/react";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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

/** Render a usePaginatedQuery and expose its latest result. */
function probe(args: Record<string, unknown> | "skip", initialNumItems: number) {
  const box: { r?: UsePaginatedQueryResult<{ body: string }> } = {};
  function Pages() {
    box.r = usePaginatedQuery(api.messages.paged, args as never, { initialNumItems });
    return null;
  }
  return { box, Pages };
}

const bodies = (r: UsePaginatedQueryResult<{ body: string }> | undefined) => r?.results.map((m) => m.body);
const desc = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${n - 1 - i}`);

describe("usePaginatedQuery", () => {
  test("first page, loadMore, and exhaustion", async () => {
    const { mount } = await setup(7);
    const { box, Pages } = probe({}, 3);
    mount(<Pages />);
    expect(box.r?.status).toBe("LoadingFirstPage");
    await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
    expect(bodies(box.r)).toEqual(desc("m", 7).slice(0, 3));
    act(() => box.r!.loadMore(3));
    expect(box.r?.status).toBe("LoadingMore");
    await waitFor(() => expect(bodies(box.r)).toHaveLength(6));
    act(() => box.r!.loadMore(3));
    await waitFor(() => expect(box.r?.status).toBe("Exhausted"));
    expect(bodies(box.r)).toEqual(desc("m", 7));
  });

  test("loaded pages grow with new data, with no gap or duplicate", async () => {
    const { client, mount } = await setup(10);
    const { box, Pages } = probe({}, 3);
    mount(<Pages />);
    await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
    act(() => box.r!.loadMore(3));
    await waitFor(() => expect(bodies(box.r)).toHaveLength(6));
    // Two newer messages land at the top: the first page grows, the second keeps its place.
    await act(() => client.mutation(api.messages.sendMany, { prefix: "new", n: 2 }));
    await waitFor(() => expect(bodies(box.r)).toHaveLength(8));
    expect(bodies(box.r)).toEqual([...desc("new", 2), ...desc("m", 10).slice(0, 6)]);
  });

  test("a page that grows too large is split in two, and the results stay whole", async () => {
    const { client, mount } = await setup(3);
    const { box, Pages } = probe({ tight: true }, 3);
    mount(<Pages />);
    // A full page is not known to be the last (as Convex): CanLoadMore.
    await waitFor(() => expect(bodies(box.r)).toEqual(desc("m", 3)));
    // The first page now holds 13 rows; it may read 8: the server asks for a split, the client does it.
    await act(() => client.mutation(api.messages.sendMany, { prefix: "x", n: 10 }));
    await waitFor(() => expect(bodies(box.r)).toEqual([...desc("x", 10), ...desc("m", 3)]), { timeout: 3000 });
  });

  test("a cursor the query no longer accepts (InvalidCursor) restarts the pagination from the first page", async () => {
    const { client, mount } = await setup(6);
    const box: { r?: UsePaginatedQueryResult<{ body: string }> } = {};
    function Pages() {
      box.r = usePaginatedQuery(api.messages.flippable, {}, { initialNumItems: 2 });
      return null;
    }
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      mount(<Pages />);
      await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
      act(() => box.r!.loadMore(2));
      await waitFor(() => expect(bodies(box.r)).toEqual(desc("m", 6).slice(0, 4)));
      // The query now reads in the other order: page 2's cursor belongs to the old query.
      await act(() => client.mutation(api.messages.flip, {}));
      await waitFor(() => expect(bodies(box.r)).toEqual(["m0", "m1"]));
      expect(box.r?.status).toBe("CanLoadMore");
      expect(warnings.join("\n")).toContain("resetting pagination state: ");
    } finally {
      console.warn = warn;
    }
  });

  test('"skip" loads nothing', async () => {
    const { mount } = await setup(2);
    const { box, Pages } = probe("skip", 3);
    mount(<Pages />);
    await Bun.sleep(50);
    expect(box.r?.status).toBe("LoadingFirstPage");
    expect(bodies(box.r)).toEqual([]);
  });

  test("insertAtTop shows an optimistic item first, then the server's", async () => {
    const { h, mount } = await setup(4);
    const box: { r?: UsePaginatedQueryResult<{ body: string }>; send?: (a: { body: string }) => Promise<unknown> } = {};
    function App() {
      box.r = usePaginatedQuery(api.messages.paged, {}, { initialNumItems: 2 });
      box.send = useMutation(api.messages.send).withOptimisticUpdate((localQueryStore, args) =>
        insertAtTop({
          paginatedQuery: api.messages.paged,
          localQueryStore,
          item: { body: `${(args as { body: string }).body}?` },
        }),
      );
      return null;
    }
    mount(<App />);
    await waitFor(() => expect(box.r?.status).toBe("CanLoadMore"));
    const open = h.gate("fresh");
    let done!: Promise<unknown>;
    act(() => {
      done = box.send!({ body: "fresh" });
    });
    expect(bodies(box.r)?.[0]).toBe("fresh?");
    open();
    await act(() => done);
    expect(bodies(box.r)?.slice(0, 2)).toEqual(["fresh", "m3"]);
  });
});

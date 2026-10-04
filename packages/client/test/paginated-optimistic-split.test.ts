// A page split driven by optimistic updates alone (STUDY-65 §3, Convex's `browser/sync/paginated_query_client.test.ts`
// "Page splitting with optimistic updates"), without a server: the first page comes back with a `splitCursor`
// and `SplitRecommended`, so the client asks for the two halves (each `paginationOpts` with an `endCursor`), and
// once both have results the list is made of them. The official client does not export its paginated client, so
// this is not differential; the cases and values are Convex's.
import { expect, test } from "bun:test";
import { anyApi } from "@bunvex/protocol";
import { BaseBunvexClient } from "../src/base-client.ts";
import { instantiateNoopLogger } from "../src/logging.ts";
import { PaginatedQueryClient } from "../src/paginated-query-client.ts";

class NeverSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  readyState = 0;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}

test("a split driven by optimistic results alone", async () => {
  const client = new BaseBunvexClient("http://127.0.0.1:1", () => {}, {
    webSocketConstructor: NeverSocket as never,
    unsavedChangesWarning: false,
    logger: instantiateNoopLogger({ verbose: false }),
  });
  let transitions = 0;
  const paginated = new PaginatedQueryClient(client, () => transitions++);
  const options = { initialNumItems: 3, id: 1 };
  const mockPage = (opts: Record<string, unknown>, value: Record<string, unknown>) =>
    void client
      .mutation(
        "myMutation",
        {},
        {
          optimisticUpdate: (store) =>
            store.setQuery(
              anyApi.myQuery.default as never,
              { channel: "general", paginationOpts: { ...opts, id: 1 } } as never,
              value as never,
            ),
        },
      )
      .catch(() => {});
  const result = () => paginated.localQueryResult("myQuery", { channel: "general" }, options);

  expect(paginated.subscribe("myQuery", { channel: "general" }, options)).toHaveProperty("paginatedQueryToken");
  expect(result()?.status).toBe("LoadingFirstPage");

  mockPage(
    { numItems: 3, cursor: null },
    {
      page: ["item1", "item2", "item3", "item4", "item5"],
      continueCursor: "after5",
      isDone: false,
      splitCursor: "after3",
      pageStatus: "SplitRecommended",
    },
  );
  expect(transitions).toBeGreaterThan(0);
  expect(result()?.results).toEqual(["item1", "item2", "item3", "item4", "item5"]);
  expect(result()?.status).toBe("CanLoadMore");

  // The two halves the split asked for.
  mockPage(
    { numItems: 3, cursor: null, endCursor: "after3" },
    { page: ["item1S", "item2S", "item3S"], continueCursor: "after3", isDone: false },
  );
  mockPage(
    { numItems: 3, cursor: "after3", endCursor: "after5" },
    { page: ["item4S", "item5S"], continueCursor: "after5", isDone: false },
  );
  expect(result()?.results).toEqual(["item1S", "item2S", "item3S", "item4S", "item5S"]);
  expect(result()?.status).toBe("CanLoadMore");
  void client.close();
});

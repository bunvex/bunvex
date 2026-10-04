// The optimistic helpers for paginated queries (STUDY-65 G-C16, G-C17): `insertAtTop`, `insertAtBottomIfLoaded`,
// `insertAtPosition` and `optimisticallyUpdateValueInPaginatedQuery`, against a local store the test holds.
// First the cases Convex's `react/use_paginated_query.test.tsx` names, then a differential run: the same random
// page layouts handed to bunvex's helpers and to the official package's (the oracle), whose stores must end
// the same. Convex's `insertAtPosition` compares `argsToMatch` with `===`, unlike the others; bunvex keeps that
// (STUDY-65 Q2), and the oracle run covers it.
import { describe, expect, test } from "bun:test";
import { anyApi, type OptimisticLocalStore } from "@bunvex/client";
import {
  insertAtBottomIfLoaded,
  insertAtPosition,
  insertAtTop,
  optimisticallyUpdateValueInPaginatedQuery,
} from "@bunvex/react";
import * as oracle from "convex/react";
import { anyApi as oracleApi } from "convex/server";
import fc from "fast-check";

type Item = { author: string; rank: number };
type Page = { page: Item[]; continueCursor: string; isDone: boolean };
type Args = { channel?: unknown; paginationOpts: { cursor: string | null; numItems: number; id: number } };
type Entry = { args: Args; value: Page | undefined };

/** A local store holding one paginated query's pages, in insertion order (as the client keeps them). */
class Store {
  entries = new Map<string, Entry>();
  set(args: Args, value: Page | undefined) {
    this.entries.set(JSON.stringify(args), { args, value });
  }
  /** The store both libraries see: every query name maps to the one paginated query. */
  asLocalStore(): OptimisticLocalStore {
    return {
      getAllQueries: () => [...this.entries.values()].map((e) => ({ args: e.args, value: e.value })),
      getQuery: (_q: unknown, args: unknown) => this.entries.get(JSON.stringify(args))?.value,
      setQuery: (_q: unknown, args: unknown, value: unknown) => this.set(args as Args, value as Page | undefined),
    } as unknown as OptimisticLocalStore;
  }
  clone() {
    const s = new Store();
    s.entries = new Map(structuredClone([...this.entries]));
    return s;
  }
  snapshot() {
    return [...this.entries.values()];
  }
  /** The items in list order, following the cursors from the first page. */
  list(channel?: string, id = 0): Item[] {
    const mine = this.snapshot().filter((e) => e.args.channel === channel && e.args.paginationOpts.id === id);
    const out: Item[] = [];
    let cursor: string | null = null;
    for (;;) {
      const e = mine.find((x) => x.args.paginationOpts.cursor === cursor);
      if (!e?.value) return out;
      out.push(...e.value.page);
      if (e.value.isDone) return out;
      cursor = e.value.continueCursor;
    }
  }
}

/** Pages as usePaginatedQuery leaves them: the first with cursor null, each next one at the previous cursor. */
function withPages(store: Store, pages: (Item[] | undefined)[], isDone: boolean, channel?: unknown, id = 0) {
  let cursor: string | null = null;
  pages.forEach((page, i) => {
    const next = `${JSON.stringify(channel ?? null)}:${id}:c${i}`;
    store.set(
      { ...(channel === undefined ? {} : { channel }), paginationOpts: { cursor, numItems: 10, id } },
      page === undefined ? undefined : { page, continueCursor: next, isDone: i === pages.length - 1 && isDone },
    );
    cursor = next;
  });
  return store;
}

const ref = anyApi.messages.list as never;
const rank = (i: Item) => i.rank;
const people = (...ranks: number[]) => ranks.map((r) => ({ author: `p${r}`, rank: r }));

describe("Convex's cases", () => {
  test("insertAtTop: nothing until the first page is loaded; then first; across pages; only the matching arguments", () => {
    const empty = new Store();
    insertAtTop({ paginatedQuery: ref, localQueryStore: empty.asLocalStore(), item: people(1)[0] as never });
    expect(empty.snapshot()).toEqual([]);

    const loading = withPages(new Store(), [undefined], false);
    insertAtTop({ paginatedQuery: ref, localQueryStore: loading.asLocalStore(), item: people(1)[0] as never });
    expect(loading.snapshot()[0]!.value).toBeUndefined();

    const two = withPages(new Store(), [people(10, 20), people(30, 40)], false);
    insertAtTop({ paginatedQuery: ref, localQueryStore: two.asLocalStore(), item: people(5)[0] as never });
    expect(two.list().map(rank)).toEqual([5, 10, 20, 30, 40]);

    const channels = withPages(
      withPages(new Store(), [people(1, 2)], false, "general"),
      [people(3, 4)],
      false,
      "other",
    );
    insertAtTop({
      paginatedQuery: ref,
      localQueryStore: channels.asLocalStore(),
      argsToMatch: { channel: "general" } as never,
      item: people(0)[0] as never,
    });
    expect(channels.list("general").map(rank)).toEqual([0, 1, 2]);
    expect(channels.list("other").map(rank)).toEqual([3, 4]);
  });

  const cases: [string, "asc" | "desc", number, boolean, number[]][] = [
    ["in the middle", "desc", 15, false, [40, 30, 20, 15, 10]],
    ["at the top", "desc", 55, false, [55, 40, 30, 20, 10]],
    ["at the bottom when the list is done", "desc", 5, true, [40, 30, 20, 10, 5]],
    ["not at the bottom while the list is loading", "desc", 5, false, [40, 30, 20, 10]],
    ["on a page boundary", "desc", 29, false, [40, 30, 29, 20, 10]],
    ["in the middle", "asc", 15, false, [10, 15, 20, 30, 40]],
    ["at the top", "asc", 5, false, [5, 10, 20, 30, 40]],
    ["at the bottom when the list is done", "asc", 50, true, [10, 20, 30, 40, 50]],
    ["not at the bottom while the list is loading", "asc", 50, false, [10, 20, 30, 40]],
    ["on a page boundary", "asc", 21, false, [10, 20, 21, 30, 40]],
  ];
  for (const [what, sortOrder, r, isDone, expected] of cases)
    test(`insertAtPosition ${sortOrder}: ${what}`, () => {
      const pages = sortOrder === "asc" ? [people(10, 20), people(30, 40)] : [people(40, 30), people(20, 10)];
      const store = withPages(new Store(), pages, isDone);
      insertAtPosition({
        paginatedQuery: ref,
        localQueryStore: store.asLocalStore(),
        item: { author: "Sarah", rank: r } as never,
        sortOrder,
        sortKeyFromItem: rank as never,
      });
      expect(store.list().map(rank)).toEqual(expected);
    });

  test("insertAtPosition: before the first loaded page while the very first is not loaded, nothing happens", () => {
    const store = withPages(new Store(), [undefined, people(30, 40)], false);
    insertAtPosition({
      paginatedQuery: ref,
      localQueryStore: store.asLocalStore(),
      item: { author: "Sarah", rank: 5 } as never,
      sortOrder: "asc",
      sortKeyFromItem: rank as never,
    });
    expect(store.snapshot()[1]!.value!.page.map(rank)).toEqual([30, 40]);
  });

  test("an object in argsToMatch: insertAtTop matches it by value, insertAtPosition by identity, as Convex (Q2)", () => {
    const store = withPages(new Store(), [people(10, 30)], true, { name: "general" });
    const argsToMatch = { channel: { name: "general" } } as never;
    const item = { author: "Sarah", rank: 20 } as never;
    insertAtPosition({
      paginatedQuery: ref,
      localQueryStore: store.asLocalStore(),
      argsToMatch,
      item,
      sortOrder: "asc",
      sortKeyFromItem: rank as never,
    });
    expect(store.snapshot()[0]!.value!.page.map(rank)).toEqual([10, 30]);
    insertAtTop({ paginatedQuery: ref, localQueryStore: store.asLocalStore(), argsToMatch, item });
    expect(store.snapshot()[0]!.value!.page.map(rank)).toEqual([20, 10, 30]);
  });

  test("insertAtPosition: each usePaginatedQuery (pagination id) gets the item once", () => {
    const store = withPages(
      withPages(new Store(), [people(10, 30)], true, undefined, 1),
      [people(10, 30)],
      true,
      undefined,
      2,
    );
    insertAtPosition({
      paginatedQuery: ref,
      localQueryStore: store.asLocalStore(),
      item: { author: "Sarah", rank: 20 } as never,
      sortOrder: "asc",
      sortKeyFromItem: rank as never,
    });
    expect(store.list(undefined, 1).map(rank)).toEqual([10, 20, 30]);
    expect(store.list(undefined, 2).map(rank)).toEqual([10, 20, 30]);
  });
});

// The differential run: random layouts, the same calls to both libraries.
const ranks = fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 12 });
const layout = fc.record({
  sortOrder: fc.constantFrom<"asc" | "desc">("asc", "desc"),
  ranks,
  // Where the sorted items are cut into pages, and which pages are not loaded yet or empty.
  cuts: fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 4 }),
  unloaded: fc.array(fc.boolean(), { maxLength: 5 }),
  isDone: fc.boolean(),
  // An object-valued argument too: `insertAtPosition` matches it with `===`, the others by value (Q2).
  channel: fc.constantFrom(undefined, "general", "other", "object"),
  id: fc.integer({ min: 0, max: 2 }),
});
type Layout = typeof layout extends fc.Arbitrary<infer T> ? T : never;

function build(layouts: Layout[]) {
  const store = new Store();
  for (const l of layouts) {
    const sorted = [...l.ranks].sort((a, b) => (l.sortOrder === "asc" ? a - b : b - a));
    const cuts = [...new Set(l.cuts.map((c) => Math.min(c, sorted.length)))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, sorted.length];
    const pages: (Item[] | undefined)[] = [];
    for (let i = 0; i + 1 < bounds.length; i++)
      pages.push(
        l.unloaded[i]
          ? undefined
          : sorted.slice(bounds[i], bounds[i + 1]).map((r, j) => ({ author: `a${i}.${j}`, rank: r })),
      );
    withPages(store, pages, l.isDone, l.channel === "object" ? { name: "object" } : l.channel, l.id);
  }
  return store;
}

const call = fc.record({
  helper: fc.constantFrom("top", "bottom", "position", "update"),
  item: fc.record({ author: fc.constant("new"), rank: fc.integer({ min: -1, max: 31 }) }),
  argsToMatch: fc.constantFrom(
    undefined,
    { channel: "general" },
    { channel: "other" },
    { channel: { name: "object" } },
    {},
  ),
  // insertAtPosition's own order (it may differ from the layout's: then pages are out of order for it).
  sortOrder: fc.constantFrom<"asc" | "desc">("asc", "desc"),
});

function apply(lib: "bunvex" | "oracle", store: Store, c: typeof call extends fc.Arbitrary<infer T> ? T : never) {
  const localQueryStore = store.asLocalStore() as never;
  const paginatedQuery = (lib === "bunvex" ? anyApi.messages.list : oracleApi.messages.list) as never;
  const argsToMatch = c.argsToMatch as never;
  const item = c.item as never;
  // Both libraries' helpers, called the same way (their types differ only by package).
  const h = (lib === "bunvex"
    ? { insertAtTop, insertAtBottomIfLoaded, insertAtPosition, optimisticallyUpdateValueInPaginatedQuery }
    : oracle) as unknown as {
    insertAtTop(o: object): void;
    insertAtBottomIfLoaded(o: object): void;
    insertAtPosition(o: object): void;
    optimisticallyUpdateValueInPaginatedQuery(...a: unknown[]): void;
  };
  switch (c.helper) {
    case "top":
      return h.insertAtTop({ paginatedQuery, localQueryStore, argsToMatch, item });
    case "bottom":
      return h.insertAtBottomIfLoaded({ paginatedQuery, localQueryStore, argsToMatch, item });
    case "position":
      return h.insertAtPosition({
        paginatedQuery,
        localQueryStore,
        argsToMatch,
        item,
        sortOrder: c.sortOrder,
        sortKeyFromItem: rank as never,
      });
    case "update":
      return h.optimisticallyUpdateValueInPaginatedQuery(
        localQueryStore,
        paginatedQuery,
        (c.argsToMatch ?? {}) as never,
        ((i: Item) => (i.rank % 2 === 0 ? { ...i, author: "changed" } : i)) as never,
      );
  }
}

test("the same results as the official package's helpers on random page layouts", () => {
  fc.assert(
    fc.property(
      fc.array(layout, { minLength: 1, maxLength: 3 }),
      fc.array(call, { minLength: 1, maxLength: 3 }),
      (layouts, calls) => {
        const mine = build(layouts);
        const theirs = mine.clone();
        for (const c of calls) {
          apply("bunvex", mine, c);
          apply("oracle", theirs, c);
        }
        expect(mine.snapshot()).toEqual(theirs.snapshot());
      },
    ),
    { numRuns: 3000 },
  );
});

// `usePaginatedQuery` and the optimistic helpers for paginated queries, as Convex's
// `react/use_paginated_query.ts` (STUDY-26 §8). Every loaded page is its own subscription:
// - the first page starts at `cursor: null`;
// - `loadMore(n)` adds a page starting at the last page's `continueCursor`;
// - the server pins each page's end (the query journal), so pages grow or shrink with the data but never
//   leave gaps or overlap;
// - a page the server says is too large (`SplitRecommended` / `SplitRequired`), or that holds more than
//   twice `initialNumItems`, is split in two at its `splitCursor`, and the halves replace it once both
//   have loaded;
// - a cursor the server no longer accepts (`InvalidCursor`) restarts the pagination from the first page.
import {
  type AnyFunctionReference,
  asPaginationResult,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  type OptimisticLocalStore,
  type PaginationOptions,
  type PaginationResult,
} from "@bunvex/client";
import { compareValues, toJsonValue, type Value } from "@bunvex/values";
import { useMemo, useState } from "react";
import { useQueries } from "./hooks.ts";
import type { RequestForQueries } from "./queries-observer.ts";

/** A query that takes `paginationOpts` and returns a page. */
export type PaginatedQueryReference = AnyFunctionReference & { _type: "query" };
/** Its arguments without `paginationOpts`. */
export type PaginatedQueryArgs<Q extends PaginatedQueryReference> = Omit<FunctionArgs<Q>, "paginationOpts">;
/** One item of its pages. */
export type PaginatedQueryItem<Q extends PaginatedQueryReference> =
  FunctionReturnType<Q> extends PaginationResult<infer T>
    ? T
    : // biome-ignore lint/suspicious/noExplicitAny: an untyped reference's items
      any;

export type UsePaginatedQueryResult<Item> = { results: Item[]; loadMore: (numItems: number) => void } & (
  | { status: "LoadingFirstPage"; isLoading: true }
  | { status: "CanLoadMore"; isLoading: false }
  | { status: "LoadingMore"; isLoading: true }
  | { status: "Exhausted"; isLoading: false }
);

type PageKey = number;
type PageQuery = {
  query: PaginatedQueryReference;
  args: Record<string, Value> & { paginationOpts: PaginationOptions };
};
type State = {
  query: PaginatedQueryReference;
  args: Record<string, Value>;
  id: number;
  nextPageKey: PageKey;
  pageKeys: PageKey[];
  queries: Record<PageKey, PageQuery>;
  ongoingSplits: Record<PageKey, [PageKey, PageKey]>;
  skip: boolean;
};

/** Each usePaginatedQuery's pages carry their own `id`, so two hooks never share (or split) a page. */
let paginationId = 0;
const nextPaginationId = () => ++paginationId;
/** @internal For tests. */
export function resetPaginationId() {
  paginationId = 0;
}

const argsJson = (args: Record<string, Value>) => JSON.stringify(toJsonValue(args));

const pageQuery = (s: State, paginationOpts: PaginationOptions): PageQuery => ({
  query: s.query,
  args: { ...s.args, paginationOpts: paginationOpts as unknown as Value } as PageQuery["args"],
});

/** Replace page `key` by two pages meeting at `splitCursor` (the halves load before they swap in). */
const splitQuery =
  (key: PageKey, splitCursor: string, continueCursor: string) =>
  (prev: State): State => {
    const opts = prev.queries[key].args.paginationOpts;
    const first = prev.nextPageKey;
    const second = prev.nextPageKey + 1;
    return {
      ...prev,
      nextPageKey: prev.nextPageKey + 2,
      queries: {
        ...prev.queries,
        [first]: pageQuery(prev, { ...opts, endCursor: splitCursor }),
        [second]: pageQuery(prev, { ...opts, cursor: splitCursor, endCursor: continueCursor }),
      },
      ongoingSplits: { ...prev.ongoingSplits, [key]: [first, second] },
    };
  };

const completeSplitQuery =
  (key: PageKey) =>
  (prev: State): State => {
    const halves = prev.ongoingSplits[key];
    if (halves === undefined) return prev;
    const queries = { ...prev.queries };
    delete queries[key];
    const ongoingSplits = { ...prev.ongoingSplits };
    delete ongoingSplits[key];
    const i = prev.pageKeys.indexOf(key);
    const pageKeys =
      i < 0 ? prev.pageKeys.slice() : [...prev.pageKeys.slice(0, i), ...halves, ...prev.pageKeys.slice(i + 1)];
    return { ...prev, queries, pageKeys, ongoingSplits };
  };

/**
 * A paginated query, kept up to date: `results` are the loaded pages' items in order; `loadMore(n)` asks for
 * `n` more. Pass `"skip"` as the arguments to not run it.
 */
export function usePaginatedQuery<Q extends PaginatedQueryReference>(
  query: Q,
  args: PaginatedQueryArgs<Q> | "skip",
  options: { initialNumItems: number },
): UsePaginatedQueryResult<PaginatedQueryItem<Q>> {
  if (typeof options?.initialNumItems !== "number" || options.initialNumItems < 0)
    throw new Error(`\`options.initialNumItems\` must be a positive number. Received \`${options?.initialNumItems}\`.`);
  const skip = args === "skip";
  const argsObject = (skip ? {} : args) as Record<string, Value>;
  const queryName = getFunctionName(query);
  const key = argsJson(argsObject);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the args' JSON, not their identity
  const createInitialState = useMemo(
    () => (): State => {
      const id = nextPaginationId();
      const s: State = {
        query,
        args: argsObject,
        id,
        nextPageKey: 1,
        pageKeys: skip ? [] : [0],
        queries: {},
        ongoingSplits: {},
        skip,
      };
      if (!skip) s.queries[0] = pageQuery(s, { numItems: options.initialNumItems, cursor: null, id });
      return s;
    },
    [key, queryName, options.initialNumItems, skip],
  );
  const [state, setState] = useState<State>(createInitialState);

  // New function or arguments: start over (rendering from the new state right away).
  let current = state;
  if (getFunctionName(query) !== getFunctionName(state.query) || key !== argsJson(state.args) || skip !== state.skip) {
    current = createInitialState();
    setState(current);
  }

  const resultsObject = useQueries(current.queries as unknown as RequestForQueries);

  const [results, lastResult] = useMemo((): [Value[], PaginationResult<Value> | undefined] => {
    let result: PaginationResult<Value> | undefined;
    const items: Value[] = [];
    for (const pageKey of current.pageKeys) {
      const raw = resultsObject[pageKey];
      if (raw === undefined) return [items, undefined];
      if (raw instanceof Error) {
        // The data under a cursor changed shape: throw every cursor away and start over.
        const data = (raw as { data?: { isBunvexSystemError?: unknown; paginationError?: unknown } }).data;
        if (
          raw.message.includes("InvalidCursor") ||
          (typeof data === "object" && data?.isBunvexSystemError === true && data.paginationError === "InvalidCursor")
        ) {
          console.warn(`usePaginatedQuery hit error, resetting pagination state: ${raw.message}`);
          setState(createInitialState);
          return [[], undefined];
        }
        throw raw;
      }
      result = asPaginationResult(raw as Value);
      const split = current.ongoingSplits[pageKey];
      if (split !== undefined) {
        if (resultsObject[split[0]] !== undefined && resultsObject[split[1]] !== undefined)
          setState(completeSplitQuery(pageKey));
      } else if (
        result.splitCursor &&
        (result.pageStatus === "SplitRecommended" ||
          result.pageStatus === "SplitRequired" ||
          result.page.length > options.initialNumItems * 2)
      ) {
        setState(splitQuery(pageKey, result.splitCursor, result.continueCursor));
      }
      // The server could not read the whole page: show what comes before it while it splits.
      if (result.pageStatus === "SplitRequired") return [items, undefined];
      items.push(...result.page);
    }
    return [items, result];
  }, [resultsObject, current.pageKeys, current.ongoingSplits, options.initialNumItems, createInitialState]);

  const status = useMemo(() => {
    const noop = (_numItems: number) => {};
    if (lastResult === undefined)
      return current.nextPageKey === 1
        ? ({ status: "LoadingFirstPage", isLoading: true, loadMore: noop } as const)
        : ({ status: "LoadingMore", isLoading: true, loadMore: noop } as const);
    if (lastResult.isDone) return { status: "Exhausted", isLoading: false, loadMore: noop } as const;
    const continueCursor = lastResult.continueCursor;
    let alreadyLoadingMore = false;
    return {
      status: "CanLoadMore",
      isLoading: false,
      loadMore: (numItems: number) => {
        if (alreadyLoadingMore) return;
        alreadyLoadingMore = true;
        setState((prev) => ({
          ...prev,
          nextPageKey: prev.nextPageKey + 1,
          pageKeys: [...prev.pageKeys, prev.nextPageKey],
          queries: {
            ...prev.queries,
            [prev.nextPageKey]: pageQuery(prev, { numItems, cursor: continueCursor, id: prev.id }),
          },
        }));
      },
    } as const;
  }, [lastResult, current.nextPageKey]);

  return { results: results as PaginatedQueryItem<Q>[], ...status } as UsePaginatedQueryResult<PaginatedQueryItem<Q>>;
}

type Loaded<Q extends PaginatedQueryReference> = {
  args: FunctionArgs<Q>;
  value: PaginationResult<PaginatedQueryItem<Q>>;
};

const pagesOf = <Q extends PaginatedQueryReference>(store: OptimisticLocalStore, query: Q) =>
  store.getAllQueries(query) as { args: FunctionArgs<Q>; value: PaginationResult<PaginatedQueryItem<Q>> | undefined }[];

const matches = (argsToMatch: Record<string, unknown> | undefined, args: Record<string, unknown>) =>
  argsToMatch === undefined ||
  Object.keys(argsToMatch).every((k) => compareValues(argsToMatch[k] as Value, args[k] as Value) === 0);

/** Update an item in every loaded page of the paginated query with these arguments. */
export function optimisticallyUpdateValueInPaginatedQuery<Q extends PaginatedQueryReference>(
  localStore: OptimisticLocalStore,
  query: Q,
  args: PaginatedQueryArgs<Q>,
  updateValue: (currentValue: PaginatedQueryItem<Q>) => PaginatedQueryItem<Q>,
): void {
  const expected = argsJson(args as Record<string, Value>);
  for (const q of pagesOf(localStore, query)) {
    if (q.value === undefined) continue;
    const { paginationOpts: _, ...inner } = q.args as Record<string, Value>;
    if (argsJson(inner) !== expected) continue;
    if (typeof q.value === "object" && q.value !== null && Array.isArray(q.value.page))
      localStore.setQuery(query, q.args, { ...q.value, page: q.value.page.map(updateValue) } as FunctionReturnType<Q>);
  }
}

type InsertOptions<Q extends PaginatedQueryReference> = {
  paginatedQuery: Q;
  argsToMatch?: Partial<PaginatedQueryArgs<Q>>;
  localQueryStore: OptimisticLocalStore;
  item: PaginatedQueryItem<Q>;
};

/** Put `item` first in the first page, once that page is loaded. */
export function insertAtTop<Q extends PaginatedQueryReference>(options: InsertOptions<Q>) {
  const { paginatedQuery, argsToMatch, localQueryStore, item } = options;
  const first = pagesOf(localQueryStore, paginatedQuery).find(
    (q) =>
      matches(argsToMatch as Record<string, unknown>, q.args as Record<string, unknown>) &&
      (q.args as { paginationOpts: PaginationOptions }).paginationOpts.cursor === null,
  );
  if (first?.value === undefined) return; // not loaded yet: wait for it
  localQueryStore.setQuery(paginatedQuery, first.args, {
    ...first.value,
    page: [item, ...first.value.page],
  } as FunctionReturnType<Q>);
}

/** Put `item` last in the last page, only if the last page is loaded (else it would pop out again). */
export function insertAtBottomIfLoaded<Q extends PaginatedQueryReference>(options: InsertOptions<Q>) {
  const { paginatedQuery, argsToMatch, localQueryStore, item } = options;
  const last = pagesOf(localQueryStore, paginatedQuery).find(
    (q) => matches(argsToMatch as Record<string, unknown>, q.args as Record<string, unknown>) && q.value?.isDone,
  );
  if (last?.value === undefined) return;
  localQueryStore.setQuery(paginatedQuery, last.args, {
    ...last.value,
    page: [...last.value.page, item],
  } as FunctionReturnType<Q>);
}

/**
 * Put `item` where it sorts, in every group of pages (one group per usePaginatedQuery: same arguments and
 * pagination id), by `sortKeyFromItem` and `sortOrder`.
 */
export function insertAtPosition<Q extends PaginatedQueryReference>(
  options: InsertOptions<Q> & {
    sortOrder: "asc" | "desc";
    sortKeyFromItem: (element: PaginatedQueryItem<Q>) => Value | Value[];
  },
) {
  const { paginatedQuery, argsToMatch, localQueryStore } = options;
  const groups: Record<
    string,
    { args: FunctionArgs<Q>; value: PaginationResult<PaginatedQueryItem<Q>> | undefined }[]
  > = {};
  for (const q of pagesOf(localQueryStore, paginatedQuery)) {
    const args = q.args as Record<string, unknown>;
    if (
      argsToMatch !== undefined &&
      !Object.keys(argsToMatch).every((k) => (argsToMatch as Record<string, unknown>)[k] === args[k])
    )
      continue;
    const groupKey = JSON.stringify(
      Object.fromEntries(
        Object.entries(args).map(([k, v]) => [k, k === "paginationOpts" ? (v as PaginationOptions).id : v]),
      ),
    );
    const group = groups[groupKey] ?? [];
    groups[groupKey] = group;
    group.push(q);
  }
  for (const pages of Object.values(groups)) insertInPages(options, pages);
}

function insertInPages<Q extends PaginatedQueryReference>(
  options: InsertOptions<Q> & {
    sortOrder: "asc" | "desc";
    sortKeyFromItem: (e: PaginatedQueryItem<Q>) => Value | Value[];
  },
  pageQueries: { args: FunctionArgs<Q>; value: PaginationResult<PaginatedQueryItem<Q>> | undefined }[],
) {
  const { sortOrder, sortKeyFromItem, localQueryStore, item, paginatedQuery } = options;
  const cmp = (a: PaginatedQueryItem<Q>, b: Value | Value[]) => compareValues(sortKeyFromItem(a) as Value, b as Value);
  const inserted = sortKeyFromItem(item);
  const before = (c: number) => (sortOrder === "asc" ? c <= 0 : c >= 0);
  const set = (page: Loaded<Q>, items: PaginatedQueryItem<Q>[]) =>
    localQueryStore.setQuery(paginatedQuery, page.args, { ...page.value, page: items } as FunctionReturnType<Q>);
  const sorted = pageQueries
    .filter((q): q is Loaded<Q> => q.value !== undefined && q.value.page.length > 0)
    .sort((a, b) => {
      const c = compareValues(sortKeyFromItem(a.value.page[0]) as Value, sortKeyFromItem(b.value.page[0]) as Value);
      return sortOrder === "asc" ? c : -c;
    });
  const first = sorted[0];
  if (first === undefined) return; // no page loaded yet
  // Before the first loaded page: only into the very first page (cursor null).
  if (before(compareValues(inserted as Value, sortKeyFromItem(first.value.page[0]) as Value))) {
    if ((first.args as { paginationOpts: PaginationOptions }).paginationOpts.cursor === null)
      set(first, [item, ...first.value.page]);
    return;
  }
  const last = sorted[sorted.length - 1];
  const lastItem = last.value.page[last.value.page.length - 1];
  const c = compareValues(inserted as Value, sortKeyFromItem(lastItem) as Value);
  // After the last loaded page: only if that page is the end (else the item would pop out).
  if (sortOrder === "asc" ? c >= 0 : c <= 0) {
    if (last.value.isDone) set(last, [...last.value.page, item]);
    return;
  }
  // Into the page before the first page that starts after the item, at its sorted place.
  const successor = sorted.findIndex((p) => {
    const d = cmp(p.value.page[0], inserted);
    return sortOrder === "asc" ? d > 0 : d < 0;
  });
  const page = successor === -1 ? sorted[sorted.length - 1] : sorted[successor - 1];
  if (page === undefined) return;
  const at = page.value.page.findIndex((e) => {
    const d = cmp(e, inserted);
    return sortOrder === "asc" ? d >= 0 : d <= 0;
  });
  set(
    page,
    at === -1 ? [...page.value.page, item] : [...page.value.page.slice(0, at), item, ...page.value.page.slice(at)],
  );
}

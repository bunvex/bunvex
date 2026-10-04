// `usePaginatedQuery_experimental`, as Convex's `react/use_paginated_query2.ts` (STUDY-26 §8.4): the same
// growing list as `usePaginatedQuery`, but the pages live in the client's paginated query client
// (`watchPaginatedQuery`) instead of in React state. Two forms:
// - positional, `(query, args, { initialNumItems })`, returning `usePaginatedQuery`'s shape; errors throw;
// - an options object, `{ query, args, initialNumItems, throwOnError? }`, returning `{ data, status: "pending" |
//   "success" | "error", canLoadMore, isLoading, error, loadMore }`; errors are returned unless `throwOnError`.
// New function, arguments or `"skip"` start over with a new pagination id; so does an `InvalidCursor` page.
import {
  type AnyFunctionReference,
  getFunctionName,
  type PaginatedQueryResult,
  type SubscribeToPaginatedQueryOptions,
} from "@bunvex/client";
import { toJsonValue, type Value } from "@bunvex/values";
import { useState } from "react";
import { useRequiredClient } from "./context.ts";
import { useQueries } from "./hooks.ts";
import type { RequestForQueries } from "./queries-observer.ts";
import type {
  PaginatedQueryArgs,
  PaginatedQueryItem,
  PaginatedQueryReference,
  UsePaginatedQueryResult,
} from "./use-paginated-query.ts";

/** The object form's options. */
export type UsePaginatedQueryOptions<Q extends PaginatedQueryReference, ThrowOnError extends boolean = false> = {
  query: Q;
  args: PaginatedQueryArgs<Q> | "skip";
  initialNumItems: number;
  /** Throw errors to an error boundary (`true`) or return them as `status: "error"` (default). */
  throwOnError?: ThrowOnError;
};

/** The object form's result: lowercase statuses and `canLoadMore`. */
export type UsePaginatedQueryObjectReturnType<Q extends PaginatedQueryReference, ThrowOnError extends boolean = false> =
  | {
      data: PaginatedQueryItem<Q>[] | undefined;
      status: "pending";
      canLoadMore: false;
      isLoading: true;
      error: undefined;
      loadMore: (numItems: number) => void;
    }
  | {
      data: PaginatedQueryItem<Q>[];
      status: "success";
      canLoadMore: boolean;
      isLoading: false;
      error: undefined;
      loadMore: (numItems: number) => void;
    }
  | (ThrowOnError extends true
      ? never
      : {
          data: PaginatedQueryItem<Q>[];
          status: "error";
          canLoadMore: false;
          isLoading: false;
          error: Error;
          loadMore: (numItems: number) => void;
        });

type State = {
  query: AnyFunctionReference & { _type: "query" };
  args: Record<string, Value>;
  id: number;
  /** Empty when skipped, else the one paginated query. */
  queries: RequestForQueries;
  skip: boolean;
};

type Internal = {
  results: Value[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted" | "Error";
  isLoading: boolean;
  loadMore: (numItems: number) => unknown;
  error?: Error;
};

let paginationId = 0;
const nextPaginationId = () => ++paginationId;

const argsJson = (args: Record<string, Value>) => JSON.stringify(toJsonValue(args));
const loading = (): Internal => ({ results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => false });

export function usePaginatedQuery_experimental<Q extends PaginatedQueryReference>(
  query: Q,
  args: PaginatedQueryArgs<Q> | "skip",
  options: { initialNumItems: number },
): UsePaginatedQueryResult<PaginatedQueryItem<Q>>;
export function usePaginatedQuery_experimental<Q extends PaginatedQueryReference, ThrowOnError extends boolean = false>(
  options: UsePaginatedQueryOptions<Q, ThrowOnError>,
): UsePaginatedQueryObjectReturnType<Q, ThrowOnError>;
export function usePaginatedQuery_experimental<Q extends PaginatedQueryReference>(
  queryOrOptions: Q | UsePaginatedQueryOptions<Q>,
  args?: PaginatedQueryArgs<Q> | "skip",
  options?: { initialNumItems: number },
): UsePaginatedQueryResult<PaginatedQueryItem<Q>> | UsePaginatedQueryObjectReturnType<Q> {
  const objectForm = typeof queryOrOptions === "object" && queryOrOptions !== null && "query" in queryOrOptions;
  const query = objectForm ? (queryOrOptions as UsePaginatedQueryOptions<Q>).query : (queryOrOptions as Q);
  const queryArgs = objectForm ? (queryOrOptions as UsePaginatedQueryOptions<Q>).args : args;
  const throwOnError = objectForm ? ((queryOrOptions as UsePaginatedQueryOptions<Q>).throwOnError ?? false) : true;
  const initialNumItems = objectForm
    ? (queryOrOptions as UsePaginatedQueryOptions<Q>).initialNumItems
    : options?.initialNumItems;
  if (typeof initialNumItems !== "number" || initialNumItems < 0)
    throw new Error(`\`options.initialNumItems\` must be a positive number. Received \`${initialNumItems}\`.`);
  const skip = queryArgs === "skip";
  const argsObject = (skip ? {} : queryArgs) as Record<string, Value>;

  const createInitialState = (): State => {
    const id = nextPaginationId();
    const paginationOptions: SubscribeToPaginatedQueryOptions = { initialNumItems, id };
    return {
      query,
      args: argsObject,
      id,
      queries: skip ? {} : { paginatedQuery: { query, args: { ...argsObject }, paginationOptions } },
      skip,
    };
  };
  const [state, setState] = useState<State>(createInitialState);

  // New function, arguments or skip: a new paginated query, rendered from right away.
  let current = state;
  if (
    getFunctionName(query) !== getFunctionName(state.query) ||
    argsJson(argsObject) !== argsJson(state.args) ||
    skip !== state.skip
  ) {
    current = createInitialState();
    setState(current);
  }

  // As Convex: the reset warning goes to the client's logger (silent with `logger: false`).
  const logger = useRequiredClient("usePaginatedQuery").logger;
  const results = useQueries(current.queries);
  const shape = (internal: Internal) =>
    (objectForm ? toObjectForm(internal) : internal) as
      | UsePaginatedQueryResult<PaginatedQueryItem<Q>>
      | UsePaginatedQueryObjectReturnType<Q>;

  if (!("paginatedQuery" in results)) {
    if (!skip) throw new Error("The paginated query is missing from its own results.");
    return shape(loading());
  }
  const result = results.paginatedQuery as PaginatedQueryResult<Value> | Error | undefined;
  if (result === undefined) return shape(loading());
  if (result instanceof Error) {
    const data = (result as { data?: { isBunvexSystemError?: unknown; paginationError?: unknown } }).data;
    if (
      result.message.includes("InvalidCursor") ||
      (typeof data === "object" && data?.isBunvexSystemError === true && data.paginationError === "InvalidCursor")
    ) {
      // The data under a cursor changed shape: throw every cursor away and start over.
      logger.warn(`usePaginatedQuery hit error, resetting pagination state: ${result.message}`);
      setState(createInitialState);
      return shape(loading());
    }
    if (throwOnError) throw result;
    return shape({ results: [], status: "Error", isLoading: false, loadMore: () => false, error: result });
  }
  return shape({
    results: result.results,
    status: result.status,
    isLoading: result.status === "LoadingFirstPage" || result.status === "LoadingMore",
    loadMore: (numItems: number) => result.loadMore(numItems),
  });
}

/** The object form: `pending` while a page loads, `success` with `canLoadMore`, or `error`. */
function toObjectForm(internal: Internal) {
  const { results, loadMore } = internal;
  if (internal.status === "Error")
    return { data: results, status: "error", canLoadMore: false, isLoading: false, error: internal.error, loadMore };
  if (internal.status === "LoadingFirstPage" || internal.status === "LoadingMore")
    return {
      data: internal.status === "LoadingFirstPage" ? undefined : results,
      status: "pending",
      canLoadMore: false,
      isLoading: true,
      error: undefined,
      loadMore,
    };
  return {
    data: results,
    status: "success",
    canLoadMore: internal.status === "CanLoadMore",
    isLoading: false,
    error: undefined,
    loadMore,
  };
}

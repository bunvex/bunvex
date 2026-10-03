// Package @bunvex/react-query — TanStack Query integration (STUDY-55), the counterpart of Convex's
// `@convex-dev/react-query`. `BunvexQueryClient` keeps one live subscription per cached `bunvexQuery` key and
// writes every new result into the `QueryClient`; on the server, queries are read over HTTP at one snapshot.
import {
  type AnyFunctionReference,
  BunvexHttpClient,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  makeFunctionReference,
} from "@bunvex/client";
import { BunvexReactClient, type BunvexReactClientOptions, type Watch } from "@bunvex/react";
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import {
  hashKey,
  notifyManager,
  type QueryCache,
  type QueryClient,
  type QueryFunction,
  type QueryFunctionContext,
  type QueryKey,
  type UseQueryOptions,
  type UseSuspenseQueryOptions,
} from "@tanstack/react-query";

// The bunvex hooks under names that do not clash with TanStack's `useQuery` / `useMutation`.
export {
  optimisticallyUpdateValueInPaginatedQuery,
  useAction as useBunvexAction,
  useBunvex,
  useBunvexAuth,
  useMutation as useBunvexMutation,
  usePaginatedQuery as useBunvexPaginatedQuery,
  useQueries as useBunvexQueries,
  useQuery as useBunvexQuery,
} from "@bunvex/react";

type Ref<T extends "query" | "action"> = AnyFunctionReference & { _type: T };
type EmptyObject = Record<string, never>;

/** Decided once, as Convex: no `window` means server rendering. */
const isServer = typeof (globalThis as { window?: unknown }).window === "undefined";

/** A query key: the prefix, the function's name, and its args in the JSON value encoding (STUDY-55 R3). */
type QueryKeyOf<Q extends AnyFunctionReference> = ["bunvexQuery", Q, FunctionArgs<Q>];
type ActionKeyOf<A extends AnyFunctionReference> = ["bunvexAction", A, FunctionArgs<A>];
type StoredKey = readonly [prefix: string, name: string, args: JSONValue | "skip", ...rest: unknown[]];

const isSkipped = (key: readonly unknown[]) =>
  key.length >= 2 && (key[0] === "bunvexQuery" || key[0] === "bunvexAction") && key[2] === "skip";
const isQueryKey = (key: readonly unknown[]): key is StoredKey => key.length >= 2 && key[0] === "bunvexQuery";
const isActionKey = (key: readonly unknown[]): key is StoredKey => key.length >= 2 && key[0] === "bunvexAction";

/** The call a stored key stands for: the function and its decoded args. */
function decode<T extends "query" | "action">(key: StoredKey) {
  return {
    fn: makeFunctionReference<T>(key[1]) as unknown as Ref<T>,
    args: fromJsonValue((key[2] ?? {}) as JSONValue) as Record<string, Value>,
  };
}

/** Options of the client itself (the rest of `BunvexQueryClientOptions` builds the `BunvexReactClient`). */
export interface BunvexQueryClientOnlyOptions {
  /** The TanStack `QueryClient`; or call `connect(queryClient)` later. */
  queryClient?: QueryClient;
  /** The fetch for requests made on the server (keep it out of the browser bundle if you can). */
  serverFetch?: typeof globalThis.fetch | undefined;
  /**
   * Read each query at the latest snapshot during server rendering instead of one snapshot for all: one round
   * trip instead of two, but queries of one render may disagree (a "client-side join" may see a missing row).
   */
  dangerouslyUseInconsistentQueriesDuringSSR?: boolean;
}

export interface BunvexQueryClientOptions extends BunvexQueryClientOnlyOptions, BunvexReactClientOptions {}

/** Keeps the bunvex queries of a TanStack `QueryClient` live: one subscription per cached query. */
export class BunvexQueryClient<ClientArg extends BunvexReactClient | string = BunvexReactClient> {
  bunvexClient: BunvexReactClient;
  subscriptions: Record<string, { watch: Watch<unknown>; unsubscribe: () => void; queryKey: StoredKey }> = {};
  unsubscribe: (() => void) | undefined;
  /** Only during server rendering. */
  serverHttpClient?: BunvexHttpClient;
  ssrQueryMode: "consistent" | "inconsistent";
  private _queryClient: QueryClient | undefined;

  get queryClient(): QueryClient {
    if (!this._queryClient) throw new Error("BunvexQueryClient not connected to TanStack QueryClient.");
    return this._queryClient;
  }

  constructor(
    /** A `BunvexReactClient`, or the deployment's URL to build one. */
    client: ClientArg,
    options: ClientArg extends BunvexReactClient ? BunvexQueryClientOnlyOptions : BunvexQueryClientOptions = {},
  ) {
    this.bunvexClient =
      typeof client === "string" ? new BunvexReactClient(client, options as BunvexQueryClientOptions) : client;
    this.ssrQueryMode = options.dangerouslyUseInconsistentQueriesDuringSSR ? "inconsistent" : "consistent";
    if (options.queryClient) {
      this._queryClient = options.queryClient;
      this.unsubscribe = this.subscribeInner(options.queryClient.getQueryCache());
    }
    if (isServer) this.serverHttpClient = new BunvexHttpClient(this.bunvexClient.url, { fetch: options.serverFetch });
  }

  /** Finish setting up: follow `queryClient`'s cache. */
  connect(queryClient: QueryClient) {
    if (this.unsubscribe) throw new Error("already subscribed!");
    this._queryClient = queryClient;
    this.unsubscribe = this.subscribeInner(queryClient.getQueryCache());
  }

  /** Write every subscription's current result into the cache (rarely useful). */
  onUpdate = () => {
    notifyManager.batch(() => {
      for (const hash of Object.keys(this.subscriptions)) this.onUpdateQueryKeyHash(hash);
    });
  };

  onUpdateQueryKeyHash(queryHash: string) {
    const subscription = this.subscriptions[queryHash];
    if (!subscription)
      throw new Error(`Internal BunvexQueryClient error: onUpdateQueryKeyHash called for ${queryHash}`);
    const query = this.queryClient.getQueryCache().get(queryHash);
    if (!query) return;
    let value: unknown;
    try {
      value = subscription.watch.localQueryResult();
    } catch (error) {
      // TanStack has no public "set error": the same state change its devtools make.
      query.setState({
        error: error as Error,
        errorUpdateCount: query.state.errorUpdateCount + 1,
        errorUpdatedAt: Date.now(),
        fetchFailureCount: query.state.fetchFailureCount + 1,
        fetchFailureReason: error as Error,
        fetchStatus: "idle",
        status: "error",
      });
      return;
    }
    // Never create an entry: a key with no cached data is not ours to fill.
    this.queryClient.setQueryData(subscription.queryKey, (prev: unknown) => (prev === undefined ? undefined : value));
  }

  subscribeInner(queryCache: QueryCache): () => void {
    if (isServer) return () => {};
    return queryCache.subscribe((event) => {
      const key = event.query.queryKey;
      if (!isQueryKey(key) || isSkipped(key)) return;
      if (event.type === "added") {
        // The query entered the cache: subscribe, and keep the subscription while it stays there.
        const { fn, args } = decode<"query">(key);
        const watch = this.bunvexClient.watchQuery(fn, args, {}) as Watch<unknown>;
        const unsubscribe = watch.onUpdate(() => this.onUpdateQueryKeyHash(event.query.queryHash));
        this.subscriptions[event.query.queryHash] = { queryKey: key, watch, unsubscribe };
      } else if (event.type === "removed") {
        // Garbage-collected (`gcTime` after its last observer left): drop the subscription.
        this.subscriptions[event.query.queryHash]?.unsubscribe();
        delete this.subscriptions[event.query.queryHash];
      }
    });
  }

  /**
   * The default `queryFn`: a `bunvexQuery` key reads the query (over HTTP at one snapshot on the server), a
   * `bunvexAction` key runs the action, any other key goes to `otherFetch`.
   */
  queryFn(otherFetch: QueryFunction<unknown, QueryKey> = throwBecauseNotBunvexQuery) {
    return async (context: QueryFunctionContext<QueryKey>): Promise<unknown> => {
      const key = context.queryKey;
      if (isSkipped(key)) throw new Error("Skipped query should not actually be run, should { enabled: false }");
      if (isQueryKey(key)) {
        const { fn, args } = decode<"query">(key);
        if (!isServer) return this.bunvexClient.query(fn, args);
        return this.ssrQueryMode === "consistent"
          ? this.serverHttpClient!.consistentQuery(fn, args as never)
          : this.serverHttpClient!.query(fn, args as never);
      }
      if (isActionKey(key)) {
        const { fn, args } = decode<"action">(key);
        return isServer ? this.serverHttpClient!.action(fn, args as never) : this.bunvexClient.action(fn, args);
      }
      return otherFetch(context);
    };
  }

  /** The `QueryClient`'s default `queryKeyHashFn` (TanStack cannot take one per query). */
  hashFn(otherHashKey: (queryKey: QueryKey) => string = hashKey) {
    return (queryKey: QueryKey) =>
      isQueryKey(queryKey) ? `bunvexQuery|${queryKey[1]}|${JSON.stringify(queryKey[2])}` : otherHashKey(queryKey);
  }

  /** `bunvexQuery`'s options with this client's `queryFn`, for a `QueryClient` without the default. */
  queryOptions = <Q extends Ref<"query">>(
    fn: Q,
    args: FunctionArgs<Q>,
  ): Pick<
    UseQueryOptions<FunctionReturnType<Q>, Error, FunctionReturnType<Q>, QueryKeyOf<Q>>,
    "queryKey" | "queryFn" | "staleTime"
  > =>
    ({
      queryKey: queryKeyOf("bunvexQuery", fn, args),
      queryFn: this.queryFn(),
      staleTime: Number.POSITIVE_INFINITY,
    }) as never;
}

type ArgsOrSkip<F extends AnyFunctionReference> = keyof FunctionArgs<F> extends never
  ? [args?: EmptyObject | "skip"]
  : EmptyObject extends FunctionArgs<F>
    ? [args?: FunctionArgs<F> | "skip"]
    : [args: FunctionArgs<F> | "skip"];

/** The key: the function's name (serializable), and the args encoded so bigints and bytes survive (R3). */
function queryKeyOf(prefix: string, fn: AnyFunctionReference, args: unknown) {
  return [prefix, getFunctionName(fn), args === "skip" ? "skip" : toJsonValue((args ?? {}) as Value)];
}

/**
 * Options for a live query: `useQuery(bunvexQuery(api.messages.list, { channel }))`, `useSuspenseQuery` too.
 * Needs `BunvexQueryClient`'s `queryFn` and `hashFn` as the `QueryClient`'s defaults. Never stale: new results
 * are pushed into the cache.
 */
export function bunvexQuery<Q extends Ref<"query">>(
  fn: Q,
  ...argsOrSkip: ArgsOrSkip<Q>
): (typeof argsOrSkip)[0] extends "skip"
  ? Pick<
      UseQueryOptions<FunctionReturnType<Q>, Error, FunctionReturnType<Q>, QueryKeyOf<Q>>,
      "queryKey" | "queryFn" | "staleTime" | "enabled"
    >
  : Pick<
      UseSuspenseQueryOptions<FunctionReturnType<Q>, Error, FunctionReturnType<Q>, QueryKeyOf<Q>>,
      "queryKey" | "queryFn" | "staleTime"
    > {
  const args = argsOrSkip[0] ?? {};
  return {
    queryKey: queryKeyOf("bunvexQuery", fn, args),
    staleTime: Number.POSITIVE_INFINITY,
    ...(args === "skip" ? { enabled: false } : {}),
  } as never;
}

/** Options for an action run as a query: not live, refetched by TanStack's usual rules. */
export function bunvexAction<A extends Ref<"action">>(
  fn: A,
  ...argsOrSkip: ArgsOrSkip<A>
): Pick<
  UseQueryOptions<FunctionReturnType<A>, Error, FunctionReturnType<A>, ActionKeyOf<A>>,
  "queryKey" | "queryFn" | "staleTime" | "enabled"
> {
  const args = argsOrSkip[0] ?? {};
  return {
    queryKey: queryKeyOf("bunvexAction", fn, args === "skip" ? {} : args),
    staleTime: Number.POSITIVE_INFINITY,
    ...(args === "skip" ? { enabled: false } : {}),
  } as never;
}

function throwBecauseNotBunvexQuery(context: QueryFunctionContext<QueryKey>): never {
  throw new Error(`Query key is not for a bunvex query: ${context.queryKey}`);
}

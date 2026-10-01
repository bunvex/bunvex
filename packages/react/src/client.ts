// `BunvexReactClient`, as Convex's `ConvexReactClient` (`react/client.ts`, STUDY-26 §7): the sync client a
// React app shares through `BunvexProvider`. The base client is created lazily, on first use, so rendering
// on a server without a socket costs nothing. Queries are watched by token, and each watcher's callback runs
// when a transition changes its query.
import {
  type AnyFunctionReference,
  type AuthTokenFetcher,
  BaseBunvexClient,
  type BaseBunvexClientOptions,
  type ConnectionState,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
  type Logger,
  type OptimisticUpdate,
  type OptionalRestArgs,
  type QueryToken,
  type v1,
} from "@bunvex/client";
import type { Value } from "@bunvex/values";

/** How long `prewarmQuery` keeps its subscription (Convex's DEFAULT_EXTEND_SUBSCRIPTION_FOR). */
const DEFAULT_EXTEND_SUBSCRIPTION_FOR = 5_000;

type Ref<T extends "query" | "mutation" | "action"> = AnyFunctionReference & { _type: T };

/** A mutation as a function, with `withOptimisticUpdate` to attach an optimistic update (only one). */
export interface ReactMutation<M extends Ref<"mutation">> {
  (...args: OptionalRestArgs<M>): Promise<FunctionReturnType<M>>;
  withOptimisticUpdate(optimisticUpdate: OptimisticUpdate<FunctionArgs<M>>): ReactMutation<M>;
}

export type ReactAction<A extends Ref<"action">> = (...args: OptionalRestArgs<A>) => Promise<FunctionReturnType<A>>;

/** A watched query: listen for changes, read the local result. */
export interface Watch<T> {
  onUpdate(callback: () => void): () => void;
  localQueryResult(): T | undefined;
  localQueryLogs(): string[] | undefined;
  journal(): v1.QueryJournal | undefined;
}

export type WatchQueryOptions = { journal?: v1.QueryJournal; componentPath?: string };
export type MutationOptions<Args extends Record<string, Value>> = { optimisticUpdate?: OptimisticUpdate<Args> };

/** The part of the base client this one uses: a test or an embedding may pass its own (`baseClient`). */
export type BaseClientInterface = Pick<
  BaseBunvexClient,
  | "subscribe"
  | "localQueryResult"
  | "localQueryLogs"
  | "queryJournal"
  | "mutation"
  | "action"
  | "connectionState"
  | "subscribeToConnectionState"
  | "setAuth"
  | "setAdminAuth"
  | "clearAuth"
  | "close"
  | "addOnTransitionHandler"
>;

export type BunvexReactClientOptions = BaseBunvexClientOptions & { baseClient?: BaseClientInterface };

/** A React event passed straight as a function's arguments (`onClick={mutation}`) is a mistake. */
function assertNotAccidentalArgument(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    "bubbles" in value &&
    "persist" in value &&
    "isDefaultPrevented" in value
  )
    throw new Error(
      "bunvex function called with SyntheticEvent object. Did you use a bunvex function as an event handler directly? Event handlers like onClick receive an event object as their first argument. These SyntheticEvent objects are not valid bunvex values. Try wrapping the function like `const handler = () => myMutation();` and using `handler` in the event handler.",
    );
}

export function createMutation<M extends Ref<"mutation">>(
  ref: M,
  client: BunvexReactClient,
  update?: OptimisticUpdate<FunctionArgs<M>>,
): ReactMutation<M> {
  const mutation = (args?: Record<string, Value>) => {
    assertNotAccidentalArgument(args);
    return client.mutation(
      ref,
      (args ?? {}) as FunctionArgs<M>,
      update === undefined ? {} : { optimisticUpdate: update },
    );
  };
  mutation.withOptimisticUpdate = (optimisticUpdate: OptimisticUpdate<FunctionArgs<M>>) => {
    if (update !== undefined)
      throw new Error(`Already specified optimistic update for mutation ${getFunctionName(ref)}`);
    return createMutation(ref, client, optimisticUpdate);
  };
  return mutation as unknown as ReactMutation<M>;
}

export function createAction<A extends Ref<"action">>(ref: A, client: BunvexReactClient): ReactAction<A> {
  return ((args?: Record<string, Value>) => client.action(ref, (args ?? {}) as FunctionArgs<A>)) as ReactAction<A>;
}

export class BunvexReactClient {
  private readonly address: string;
  private cachedSync: BaseClientInterface | undefined;
  private listeners = new Map<QueryToken, Set<() => void>>();
  private readonly options: BunvexReactClientOptions;
  private closed = false;
  private adminAuth: string | undefined;

  /** @param address - The deployment's URL, e.g. `http://localhost:3210`. */
  constructor(address: string, options: BunvexReactClientOptions = {}) {
    if (address === undefined)
      throw new Error(
        "No address provided to BunvexReactClient.\nIf running locally, make sure the server is running and the URL environment variable is set.",
      );
    if (typeof address !== "string")
      throw new Error(
        `BunvexReactClient requires a URL like 'http://localhost:3210', received something of type ${typeof address} instead.`,
      );
    if (!address.includes("://")) throw new Error("Provided address was not an absolute URL.");
    this.address = address;
    this.options = options;
  }

  get url(): string {
    return this.address;
  }

  /** The base client, created on first use. */
  get sync(): BaseClientInterface {
    if (this.closed) throw new Error("BunvexReactClient has already been closed.");
    if (this.cachedSync) return this.cachedSync;
    const sync = this.options.baseClient ?? new BaseBunvexClient(this.address, () => {}, this.options);
    sync.addOnTransitionHandler((t) => this.transition(t.queries.map((q) => q.token)));
    if (this.adminAuth) sync.setAdminAuth(this.adminAuth);
    this.cachedSync = sync;
    return sync;
  }

  /** @internal An admin key (the dashboard). */
  setAdminAuth(token: string) {
    this.adminAuth = token;
    if (this.closed) throw new Error("BunvexReactClient has already been closed.");
    if (this.cachedSync) this.sync.setAdminAuth(token);
  }

  /**
   * Authenticate with the tokens `fetchToken` returns; it is called again when a token is about to expire or
   * the server refuses one. Return null when there is no token. `onChange` hears whether the server accepted
   * it; `onRefreshChange` is true while a replacement for a refused token is fetched.
   */
  setAuth(
    fetchToken: AuthTokenFetcher,
    onChange?: (isAuthenticated: boolean) => void,
    onRefreshChange?: (isRefreshing: boolean) => void,
  ) {
    if (typeof fetchToken === "string")
      throw new Error(
        "Passing a string to BunvexReactClient.setAuth is no longer supported, please upgrade to passing in an async function to handle reauthentication.",
      );
    this.sync.setAuth(fetchToken, onChange ?? (() => {}), onRefreshChange);
  }

  /** Clear the current authentication token, if any. */
  clearAuth() {
    this.sync.clearAuth();
  }

  /** Watch a query: nothing is subscribed until the first `onUpdate`. */
  watchQuery<Q extends Ref<"query">>(
    query: Q,
    args?: FunctionArgs<Q>,
    options?: WatchQueryOptions,
  ): Watch<FunctionReturnType<Q>> {
    const name = getFunctionName(query);
    const argsObject = (args ?? {}) as Record<string, Value>;
    return {
      onUpdate: (callback) => {
        const { queryToken, unsubscribe } = this.sync.subscribe(name, argsObject, options);
        const set = this.listeners.get(queryToken);
        if (set) set.add(callback);
        else this.listeners.set(queryToken, new Set([callback]));
        return () => {
          if (this.closed) return;
          const current = this.listeners.get(queryToken)!;
          current.delete(callback);
          if (current.size === 0) this.listeners.delete(queryToken);
          unsubscribe();
        };
      },
      localQueryResult: () => this.cachedSync?.localQueryResult(name, argsObject) as FunctionReturnType<Q> | undefined,
      localQueryLogs: () => this.cachedSync?.localQueryLogs(name, argsObject),
      journal: () => this.cachedSync?.queryJournal(name, argsObject),
    };
  }

  /** Subscribe to a query ahead of the component that will use it, for `extendSubscriptionFor` ms (5 s). */
  prewarmQuery<Q extends Ref<"query">>(opts: { query: Q; args?: FunctionArgs<Q>; extendSubscriptionFor?: number }) {
    const unsubscribe = this.watchQuery(opts.query, opts.args).onUpdate(() => {});
    setTimeout(unsubscribe, opts.extendSubscriptionFor ?? DEFAULT_EXTEND_SUBSCRIPTION_FOR);
  }

  mutation<M extends Ref<"mutation">>(
    mutation: M,
    args?: FunctionArgs<M>,
    options?: MutationOptions<FunctionArgs<M>>,
  ): Promise<FunctionReturnType<M>> {
    return this.sync.mutation(
      getFunctionName(mutation),
      args as Record<string, Value>,
      options as MutationOptions<Record<string, Value>>,
    ) as Promise<FunctionReturnType<M>>;
  }

  action<A extends Ref<"action">>(action: A, args?: FunctionArgs<A>): Promise<FunctionReturnType<A>> {
    return this.sync.action(getFunctionName(action), args as Record<string, Value>) as Promise<FunctionReturnType<A>>;
  }

  /** One result of a query: the local one if any, else subscribe until the first result. */
  query<Q extends Ref<"query">>(query: Q, args?: FunctionArgs<Q>): Promise<FunctionReturnType<Q>> {
    const watch = this.watchQuery(query, args);
    const existing = watch.localQueryResult();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const unsubscribe = watch.onUpdate(() => {
        unsubscribe();
        try {
          resolve(watch.localQueryResult() as FunctionReturnType<Q>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  connectionState(): ConnectionState {
    return this.sync.connectionState();
  }

  subscribeToConnectionState(cb: (connectionState: ConnectionState) => void): () => void {
    return this.sync.subscribeToConnectionState(cb);
  }

  get logger(): Logger | boolean | undefined {
    return this.options.logger;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners = new Map();
    if (this.cachedSync) {
      const sync = this.cachedSync;
      this.cachedSync = undefined;
      await sync.close();
    }
  }

  private transition(updated: QueryToken[]) {
    for (const token of updated) {
      const callbacks = this.listeners.get(token);
      if (callbacks) for (const cb of callbacks) cb();
    }
  }
}

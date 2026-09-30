// `BunvexClient`, the counterpart of Convex's `ConvexClient` (`browser/simple_client.ts`): subscriptions by
// callback, one-shot queries, mutations and actions, for code that is not React (STUDY-26 §1.5). The
// paginated `onPaginatedUpdate` and `setAuth` come later (STUDY-26 C6).
import {
  type AnyFunctionReference,
  type FunctionArgs,
  type FunctionReturnType,
  getFunctionName,
} from "@bunvex/protocol";
import type { Value } from "@bunvex/values";
import {
  BaseBunvexClient,
  type BaseBunvexClientOptions,
  type ConnectionState,
  type MutationOptions,
  validateDeploymentUrl,
} from "./base-client.ts";
import { isBrowser } from "./browser.ts";
import type { QueryToken } from "./udf-path.ts";

type Ref<T extends "query" | "mutation" | "action"> = AnyFunctionReference & { _type: T };

export type BunvexClientOptions = BaseBunvexClientOptions & {
  /** A disabled client does nothing: for server-side rendering, where no socket should be opened. */
  disabled?: boolean;
};

/**
 * What `onUpdate` returns: call it to unsubscribe, or use its properties.
 */
export type Unsubscribe<T> = {
  (): void;
  unsubscribe(): void;
  /** The current local value, if any (a failed query throws). */
  getCurrentValue(): T | undefined;
  getQueryLogs(): string[] | undefined;
};

type QueryInfo = {
  callback: (result: unknown, meta: unknown) => unknown;
  onError: ((e: Error, meta: unknown) => unknown) | undefined;
  unsubscribe: () => void;
  queryToken: QueryToken;
  hasEverRun: boolean;
};

export class BunvexClient {
  private listeners = new Set<QueryInfo>();
  private _client: BaseBunvexClient | undefined;
  /** A synthetic transition that runs new callbacks whose result is already in memory. */
  private callNewListenersWithCurrentValuesTimer: ReturnType<typeof setTimeout> | undefined;
  private _closed = false;
  private readonly _disabled: boolean;

  get closed(): boolean {
    return this._closed;
  }
  get disabled(): boolean {
    return this._disabled;
  }
  get client(): BaseBunvexClient {
    if (this._client) return this._client;
    throw new Error("BunvexClient is disabled");
  }

  /** @param address - The deployment's URL, e.g. `http://localhost:3210`. */
  constructor(address: string, options: BunvexClientOptions = {}) {
    if (options.skipDeploymentUrlCheck !== true) validateDeploymentUrl(address);
    const { disabled, ...baseOptions } = options;
    this._disabled = !!disabled;
    if (!isBrowser() && !("unsavedChangesWarning" in baseOptions)) baseOptions.unsavedChangesWarning = false;
    if (!this._disabled) {
      this._client = new BaseBunvexClient(address, (tokens) => this.transition(tokens), baseOptions);
    }
  }

  /**
   * Call `callback` with every new result of a query. If a result is already in memory, the callback runs
   * soon after registering. Without `onError`, a failed query's error is raised (without unsubscribing).
   */
  onUpdate<Q extends Ref<"query">>(
    query: Q | string,
    args: FunctionArgs<Q>,
    callback: (result: FunctionReturnType<Q>) => unknown,
    onError?: (e: Error) => unknown,
  ): Unsubscribe<FunctionReturnType<Q>> {
    if (this.disabled) return this.disabledUnsubscribe();
    const { queryToken, unsubscribe } = this.client.subscribe(getFunctionName(query), args as Record<string, Value>);
    const info: QueryInfo = {
      queryToken,
      callback: callback as QueryInfo["callback"],
      onError,
      unsubscribe,
      hasEverRun: false,
    };
    this.listeners.add(info);
    if (this.client.hasLocalQueryResultByToken(queryToken) && this.callNewListenersWithCurrentValuesTimer === undefined)
      this.callNewListenersWithCurrentValuesTimer = setTimeout(() => this.callNewListenersWithCurrentValues(), 0);
    const props = {
      unsubscribe: () => {
        if (this.closed) return; // every unsubscribe already ran
        this.listeners.delete(info);
        unsubscribe();
      },
      getCurrentValue: () => this.client.localQueryResultByToken(queryToken) as FunctionReturnType<Q> | undefined,
      getQueryLogs: () => this.client.localQueryLogs(queryToken),
    };
    return Object.assign(props.unsubscribe, props) as Unsubscribe<FunctionReturnType<Q>>;
  }

  private callNewListenersWithCurrentValues() {
    this.callNewListenersWithCurrentValuesTimer = undefined;
    this.transition([], true);
  }

  private disabledUnsubscribe<T>(): Unsubscribe<T> {
    const fn = () => {};
    return Object.assign(fn, { unsubscribe: fn, getCurrentValue: () => undefined, getQueryLogs: () => undefined });
  }

  /** Run the callbacks of the updated queries (and, for a synthetic transition, new ones with a result). */
  private transition(updatedQueries: QueryToken[], callNewListeners = false) {
    const updated = new Set(updatedQueries);
    for (const info of this.listeners) {
      const { callback, queryToken, onError, hasEverRun } = info;
      if (
        !(
          updated.has(queryToken) ||
          (callNewListeners && !hasEverRun && this.client.hasLocalQueryResultByToken(queryToken))
        )
      )
        continue;
      info.hasEverRun = true;
      let value: unknown;
      try {
        value = this.client.localQueryResultByToken(queryToken);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (onError) onError(error, "Second argument to onUpdate onError is reserved for later use");
        // Make some noise without unsubscribing or failing the other callbacks.
        else void Promise.reject(error);
        continue;
      }
      callback(value, "Second argument to onUpdate callback is reserved for later use");
    }
  }

  async mutation<M extends Ref<"mutation">>(
    mutation: M | string,
    args: FunctionArgs<M>,
    options?: MutationOptions,
  ): Promise<Awaited<FunctionReturnType<M>>> {
    if (this.disabled) throw new Error("BunvexClient is disabled");
    return (await this.client.mutation(getFunctionName(mutation), args as Record<string, Value>, options)) as Awaited<
      FunctionReturnType<M>
    >;
  }

  async action<A extends Ref<"action">>(
    action: A | string,
    args: FunctionArgs<A>,
  ): Promise<Awaited<FunctionReturnType<A>>> {
    if (this.disabled) throw new Error("BunvexClient is disabled");
    return (await this.client.action(getFunctionName(action), args as Record<string, Value>)) as Awaited<
      FunctionReturnType<A>
    >;
  }

  /** One result of a query: the local one when subscribed, else subscribe until the first result. */
  async query<Q extends Ref<"query">>(
    query: Q | string,
    args: FunctionArgs<Q>,
  ): Promise<Awaited<FunctionReturnType<Q>>> {
    if (this.disabled) throw new Error("BunvexClient is disabled");
    const value = this.client.localQueryResult(getFunctionName(query), args as Record<string, Value>);
    if (value !== undefined) return value as Awaited<FunctionReturnType<Q>>;
    return new Promise((resolve, reject) => {
      const { unsubscribe } = this.onUpdate(
        query,
        args,
        (v) => {
          unsubscribe();
          resolve(v as Awaited<FunctionReturnType<Q>>);
        },
        (e) => {
          unsubscribe();
          reject(e);
        },
      );
    });
  }

  connectionState(): ConnectionState {
    if (this.disabled) throw new Error("BunvexClient is disabled");
    return this.client.connectionState();
  }

  subscribeToConnectionState(cb: (connectionState: ConnectionState) => void): () => void {
    if (this.disabled) return () => {};
    return this.client.subscribeToConnectionState(cb);
  }

  /** @internal */
  setAdminAuth(token: string) {
    if (this.closed) throw new Error("BunvexClient has already been closed.");
    if (this.disabled) return;
    this.client.setAdminAuth(token);
  }

  async close(): Promise<void> {
    if (this.disabled) return;
    this.listeners.clear();
    this._closed = true;
    return this.client.close();
  }
}

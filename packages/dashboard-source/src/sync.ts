// The dashboard's sync connection, as Convex's (`dashboard-common/src/lib/deploymentContext.tsx`, STUDY-149
// §1.1): one `BaseBunvexClient` signed in with the admin key before anything subscribes, so every system
// query is a live subscription and every write a WebSocket request. On top of it: callbacks per query
// (subscriptions are shared by token, as the client's), one-shot queries (subscribe until the first result,
// as Convex's `client.query`), and the connection watcher Convex's dashboard polls.
import { BaseBunvexClient, type ConnectionState, type FunctionResult, type QueryToken } from "@bunvex/client";
import { DataSourceError } from "@bunvex/dashboard/data-source";

/** A system function's arguments: plain JSON here (the client's `Value` without its bigint and bytes). */
// biome-ignore lint/suspicious/noExplicitAny: the client's Value, without importing @bunvex/values
export type Args = Record<string, any>;

export type AdminSyncOptions = {
  url: string;
  adminKey: string;
  /** Default: the global `WebSocket`. */
  webSocketConstructor?: typeof WebSocket;
  /**
   * The user an admin acts as (Convex's `setAdminAuth(key, identity)`, the runner's "Act as a user"): its claims,
   * in the client's values. Default: none, the admin itself.
   */
  impersonating?: Record<string, unknown>;
};

type Listener = { onResult: (r: FunctionResult) => void; delivered: boolean };

/** A failed system call's error: a permission refusal is `unauthorized`, anything else `unavailable`. */
export function errorOfFailure(udfPath: string, f: Extract<FunctionResult, { success: false }>): DataSourceError {
  const unauthorized = /permission|not authorized|deploy key was invalid|admin key/i.test(f.errorMessage);
  return new DataSourceError(unauthorized ? "unauthorized" : "unavailable", `${udfPath}: ${f.errorMessage}`);
}

export class AdminSync {
  readonly client: BaseBunvexClient;
  private readonly listeners = new Map<QueryToken, Set<Listener>>();
  private closed = false;

  constructor(opts: AdminSyncOptions) {
    this.client = new BaseBunvexClient(opts.url, () => {}, {
      unsavedChangesWarning: false,
      logger: false,
      ...(opts.webSocketConstructor && { webSocketConstructor: opts.webSocketConstructor }),
    });
    // Before anything subscribes, as Convex's DeploymentApiProvider.
    // biome-ignore lint/suspicious/noExplicitAny: the claims, as the client's JSON value
    this.client.setAdminAuth(opts.adminKey, opts.impersonating as any);
    this.client.addOnTransitionHandler((t) => {
      for (const q of t.queries) {
        if (q.modification.kind !== "Updated" || q.modification.result === undefined) continue;
        for (const l of this.listeners.get(q.token) ?? []) {
          l.delivered = true;
          l.onResult(q.modification.result);
        }
      }
    });
  }

  /**
   * Calls `onResult` with each new result of a query (a failure too), never synchronously; a result the
   * client already holds is delivered on the next tick. Returns the unsubscribe.
   */
  watch(udfPath: string, args: Args, onResult: (r: FunctionResult) => void): () => void {
    if (this.closed) throw new DataSourceError("unavailable", "The data source is closed.");
    const { queryToken, unsubscribe } = this.client.subscribe(udfPath, args);
    const listener: Listener = { onResult, delivered: false };
    const set = this.listeners.get(queryToken) ?? new Set<Listener>();
    this.listeners.set(queryToken, set);
    set.add(listener);
    if (this.client.hasLocalQueryResultByToken(queryToken))
      setTimeout(() => {
        if (listener.delivered || !set.has(listener)) return;
        // The result may be gone by now: one kept from a subscription just dropped, then cleared by a server
        // transition that answered the older query set. The new subscription's own result comes as a transition.
        if (!this.client.hasLocalQueryResultByToken(queryToken)) return;
        listener.delivered = true;
        onResult(this.localResult(queryToken));
      }, 0);
    return () => {
      if (!set.delete(listener)) return;
      if (set.size === 0) this.listeners.delete(queryToken);
      unsubscribe();
    };
  }

  private localResult(token: QueryToken): FunctionResult {
    const logLines = this.client.localQueryLogsByToken(token) ?? [];
    try {
      return { success: true, value: this.client.localQueryResultByToken(token) ?? null, logLines };
    } catch (e) {
      return { success: false, errorMessage: e instanceof Error ? e.message : String(e), logLines };
    }
  }

  /** A query's current result, once: subscribed until the first result arrives (Convex's `client.query`). */
  async query<T>(udfPath: string, args: Args = {}, signal?: AbortSignal): Promise<T> {
    const r = await this.result(udfPath, args, signal);
    if (!r.success) throw errorOfFailure(udfPath, r);
    return r.value as T;
  }

  /** `query`'s first result as the client gives it: its value or its error, with its log lines (the runner's). */
  result(udfPath: string, args: Args = {}, signal?: AbortSignal): Promise<FunctionResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<FunctionResult>((resolve, reject) => {
      let off = () => {};
      const onAbort = () => {
        off();
        reject(signal?.reason);
      };
      off = this.watch(udfPath, args, (r) => {
        off();
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** A mutation over the socket, as Convex's runner and data screens (`mutationInternal`). */
  async mutation<T>(udfPath: string, args: Args = {}): Promise<T> {
    const r = await this.client.mutationInternal(udfPath, args);
    if (!r.success) throw errorOfFailure(udfPath, r);
    return r.value as T;
  }

  /** An action over the socket (`actionInternal`). */
  async action<T>(udfPath: string, args: Args = {}): Promise<T> {
    const r = await this.client.actionInternal(udfPath, args);
    if (!r.success) throw errorOfFailure(udfPath, r);
    return r.value as T;
  }

  connectionState(): ConnectionState {
    return this.client.connectionState();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.listeners.clear();
    return this.client.close();
  }
}

/** What the connection watcher reports: Convex's `Connected`, `Disconnected` and `Unknown`. */
export type ConnectionStatus = "connected" | "disconnected" | "unknown";

/** Convex's dashboard polls the client's connection state this often (`connectionStateCheckIntervalMs`). */
export const CONNECTION_CHECK_MS = 2500;

type Observed = { connected: boolean; at: number };

/**
 * One step of Convex's connection watcher (`deploymentContext.tsx` `handleConnectionStateChange`): nothing
 * known without a previous observation or when it is stale (older than two intervals, a backgrounded tab);
 * disconnected only when the socket was down at two observations in a row; connected whenever it is up.
 */
export function nextConnectionStatus(
  now: Observed,
  previous: Observed | null,
  intervalMs = CONNECTION_CHECK_MS,
): ConnectionStatus {
  if (previous === null || previous.at < now.at - intervalMs * 2) return "unknown";
  if (!now.connected) return previous.connected ? "unknown" : "disconnected";
  return "connected";
}

/** Runs `tick` every `ms` until the returned stop is called (tests pass their own, to drive the ticks). */
export type Every = (tick: () => void, ms: number) => () => void;

const everyInterval: Every = (tick, ms) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

/**
 * Polls `state()` every `intervalMs` and reports each status change to `onStatus` (never synchronously).
 * Returns the stop.
 */
export function watchConnection(
  state: () => ConnectionState,
  onStatus: (s: ConnectionStatus) => void,
  intervalMs = CONNECTION_CHECK_MS,
  clock: () => number = Date.now,
  every: Every = everyInterval,
): () => void {
  let previous: Observed | null = null;
  let last: ConnectionStatus | null = null;
  return every(() => {
    const now = { connected: state().isWebSocketConnected, at: clock() };
    const status = nextConnectionStatus(now, previous, intervalMs);
    previous = now;
    if (status !== last) {
      last = status;
      onStatus(status);
    }
  }, intervalMs);
}

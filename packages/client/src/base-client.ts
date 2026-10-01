// The base sync client, as Convex's `BaseConvexClient` (`sync/client.ts`, STUDY-26 §1.1): it keeps the
// subscriptions (local-state.ts), the results the server sent (remote-query-set.ts), the requests in flight
// (request-manager.ts) and the optimistic view (optimistic-updates.ts), over one socket that reconnects by
// itself (web-socket-manager.ts). Friendlier clients (BunvexClient, the React client) are built around it.
import type { v1 } from "@bunvex/protocol";
import { toJsonValue, type Value } from "@bunvex/values";
import { parseArgs } from "./args.ts";
import { AuthenticationManager, type AuthTokenFetcher, decodeJwtPayload } from "./authentication-manager.ts";
import { browserWindow } from "./browser.ts";
import type { FunctionResult } from "./function-result.ts";
import { LocalSyncState } from "./local-state.ts";
import { errorFor, instantiateDefaultLogger, instantiateNoopLogger, type Logger, logFatalError } from "./logging.ts";
import {
  type OptimisticLocalStore,
  OptimisticQueryResults,
  type OptimisticUpdate,
  type QueryResultsMap,
} from "./optimistic-updates.ts";
import { RemoteQuerySet } from "./remote-query-set.ts";
import { RequestManager } from "./request-manager.ts";
import { newSessionId } from "./session.ts";
import { type QueryToken, serializePathAndArgs } from "./udf-path.ts";
import { VERSION } from "./version.ts";
import { type ReconnectMetadata, WebSocketManager, type WebSocketManagerOptions } from "./web-socket-manager.ts";

export type BaseBunvexClientOptions = {
  /** Prompt before leaving the page while a request is unanswered (browsers only). Default: on in browsers. */
  unsavedChangesWarning?: boolean;
  /** The WebSocket constructor; default: the global `WebSocket`. */
  webSocketConstructor?: typeof WebSocket;
  /** Extra debug logging. Default: off. */
  verbose?: boolean;
  /** A logger, `true` (console, the default) or `false` (nowhere). */
  logger?: Logger | boolean;
  /** Called with abnormal close messages from the server (not a stable interface). */
  onServerDisconnectError?: (message: string) => void;
  /** Skip checking that the address is an http(s) URL. Default: false. */
  skipDeploymentUrlCheck?: boolean;
  /** Reconnect timings (tests shorten them). */
  webSocket?: WebSocketManagerOptions;
  /** With auth: refresh a token this many seconds before it expires. Default: 10. */
  authRefreshTokenLeewaySeconds?: number;
  /**
   * Experimental. Hold back queries, mutations and actions until the first auth token can be sent: for pages
   * only signed-in users see. Default: false.
   */
  expectAuth?: boolean;
  /**
   * Experimental. Keep using the first (possibly cached) token once the server accepts it, instead of fetching
   * a fresh one at once, which would make the server run every authenticated query again. A refresh is still
   * scheduled before it expires (by the server's clock skew). Default: false.
   */
  initialAuthTokenReuse?: boolean;
};

export type ConnectionState = {
  hasInflightRequests: boolean;
  isWebSocketConnected: boolean;
  timeOfOldestInflightRequest: Date | null;
  /** True once a socket has reached "ready". */
  hasEverConnected: boolean;
  /** Connections made so far. */
  connectionCount: number;
  /** Failed connection attempts since the last healthy sync. */
  connectionRetries: number;
  inflightMutations: number;
  inflightActions: number;
};

export type SubscribeOptions = { journal?: v1.QueryJournal; componentPath?: string };
export type MutationOptions = { optimisticUpdate?: OptimisticUpdate<Record<string, Value>> };

/** A query's change in a transition (`result` undefined: loading, e.g. set so by an optimistic update). */
export type QueryModification = { kind: "Updated"; result: FunctionResult | undefined } | { kind: "Removed" };
/** What an `onTransition` handler receives: from the server, or from an optimistic update applied locally. */
export type Transition = {
  queries: { token: QueryToken; modification: QueryModification }[];
  reflectedMutations: { requestId: v1.RequestId; result: FunctionResult }[];
  timestamp: bigint;
};

/** The address checks Convex's `validateDeploymentUrl` makes. */
export function validateDeploymentUrl(address: unknown) {
  if (typeof address === "undefined")
    throw new Error(
      "Client created with undefined deployment address. If you used an environment variable, check that it's set.",
    );
  if (typeof address !== "string") throw new Error(`Invalid deployment address: found ${address as string}".`);
  if (!(address.startsWith("http:") || address.startsWith("https:")))
    throw new Error(`Invalid deployment address: Must start with "https://" or "http://". Found "${address}".`);
  try {
    new URL(address);
  } catch {
    throw new Error(
      `Invalid deployment address: "${address}" is not a valid URL. If you believe this URL is correct, use the \`skipDeploymentUrlCheck\` option to bypass this.`,
    );
  }
}

export class BaseBunvexClient {
  private readonly address: string;
  private readonly state = new LocalSyncState();
  private readonly requestManager: RequestManager;
  private readonly webSocketManager: WebSocketManager;
  private readonly authenticationManager: AuthenticationManager;
  private remoteQuerySet: RemoteQuerySet;
  private readonly optimisticQueryResults = new OptimisticQueryResults();
  private transitionHandlerCounter = 0;
  private _nextRequestId: v1.RequestId = 0;
  private readonly onTransitionFns = new Map<number, (transition: Transition) => void>();
  private readonly _sessionId = newSessionId();
  private readonly logger: Logger;
  private maxObservedTimestamp: bigint | undefined;
  private readonly connectionStateSubscribers = new Map<number, (s: ConnectionState) => void>();
  private nextConnectionStateSubscriberId = 0;
  private lastPublishedConnectionState: ConnectionState | undefined;

  /**
   * @param address - The deployment's URL, e.g. `http://localhost:3210`.
   * @param onTransition - Called with the tokens of the queries whose results changed.
   */
  constructor(
    address: string,
    onTransition: (updatedQueries: QueryToken[]) => void,
    options: BaseBunvexClientOptions = {},
  ) {
    if (options.skipDeploymentUrlCheck !== true) validateDeploymentUrl(address);
    const webSocketConstructor =
      options.webSocketConstructor ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
    if (!webSocketConstructor)
      throw new Error(
        "No WebSocket global variable defined! To use bunvex in an environment without WebSocket, pass `webSocketConstructor`.",
      );
    this.address = address;
    const verbose = options.verbose ?? false;
    this.logger =
      options.logger === false
        ? instantiateNoopLogger({ verbose })
        : options.logger !== true && options.logger
          ? options.logger
          : instantiateDefaultLogger({ verbose });
    const i = address.search("://");
    if (i === -1) throw new Error("Provided address was not an absolute URL.");
    const protocol = address.substring(0, i);
    const wsProtocol = protocol === "http" ? "ws" : protocol === "https" ? "wss" : null;
    if (wsProtocol === null) throw new Error(`Unknown parent protocol ${protocol}`);
    const wsUri = `${wsProtocol}://${address.substring(i + 3)}/api/${VERSION}/sync`;

    this.remoteQuerySet = new RemoteQuerySet((id) => this.state.queryPath(id), this.logger);
    this.requestManager = new RequestManager(this.logger, this.markConnectionStateDirty);
    this.addOnTransitionHandler((t) => onTransition(t.queries.map((q) => q.token)));

    const unsavedChangesWarning = options.unsavedChangesWarning;
    const win = browserWindow();
    if (!win) {
      if (unsavedChangesWarning === true)
        throw new Error(
          "unsavedChangesWarning requested, but window.addEventListener not found! Remove {unsavedChangesWarning: true} from the client options.",
        );
    } else if (unsavedChangesWarning !== false) {
      win.addEventListener("beforeunload", (e) => {
        if (!this.requestManager.hasIncompleteRequests()) return;
        e.preventDefault();
        const confirmationMessage = "Are you sure you want to leave? Your changes may not be saved.";
        e.returnValue = confirmationMessage;
        return confirmationMessage;
      });
    }

    const pauseSocket = () => {
      this.webSocketManager.pause();
      this.state.pause();
    };
    this.authenticationManager = new AuthenticationManager(
      this.state,
      {
        authenticate: (token) => {
          const message = this.state.setAuth(token);
          this.webSocketManager.sendMessage(message);
          return message.baseVersion;
        },
        stopSocket: () => this.webSocketManager.stop(),
        tryRestartSocket: () => this.webSocketManager.tryRestart(),
        pauseSocket,
        resumeSocket: () => this.webSocketManager.resume(),
        clearAuth: () => this.clearAuth(),
      },
      {
        logger: this.logger,
        refreshTokenLeewaySeconds: options.authRefreshTokenLeewaySeconds ?? 10,
        initialAuthTokenReuse: options.initialAuthTokenReuse ?? false,
      },
    );

    this.webSocketManager = new WebSocketManager(
      wsUri,
      {
        onOpen: (reconnect: ReconnectMetadata) => this.onOpen(reconnect),
        onResume: () => {
          const [querySet, auth] = this.state.resume();
          if (auth) this.webSocketManager.sendMessage(auth);
          if (querySet) this.webSocketManager.sendMessage(querySet);
          for (const m of this.requestManager.resume()) this.webSocketManager.sendMessage(m);
        },
        onMessage: (m) => this.onMessage(m),
        onServerDisconnectError: options.onServerDisconnectError,
      },
      webSocketConstructor,
      this.logger,
      this.markConnectionStateDirty,
      options.webSocket,
    );
    // Start paused, waiting for the first auth token.
    if (options.expectAuth) pauseSocket();
  }

  /** A new socket: Connect, then the whole query set, auth, and every request not yet reflected. */
  private onOpen(reconnect: ReconnectMetadata) {
    this.webSocketManager.sendMessage({
      type: "Connect",
      sessionId: this._sessionId,
      connectionCount: reconnect.connectionCount,
      lastCloseReason: reconnect.lastCloseReason,
      clientTs: reconnect.clientTs,
      ...(this.maxObservedTimestamp === undefined ? {} : { maxObservedTimestamp: this.maxObservedTimestamp }),
    });
    this.remoteQuerySet = new RemoteQuerySet((id) => this.state.queryPath(id), this.logger);
    const [querySet, auth] = this.state.restart();
    if (auth) this.webSocketManager.sendMessage(auth);
    this.webSocketManager.sendMessage(querySet);
    for (const m of this.requestManager.restart()) this.webSocketManager.sendMessage(m);
  }

  private onMessage(m: v1.ServerMessage) {
    switch (m.type) {
      case "Transition": {
        this.observedTimestamp(m.endVersion.ts);
        this.authenticationManager.onTransition(m);
        this.remoteQuerySet.transition(m);
        this.state.transition(m);
        const completed = this.requestManager.removeCompleted(this.remoteQuerySet.timestamp());
        this.notifyOnQueryResultChanges(completed);
        break;
      }
      case "MutationResponse": {
        if (m.success) this.observedTimestamp(m.ts);
        const done = this.requestManager.onResponse(m);
        if (done !== null) this.notifyOnQueryResultChanges(new Map([[done.requestId, done.result]]));
        break;
      }
      case "ActionResponse":
        this.requestManager.onResponse(m);
        break;
      case "AuthError":
        this.authenticationManager.onAuthError(m);
        break;
      case "FatalError": {
        const error = logFatalError(this.logger, m.error);
        void this.webSocketManager.terminate();
        throw error;
      }
      case "Ping":
      case "TransitionChunk":
        break; // handled by the socket manager
    }
    return { hasSyncedPastLastReconnect: this.hasSyncedPastLastReconnect() };
  }

  /** Whether everything from before the last reconnect has been answered (the backoff resets only then). */
  private hasSyncedPastLastReconnect() {
    return this.requestManager.hasSyncedPastLastReconnect() && this.state.hasSyncedPastLastReconnect();
  }

  private observedTimestamp(ts: bigint) {
    if (this.maxObservedTimestamp === undefined || this.maxObservedTimestamp <= ts) this.maxObservedTimestamp = ts;
  }

  /** The latest ts this client has seen, sent in `Connect` so a server behind it refuses (STUDY-26 C5). */
  getMaxObservedTimestamp(): bigint | undefined {
    return this.maxObservedTimestamp;
  }

  /** Rebuild the view from the server's results and the optimistic updates still pending; notify changes. */
  private notifyOnQueryResultChanges(completedRequests: Map<v1.RequestId, FunctionResult>) {
    const serverResults: QueryResultsMap = new Map();
    for (const [queryId, result] of this.remoteQuerySet.remoteQueryResults()) {
      const token = this.state.queryToken(queryId);
      // Already unsubscribed, but the server does not know yet: ignore.
      if (token !== null)
        serverResults.set(token, {
          result,
          udfPath: this.state.queryPath(queryId)!,
          args: this.state.queryArgs(queryId)!,
        });
    }
    const changed = this.optimisticQueryResults.ingestQueryResultsFromServer(
      serverResults,
      new Set(completedRequests.keys()),
    );
    this.handleTransition({
      queries: changed.map((token) => ({
        token,
        modification: { kind: "Updated" as const, result: this.optimisticQueryResults.rawQueryResult(token) },
      })),
      reflectedMutations: [...completedRequests].map(([requestId, result]) => ({ requestId, result })),
      timestamp: this.remoteQuerySet.timestamp(),
    });
  }

  private handleTransition(transition: Transition) {
    for (const fn of this.onTransitionFns.values()) fn(transition);
  }

  /** Add a handler called on every transition (server or optimistic); returns its removal. */
  addOnTransitionHandler(fn: (transition: Transition) => void): () => void {
    const id = this.transitionHandlerCounter++;
    this.onTransitionFns.set(id, fn);
    return () => this.onTransitionFns.delete(id);
  }

  /** The current user token and its claims, decoded locally (not verified); undefined without one. */
  getCurrentAuthClaims(): { token: string; decoded: Record<string, unknown> } | undefined {
    const auth = this.state.getAuth();
    if (auth?.tokenType !== "User") return undefined;
    return { token: auth.value, decoded: decodeJwtPayload(auth.value) ?? {} };
  }

  /**
   * Authenticate with the tokens `fetchToken` returns; it is called again before a token expires and when the
   * server refuses one. Return null when no token can be had (e.g. the user's access was revoked).
   * `onChange` hears whether the server accepted the auth; `onRefreshChange` is true while the socket is
   * paused to fetch a replacement for a token the server refused.
   */
  setAuth(
    fetchToken: AuthTokenFetcher,
    onChange: (isAuthenticated: boolean) => void,
    onRefreshChange?: (isRefreshing: boolean) => void,
  ) {
    void this.authenticationManager.setConfig(fetchToken, onChange, onRefreshChange);
  }

  hasAuth(): boolean {
    return this.state.hasAuth();
  }

  /** @internal An admin key (the dashboard), as Convex's `setAdminAuth`. */
  setAdminAuth(value: string, impersonating?: v1.JSONValue) {
    this.webSocketManager.sendMessage(this.state.setAdminAuth(value, impersonating));
  }

  clearAuth() {
    this.webSocketManager.sendMessage(this.state.clearAuth());
  }

  /** Subscribe to a query; `onTransition` hears when its result changes. Subscriptions are shared by token. */
  subscribe(
    name: string,
    args?: Record<string, Value>,
    options?: SubscribeOptions,
  ): { queryToken: QueryToken; unsubscribe: () => void } {
    const { modification, queryToken, unsubscribe } = this.state.subscribe(
      name,
      parseArgs(args),
      options?.journal,
      options?.componentPath,
    );
    if (modification !== null) this.webSocketManager.sendMessage(modification);
    return {
      queryToken,
      unsubscribe: () => {
        const m = unsubscribe();
        if (m) this.webSocketManager.sendMessage(m);
      },
    };
  }

  /** A query's current local value (subscribed, or set optimistically); a failed query throws. */
  localQueryResult(udfPath: string, args?: Record<string, Value>): Value | undefined {
    return this.optimisticQueryResults.queryResult(serializePathAndArgs(udfPath, parseArgs(args)));
  }

  /** @internal */
  localQueryResultByToken(queryToken: QueryToken): Value | undefined {
    return this.optimisticQueryResults.queryResult(queryToken);
  }

  /** @internal Whether a local result exists (errors included). */
  hasLocalQueryResultByToken(queryToken: QueryToken): boolean {
    return this.optimisticQueryResults.hasQueryResult(queryToken);
  }

  /** @internal A query's log lines from its last result. */
  localQueryLogs(udfPath: string, args?: Record<string, Value>): string[] | undefined {
    return this.optimisticQueryResults.queryLogs(serializePathAndArgs(udfPath, parseArgs(args)));
  }

  /** @internal */
  localQueryLogsByToken(queryToken: QueryToken): string[] | undefined {
    return this.optimisticQueryResults.queryLogs(queryToken);
  }

  /** The query's journal from its last result, if any. */
  queryJournal(name: string, args?: Record<string, Value>): v1.QueryJournal | undefined {
    return this.state.queryJournal(serializePathAndArgs(name, parseArgs(args)));
  }

  connectionState(): ConnectionState {
    const ws = this.webSocketManager.connectionState();
    return {
      hasInflightRequests: this.requestManager.hasInflightRequests(),
      isWebSocketConnected: ws.isConnected,
      hasEverConnected: ws.hasEverConnected,
      connectionCount: ws.connectionCount,
      connectionRetries: ws.connectionRetries,
      timeOfOldestInflightRequest: this.requestManager.timeOfOldestInflightRequest(),
      inflightMutations: this.requestManager.inflightMutations(),
      inflightActions: this.requestManager.inflightActions(),
    };
  }

  /** Publish the connection state once per microtask, and only when it changed. */
  private markConnectionStateDirty = () => {
    void Promise.resolve().then(() => {
      const current = this.connectionState();
      if (JSON.stringify(current) === JSON.stringify(this.lastPublishedConnectionState)) return;
      this.lastPublishedConnectionState = current;
      for (const cb of this.connectionStateSubscribers.values()) cb(current);
    });
  };

  subscribeToConnectionState(cb: (connectionState: ConnectionState) => void): () => void {
    const id = this.nextConnectionStateSubscriberId++;
    this.connectionStateSubscribers.set(id, cb);
    return () => this.connectionStateSubscribers.delete(id);
  }

  /** Run a mutation. Resolves once its write is visible in every subscription; a failure rejects at once. */
  async mutation(name: string, args?: Record<string, Value>, options?: MutationOptions): Promise<Value> {
    const result = await this.mutationInternal(name, args, options);
    if (!result.success) throw errorFor("mutation", name, result);
    return result.value;
  }

  /** @internal */
  mutationInternal(
    udfPath: string,
    args?: Record<string, Value>,
    options?: MutationOptions,
    componentPath?: string,
  ): Promise<FunctionResult> {
    return this.enqueueMutation(udfPath, args, options, componentPath).mutationPromise;
  }

  /** @internal */
  enqueueMutation(
    udfPath: string,
    args?: Record<string, Value>,
    options?: MutationOptions,
    componentPath?: string,
  ): { requestId: v1.RequestId; mutationPromise: Promise<FunctionResult> } {
    const mutationArgs = parseArgs(args);
    const requestId = this._nextRequestId++;
    const optimisticUpdate = options?.optimisticUpdate;
    if (optimisticUpdate !== undefined) {
      const wrapped = (store: OptimisticLocalStore) => {
        const r: unknown = optimisticUpdate(store, mutationArgs);
        if (r instanceof Promise)
          this.logger.warn("Optimistic update handler returned a Promise. Optimistic updates should be synchronous.");
      };
      const changed = this.optimisticQueryResults.applyOptimisticUpdate(wrapped, requestId);
      this.handleTransition({
        queries: changed.map((token) => {
          const local = this.localQueryResultByToken(token);
          return {
            token,
            modification: {
              kind: "Updated" as const,
              result: local === undefined ? undefined : { success: true as const, value: local, logLines: [] },
            },
          };
        }),
        reflectedMutations: [],
        timestamp: this.remoteQuerySet.timestamp(),
      });
    }
    const message: v1.MutationRequest = {
      type: "Mutation",
      requestId,
      udfPath,
      ...(componentPath === undefined ? {} : { componentPath }),
      args: [toJsonValue(mutationArgs) as v1.JSONValue],
    };
    const mightBeSent = this.webSocketManager.sendMessage(message);
    return { requestId, mutationPromise: this.requestManager.request(message, mightBeSent) };
  }

  /** Run an action. Not re-sent after a reconnect: an action in flight then fails. */
  async action(name: string, args?: Record<string, Value>): Promise<Value> {
    const result = await this.actionInternal(name, args);
    if (!result.success) throw errorFor("action", name, result);
    return result.value;
  }

  /** @internal */
  actionInternal(udfPath: string, args?: Record<string, Value>, componentPath?: string): Promise<FunctionResult> {
    const actionArgs = parseArgs(args);
    const requestId = this._nextRequestId++;
    const message: v1.ActionRequest = {
      type: "Action",
      requestId,
      udfPath,
      ...(componentPath === undefined ? {} : { componentPath }),
      args: [toJsonValue(actionArgs) as v1.JSONValue],
    };
    const mightBeSent = this.webSocketManager.sendMessage(message);
    return this.requestManager.request(message, mightBeSent);
  }

  /** Close the socket and stop every subscription. Resolves once the socket closed. */
  close(): Promise<void> {
    this.authenticationManager.stop();
    return this.webSocketManager.terminate();
  }

  get url(): string {
    return this.address;
  }

  /** @internal */
  get nextRequestId(): v1.RequestId {
    return this._nextRequestId;
  }

  /** @internal */
  get sessionId(): string {
    return this._sessionId;
  }
}

// The socket, as Convex's `sync/web_socket_manager.ts`: it connects, parses frames, reassembles
// TransitionChunks, and reconnects after any close with jittered exponential backoff. The backoff resets only
// once the client has "synced past the last reconnect" (everything re-sent was answered). With nothing
// received for 60 s (the server pings every 15 s) it closes and reconnects.
//
// States: disconnected → connecting → ready, plus stopped (auth, restartable) and terminated (final).
// `connecting` and `ready` have a paused sub-state, used while an auth token is fetched.
import { v1 } from "@bunvex/protocol";
import { browserWindow } from "./browser.ts";
import type { Logger } from "./logging.ts";

const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_NO_STATUS = 1005;
/** "Not found" during a push; retried (Convex's CLOSE_NOT_FOUND). */
const CLOSE_NOT_FOUND = 4040;
/** A transition frame longer than this is logged for everyone (Convex's 20_000_000, in string length). */
const LARGE_TRANSITION_LENGTH = 20_000_000;
/** A transition that took longer than this to arrive is logged for everyone (Convex's 20 s). */
const SLOW_TRANSITION_MS = 20_000;

type Socket =
  | { state: "disconnected" }
  | { state: "connecting"; ws: WebSocket; paused: "yes" | "no" }
  | { state: "ready"; ws: WebSocket; paused: "yes" | "no" | "uninitialized" }
  | { state: "stopped" }
  | { state: "terminated" };

export type ReconnectMetadata = { connectionCount: number; lastCloseReason: string | null; clientTs: number };
export type OnMessageResponse = { hasSyncedPastLastReconnect: boolean };

let firstTime: number | undefined;
function monotonicMillis() {
  if (firstTime === undefined) firstTime = Date.now();
  if (typeof performance === "undefined" || !performance.now) return Date.now();
  return Math.round(firstTime + performance.now());
}
const prettyNow = () => `t=${Math.round((monotonicMillis() - firstTime!) / 100) / 10}s`;

/** Close reasons the server sends (a prefix match), and the first backoff each deserves. */
const serverDisconnectErrors = {
  InternalServerError: { timeout: 1000 },
  SubscriptionsWorkerFullError: { timeout: 3000 },
  TooManyConcurrentRequests: { timeout: 3000 },
  CommitterFullError: { timeout: 3000 },
  AwsTooManyRequestsException: { timeout: 3000 },
  ExecuteFullError: { timeout: 3000 },
  SystemTimeoutError: { timeout: 3000 },
  ExpiredInQueue: { timeout: 3000 },
  VectorIndexesUnavailable: { timeout: 1000 },
  SearchIndexesUnavailable: { timeout: 1000 },
  TableSummariesUnavailable: { timeout: 1000 },
  VectorIndexTooLarge: { timeout: 3000 },
  SearchIndexTooLarge: { timeout: 3000 },
  TooManyWritesInTimePeriod: { timeout: 3000 },
} as const;
type ServerDisconnectError = keyof typeof serverDisconnectErrors | "Unknown";

function classifyDisconnectError(s?: string): ServerDisconnectError {
  if (s === undefined) return "Unknown";
  for (const prefix of Object.keys(serverDisconnectErrors) as (keyof typeof serverDisconnectErrors)[])
    if (s.startsWith(prefix)) return prefix;
  return "Unknown";
}

export type WebSocketManagerOptions = {
  /** First backoff for a close with no known reason (default 1 s), and the cap (default 16 s). */
  defaultInitialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Reconnect when nothing arrives for this long (default 60 s). */
  serverInactivityThresholdMs?: number;
};

export class WebSocketManager {
  private socket: Socket = { state: "disconnected" };
  private connectionCount = 0;
  private _hasEverConnected = false;
  private lastCloseReason: string | null = "InitialConnect";
  private transitionChunkBuffer: { chunks: string[]; totalParts: number; transitionId: string } | null = null;
  private readonly defaultInitialBackoff: number;
  private readonly maxBackoff: number;
  /** Consecutive failures. */
  private retries = 0;
  private readonly serverInactivityThreshold: number;
  private reconnectDueToServerInactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private scheduledReconnect: {
    timeout: ReturnType<typeof setTimeout>;
    scheduledAt: number;
    backoffMs: number;
  } | null = null;
  private networkOnlineHandler: (() => void) | null = null;

  constructor(
    private readonly uri: string,
    private readonly callbacks: {
      onOpen: (reconnectMetadata: ReconnectMetadata) => void;
      onResume: () => void;
      onMessage: (message: v1.ServerMessage) => OnMessageResponse;
      onServerDisconnectError?: ((message: string) => void) | undefined;
    },
    private readonly webSocketConstructor: typeof WebSocket,
    private readonly logger: Logger,
    private readonly markConnectionStateDirty: () => void,
    options: WebSocketManagerOptions = {},
  ) {
    this.defaultInitialBackoff = options.defaultInitialBackoffMs ?? 1000;
    this.maxBackoff = options.maxBackoffMs ?? 16000;
    // Pings come every 15 s, but one large transition can hog the line: the threshold is higher.
    this.serverInactivityThreshold = options.serverInactivityThresholdMs ?? 60000;
    this.setupNetworkListener();
    this.connect();
  }

  private setSocketState(state: Socket) {
    this.socket = state;
    this.logger.logVerbose(
      `socket state changed: ${state.state}, paused: ${"paused" in state ? state.paused : undefined}`,
    );
    this.markConnectionStateDirty();
  }

  private setupNetworkListener() {
    const win = browserWindow();
    if (!win || this.networkOnlineHandler !== null) return;
    this.networkOnlineHandler = () => this.tryReconnectImmediately();
    win.addEventListener("online", this.networkOnlineHandler);
  }

  private cleanupNetworkListener() {
    const win = browserWindow();
    if (this.networkOnlineHandler && win) {
      win.removeEventListener("online", this.networkOnlineHandler);
      this.networkOnlineHandler = null;
    }
  }

  private assembleTransition(chunk: v1.TransitionChunk): v1.Transition | null {
    const buf = this.transitionChunkBuffer;
    if (
      chunk.partNumber < 0 ||
      chunk.partNumber >= chunk.totalParts ||
      chunk.totalParts === 0 ||
      (buf && (buf.totalParts !== chunk.totalParts || buf.transitionId !== chunk.transitionId))
    ) {
      this.transitionChunkBuffer = null;
      throw new Error("Invalid TransitionChunk");
    }
    const b = buf ?? { chunks: [], totalParts: chunk.totalParts, transitionId: chunk.transitionId };
    this.transitionChunkBuffer = b;
    if (chunk.partNumber !== b.chunks.length) {
      this.transitionChunkBuffer = null;
      throw new Error(
        `TransitionChunk received out of order: expected part ${b.chunks.length}, got ${chunk.partNumber}`,
      );
    }
    b.chunks.push(chunk.chunk);
    if (b.chunks.length < chunk.totalParts) return null;
    this.transitionChunkBuffer = null;
    const transition = v1.parseServerMessage(b.chunks.join(""));
    if (transition.type !== "Transition")
      throw new Error(`Expected Transition, got ${transition.type} after assembling chunks`);
    return transition;
  }

  private connect() {
    if (this.socket.state === "terminated") return;
    if (this.socket.state !== "disconnected" && this.socket.state !== "stopped")
      throw new Error(`Didn't start connection from disconnected state: ${this.socket.state}`);
    const ws = new this.webSocketConstructor(this.uri);
    this.setSocketState({ state: "connecting", ws, paused: "no" });
    // Before onopen, so a handshake that never completes is caught too.
    this.resetServerInactivityTimeout();

    ws.onopen = () => {
      if (this.socket.state !== "connecting") throw new Error("onopen called with socket not in connecting state");
      this.setSocketState({ state: "ready", ws, paused: this.socket.paused === "yes" ? "uninitialized" : "no" });
      this.resetServerInactivityTimeout();
      if (this.socket.paused === "no") {
        this._hasEverConnected = true;
        this.callbacks.onOpen({
          connectionCount: this.connectionCount,
          lastCloseReason: this.lastCloseReason,
          clientTs: monotonicMillis(),
        });
      }
      if (this.lastCloseReason !== "InitialConnect") {
        if (this.lastCloseReason)
          this.logger.log("WebSocket reconnected at", prettyNow(), "after disconnect due to", this.lastCloseReason);
        else this.logger.log("WebSocket reconnected at", prettyNow());
      }
      this.connectionCount += 1;
      this.lastCloseReason = null;
    };
    // The WebSocket API calls onclose even when the connection fails: every error path goes through it.
    ws.onerror = (error) => {
      this.transitionChunkBuffer = null;
      const message = (error as ErrorEvent).message;
      if (message) this.logger.log(`WebSocket error message: ${message}`);
    };
    ws.onmessage = (message) => {
      this.resetServerInactivityTimeout();
      const frame = String(message.data);
      let serverMessage = v1.parseServerMessage(frame);
      // A Ping only resets the inactivity timer.
      if (serverMessage.type === "Ping") return;
      if (serverMessage.type === "TransitionChunk") {
        const transition = this.assembleTransition(serverMessage);
        if (!transition) return;
        serverMessage = transition;
      }
      if (this.transitionChunkBuffer !== null) {
        this.transitionChunkBuffer = null;
        this.logger.log(`Received unexpected ${serverMessage.type} while buffering TransitionChunks`);
      }
      // Measured on this frame, as Convex: for a chunked transition, the last chunk.
      if (serverMessage.type === "Transition") this.reportLargeTransition(serverMessage, frame.length);
      const response = this.callbacks.onMessage(serverMessage);
      if (response.hasSyncedPastLastReconnect) {
        this.retries = 0;
        this.markConnectionStateDirty();
      }
    };
    ws.onclose = (event) => {
      this.transitionChunkBuffer = null;
      if (this.lastCloseReason === null) this.lastCloseReason = event.reason || `closed with code ${event.code}`;
      if (
        event.code !== CLOSE_NORMAL &&
        event.code !== CLOSE_GOING_AWAY &&
        event.code !== CLOSE_NO_STATUS &&
        event.code !== CLOSE_NOT_FOUND
      ) {
        let msg = `WebSocket closed with code ${event.code}`;
        if (event.reason) msg += `: ${event.reason}`;
        this.logger.log(msg);
        if (this.callbacks.onServerDisconnectError && event.reason) this.callbacks.onServerDisconnectError(msg);
      }
      this.scheduleReconnect(classifyDisconnectError(event.reason));
    };
  }

  /**
   * As Convex's `reportLargeTransition`: a transition's transit time, from the server's clock when it sent it
   * (`serverTs`, ns) and the clock skew the server measured at Connect, logged verbosely; then, for everyone, a
   * frame over 20 MB, else a transit over 20 s. Nothing without both fields. Convex's debug `Event` is not sent
   * (DV-91), and its "more that 20MB" reads "more than" (DV-349).
   */
  private reportLargeTransition(transition: v1.Transition, frameLength: number) {
    if (transition.clientClockSkew === undefined || transition.serverTs === undefined) return;
    const transitMs = monotonicMillis() - transition.clientClockSkew - transition.serverTs / 1_000_000;
    const size = `${Math.round(frameLength / 10_000) / 100}MB`;
    const transit = `${Math.round(transitMs)}ms`;
    const rate = `${Math.round(frameLength / (transitMs / 1000) / 10_000) / 100}MB per second`;
    this.logger.logVerbose(`received ${size} transition in ${transit} at ${rate}`);
    if (frameLength > LARGE_TRANSITION_LENGTH)
      this.logger.log(
        `received query results totaling more than 20MB (${size}) which will take a long time to download on slower connections`,
      );
    else if (transitMs > SLOW_TRANSITION_MS)
      this.logger.log(`received query results totaling ${size} which took more than 20s to arrive (${transit})`);
  }

  socketState(): string {
    return this.socket.state;
  }

  /** Send now if ready and not paused. Returns whether the message (might have been) sent. */
  sendMessage(message: v1.ClientMessage): boolean {
    if (this.socket.state === "ready" && this.socket.paused === "no") {
      try {
        this.socket.ws.send(v1.encodeClientMessage(message));
      } catch (error) {
        this.logger.log(`Failed to send message on WebSocket, reconnecting: ${error}`);
        this.closeAndReconnect("FailedToSendMessage");
      }
      return true;
    }
    this.logger.logVerbose(`message not sent (socket state: ${this.socket.state}): ${message.type}`);
    return false;
  }

  private resetServerInactivityTimeout() {
    if (this.socket.state === "terminated") return;
    if (this.reconnectDueToServerInactivityTimeout !== null) clearTimeout(this.reconnectDueToServerInactivityTimeout);
    this.reconnectDueToServerInactivityTimeout = setTimeout(
      () => this.closeAndReconnect("InactiveServer"),
      this.serverInactivityThreshold,
    );
  }

  private scheduleReconnect(reason: "client" | ServerDisconnectError) {
    if (this.scheduledReconnect) {
      clearTimeout(this.scheduledReconnect.timeout);
      this.scheduledReconnect = null;
    }
    this.socket = { state: "disconnected" };
    const backoff = this.nextBackoff(reason);
    this.markConnectionStateDirty();
    this.logger.log(`Attempting reconnect in ${Math.round(backoff)}ms`);
    const timeout = setTimeout(() => {
      if (this.scheduledReconnect?.timeout === timeout) {
        this.scheduledReconnect = null;
        this.connect();
      }
    }, backoff);
    this.scheduledReconnect = { timeout, scheduledAt: monotonicMillis(), backoffMs: backoff };
  }

  /** Close the socket after a client-side problem and reconnect. */
  private closeAndReconnect(closeReason: string) {
    if (this.socket.state !== "connecting" && this.socket.state !== "ready") return;
    this.lastCloseReason = closeReason;
    void this.close();
    this.scheduleReconnect("client");
  }

  /** Close the socket without triggering its onclose logic; the caller sets the next state. */
  private close(): Promise<void> {
    this.transitionChunkBuffer = null;
    if (this.socket.state === "connecting") {
      const ws = this.socket.ws;
      ws.onmessage = () => {};
      return new Promise((r) => {
        ws.onclose = () => r();
        ws.onopen = () => ws.close();
      });
    }
    if (this.socket.state === "ready") {
      const ws = this.socket.ws;
      ws.onmessage = () => {};
      const closed = new Promise<void>((r) => {
        ws.onclose = () => r();
      });
      ws.close();
      return closed;
    }
    return Promise.resolve();
  }

  /** Close for good. Resolves when the socket's onclose ran. */
  terminate(): Promise<void> {
    if (this.reconnectDueToServerInactivityTimeout) clearTimeout(this.reconnectDueToServerInactivityTimeout);
    if (this.scheduledReconnect) {
      clearTimeout(this.scheduledReconnect.timeout);
      this.scheduledReconnect = null;
    }
    this.cleanupNetworkListener();
    const closed = this.close();
    this.setSocketState({ state: "terminated" });
    return closed;
  }

  /** Close, to be restarted by `tryRestart()` (auth). */
  stop(): Promise<void> {
    if (this.socket.state === "terminated") return Promise.resolve();
    this.cleanupNetworkListener();
    const closed = this.close();
    this.socket = { state: "stopped" };
    return closed;
  }

  tryRestart(): void {
    if (this.socket.state !== "stopped") {
      this.logger.logVerbose("Restart called without stopping first");
      return;
    }
    this.setupNetworkListener();
    this.connect();
  }

  pause(): void {
    if (this.socket.state === "connecting" || this.socket.state === "ready")
      this.socket = { ...this.socket, paused: "yes" };
  }

  /** Reconnect now, cancelling a scheduled reconnect (the browser came back online). */
  tryReconnectImmediately(): void {
    if (this.socket.state !== "disconnected") return;
    if (this.scheduledReconnect) {
      clearTimeout(this.scheduledReconnect.timeout);
      this.scheduledReconnect = null;
    }
    this.logger.log("Network recovery detected, reconnecting immediately");
    this.connect();
  }

  resume(): void {
    switch (this.socket.state) {
      case "connecting":
        this.socket = { ...this.socket, paused: "no" };
        return;
      case "ready":
        if (this.socket.paused === "uninitialized") {
          this.socket = { ...this.socket, paused: "no" };
          this._hasEverConnected = true;
          this.callbacks.onOpen({
            connectionCount: this.connectionCount,
            lastCloseReason: this.lastCloseReason,
            clientTs: monotonicMillis(),
          });
        } else if (this.socket.paused === "yes") {
          this.socket = { ...this.socket, paused: "no" };
          this.callbacks.onResume();
        }
        return;
      default:
        return;
    }
  }

  connectionState() {
    return {
      isConnected: this.socket.state === "ready",
      hasEverConnected: this._hasEverConnected,
      connectionCount: this.connectionCount,
      connectionRetries: this.retries,
    };
  }

  /** `initial × 2^retries`, capped, ± 50 % jitter. 100 ms first when the client closed, else by the reason. */
  private nextBackoff(reason: "client" | ServerDisconnectError): number {
    const initial =
      reason === "client"
        ? 100
        : reason === "Unknown"
          ? this.defaultInitialBackoff
          : serverDisconnectErrors[reason].timeout;
    const base = initial * 2 ** this.retries;
    this.retries += 1;
    const actual = Math.min(base, this.maxBackoff);
    return actual + actual * (Math.random() - 0.5);
  }
}

/**
 * The members of Bun's `Server` and `ServerWebSocket` that this package's public API exposes, declared here so
 * that its published declarations name nothing of Bun's: an app's `tsc` reads them without Bun's types, as
 * Convex's need nothing beyond its own (STUDY-160, DV-504). Bun's objects have every member listed.
 */

/** The server `Bun.serve` returns: `createServer`'s `server` and `site`. */
export interface BunServer {
  readonly port: number | undefined;
  readonly hostname: string | undefined;
  readonly url: URL;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** A WebSocket of `Bun.serve`, as a sync session drives it. */
export interface BunServerWebSocket {
  send(data: string): number;
  getBufferedAmount(): number;
  ping(): number;
  close(code?: number, reason?: string): void;
}

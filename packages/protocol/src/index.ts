// Package @bunvex/protocol — the messages between clients and a bunvex server.
//
// v0: unversioned JSON, the shape the first server spoke. Versioning, a handshake, and the guarantees the
// client needs (all of a client's subscriptions advancing together; a mutation resolving only once its
// effect is visible to that client's queries) are ARCHITECTURE.md "N" items and land here.
export const PROTOCOL_VERSION = 0;

// ---------------------------------------------------------------- HTTP one-shot calls
// POST /api/{query,mutation,action}
export type FunctionKind = "query" | "mutation" | "action";
/** `args` is the arguments object, or an array holding it (what Convex's clients send). */
export type CallRequest = { path: string; args?: unknown };
/**
 * Convex's `UdfResponse`. A function error still answers HTTP 200. `errorData` is a `BunvexError`'s data;
 * `logLines` are the function's console lines (`[LEVEL] …`), omitted when empty or redacted. A failure of
 * the request or of the server (not of the function) answers 4xx/5xx with a `RequestError` body instead.
 */
export type CallResponse =
  | { status: "success"; value: unknown; logLines?: string[] }
  | { status: "error"; errorMessage: string; errorData?: unknown; logLines?: string[] };
export type RequestError = { code: string; message: string };

// ---------------------------------------------------------------- WebSocket sync (/ws), JSON frames
export type ClientMessage =
  | { t: "sub"; path: string; args?: unknown }
  | { t: "unsub"; path: string; args?: unknown }
  | { t: "mut"; id: number; path: string; args?: unknown };

/** `e` is the error message, `d` a `BunvexError`'s data, `l` the mutation's log lines (when not redacted). */
export type ServerMessage =
  | { t: "upd"; k: string; v: unknown }
  | { t: "err"; k: string; e: string; d?: unknown }
  | { t: "res"; id: number; v: unknown; l?: string[] }
  | { t: "res"; id: number; e: string; d?: unknown; l?: string[] };

/** The key both sides use for a subscription: function path + NUL + JSON of the args. */
export const subscriptionKey = (path: string, args: unknown) => `${path}\u0000${JSON.stringify(args ?? {})}`;

// ---------------------------------------------------------------- v1 (STUDY-23): Convex's sync protocol
export * as v1 from "./v1.ts";

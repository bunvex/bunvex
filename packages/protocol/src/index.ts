// Package @bunvex/protocol — the messages between clients and a bunvex server.
//
// v0: unversioned JSON, the shape the first server spoke. Versioning, a handshake, and the guarantees the
// client needs (all of a client's subscriptions advancing together; a mutation resolving only once its
// effect is visible to that client's queries) are ARCHITECTURE.md "N" items and land here.
export const PROTOCOL_VERSION = 0;

// ---------------------------------------------------------------- HTTP one-shot calls
// POST /api/{query,mutation,action}
export type FunctionKind = "query" | "mutation" | "action";
export type CallRequest = { path: string; args?: unknown };
export type CallResponse = { status: "success"; value: unknown } | { status: "error"; errorMessage: string };

// ---------------------------------------------------------------- WebSocket sync (/ws), JSON frames
export type ClientMessage =
  | { t: "sub"; path: string; args?: unknown }
  | { t: "unsub"; path: string; args?: unknown }
  | { t: "mut"; id: number; path: string; args?: unknown };

export type ServerMessage =
  | { t: "upd"; k: string; v: unknown }
  | { t: "err"; k: string; e: string }
  | { t: "res"; id: number; v: unknown }
  | { t: "res"; id: number; e: string };

/** The key both sides use for a subscription: function path + NUL + JSON of the args. */
export const subscriptionKey = (path: string, args: unknown) => `${path}\u0000${JSON.stringify(args ?? {})}`;

// Sync protocol v1 (STUDY-23): the messages, field names and JSON encoding of Convex's sync protocol
// (npm-packages/convex/src/browser/sync/protocol.ts, crates/convex/sync_types), so the official client can
// talk to a bunvex server. Frames are JSON text, one message each, tagged by `type`. 64-bit timestamps travel
// as base64 of 8 little-endian bytes; in code they are `bigint`.

/** A value in Convex's JSON form (`$integer`, `$float`, `$bytes`). */
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export type QueryId = number;
export type QuerySetVersion = number;
export type RequestId = number;
export type IdentityVersion = number;
/** A query's journal (the end cursor of its paginated query), opaque to the client. */
export type QueryJournal = string | null;
export type TS = bigint;
export type LogLines = string[];

// ---------------------------------------------------------------- client → server

export type Connect = {
  type: "Connect";
  sessionId: string;
  connectionCount: number;
  lastCloseReason: string | null;
  maxObservedTimestamp?: TS;
  clientTs: number;
};
export type AddQuery = {
  type: "Add";
  queryId: QueryId;
  udfPath: string;
  args: JSONValue[];
  journal?: QueryJournal;
  componentPath?: string;
};
export type RemoveQuery = { type: "Remove"; queryId: QueryId };
export type ModifyQuerySet = {
  type: "ModifyQuerySet";
  baseVersion: QuerySetVersion;
  newVersion: QuerySetVersion;
  modifications: (AddQuery | RemoveQuery)[];
};
export type MutationRequest = {
  type: "Mutation";
  requestId: RequestId;
  udfPath: string;
  args: JSONValue[];
  componentPath?: string;
};
export type ActionRequest = {
  type: "Action";
  requestId: RequestId;
  udfPath: string;
  args: JSONValue[];
  componentPath?: string;
};
export type Authenticate =
  | { type: "Authenticate"; tokenType: "Admin"; value: string; baseVersion: IdentityVersion; impersonating?: JSONValue }
  | { type: "Authenticate"; tokenType: "User"; value: string; baseVersion: IdentityVersion }
  | { type: "Authenticate"; tokenType: "None"; baseVersion: IdentityVersion };
/** Client telemetry; the server accepts and ignores it (STUDY-23 P11). */
export type ClientEvent = { type: "Event"; eventType: string; event: unknown };

export type ClientMessage = Connect | ModifyQuerySet | MutationRequest | ActionRequest | Authenticate | ClientEvent;

// ---------------------------------------------------------------- server → client

export type StateVersion = { querySet: QuerySetVersion; ts: TS; identity: IdentityVersion };
export type StateModification =
  | { type: "QueryUpdated"; queryId: QueryId; value: JSONValue; logLines: LogLines; journal: QueryJournal }
  | {
      type: "QueryFailed";
      queryId: QueryId;
      errorMessage: string;
      logLines: LogLines;
      /** A `BunvexError`'s data; absent otherwise. */
      errorData?: JSONValue;
      journal: QueryJournal;
    }
  | { type: "QueryRemoved"; queryId: QueryId };
export type Transition = {
  type: "Transition";
  startVersion: StateVersion;
  endVersion: StateVersion;
  modifications: StateModification[];
  clientClockSkew?: number;
  serverTs?: number;
};
export type MutationResponse =
  | { type: "MutationResponse"; requestId: RequestId; success: true; result: JSONValue; ts: TS; logLines: LogLines }
  | {
      type: "MutationResponse";
      requestId: RequestId;
      success: false;
      result: string;
      logLines: LogLines;
      errorData?: JSONValue;
    };
export type ActionResponse =
  | { type: "ActionResponse"; requestId: RequestId; success: true; result: JSONValue; logLines: LogLines }
  | {
      type: "ActionResponse";
      requestId: RequestId;
      success: false;
      result: string;
      logLines: LogLines;
      errorData?: JSONValue;
    };
export type AuthError = {
  type: "AuthError";
  error: string;
  baseVersion: IdentityVersion;
  authUpdateAttempted: boolean;
};
export type FatalError = { type: "FatalError"; error: string };
export type Ping = { type: "Ping" };
/** One part of a Transition too large for one frame; the parts' `chunk`s joined are its JSON (P8: bunvex
 *  servers do not split yet, clients reassemble). */
export type TransitionChunk = {
  type: "TransitionChunk";
  chunk: string;
  partNumber: number;
  totalParts: number;
  transitionId: string;
};

export type ServerMessage =
  | Transition
  | TransitionChunk
  | MutationResponse
  | ActionResponse
  | AuthError
  | FatalError
  | Ping;

// ---------------------------------------------------------------- u64 timestamps

/** base64 of the 8 little-endian bytes of an unsigned 64-bit integer (Convex's `longToU64`). */
export function encodeU64(n: bigint): string {
  if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError(`not a u64: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return btoa(String.fromCharCode(...b));
}

export function decodeU64(s: string): bigint {
  // `atob`, not Node's `Buffer`: the client decodes these in browsers too.
  const binary = atob(s);
  if (binary.length !== 8) throw new Error(`expected 8 bytes of u64, got ${binary.length}`);
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = binary.charCodeAt(i);
  return new DataView(b.buffer).getBigUint64(0, true);
}

// ---------------------------------------------------------------- server side: encode / parse

const version = (v: StateVersion) => ({ querySet: v.querySet, ts: encodeU64(v.ts), identity: v.identity });

/** A server message as its JSON frame. */
export function encodeServerMessage(m: ServerMessage): string {
  switch (m.type) {
    case "Transition":
      return JSON.stringify({ ...m, startVersion: version(m.startVersion), endVersion: version(m.endVersion) });
    case "MutationResponse":
      return JSON.stringify(m.success ? { ...m, ts: encodeU64(m.ts) } : m);
    default:
      return JSON.stringify(m);
  }
}

/** A malformed or unknown client frame (the server answers it with a FatalError and closes). */
export class ProtocolError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const u32 = (x: unknown, name: string) => {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 0xffffffff)
    throw new ProtocolError(`Invalid message: \`${name}\` must be a non-negative integer`);
  return x;
};
const str = (x: unknown, name: string) => {
  if (typeof x !== "string") throw new ProtocolError(`Invalid message: \`${name}\` must be a string`);
  return x;
};
const args = (x: unknown) => {
  if (!Array.isArray(x)) throw new ProtocolError("Invalid message: `args` must be an array");
  return x as JSONValue[];
};
const optStr = (x: unknown, name: string) => (x === undefined || x === null ? undefined : str(x, name));

/** Parse and check one client frame. Throws `ProtocolError` for anything that is not a v1 client message. */
export function parseClientMessage(frame: string): ClientMessage {
  let m: unknown;
  try {
    m = JSON.parse(frame);
  } catch {
    throw new ProtocolError("Invalid message: not JSON");
  }
  if (!isObj(m)) throw new ProtocolError("Invalid message: not an object");
  switch (m.type) {
    case "Connect":
      return {
        type: "Connect",
        sessionId: str(m.sessionId, "sessionId"),
        connectionCount: u32(m.connectionCount, "connectionCount"),
        lastCloseReason: m.lastCloseReason === null ? null : (optStr(m.lastCloseReason, "lastCloseReason") ?? null),
        ...(m.maxObservedTimestamp == null
          ? {}
          : { maxObservedTimestamp: decodeU64(str(m.maxObservedTimestamp, "maxObservedTimestamp")) }),
        clientTs: typeof m.clientTs === "number" ? m.clientTs : 0,
      };
    case "ModifyQuerySet": {
      if (!Array.isArray(m.modifications)) throw new ProtocolError("Invalid message: `modifications` must be an array");
      const modifications = m.modifications.map((x): AddQuery | RemoveQuery => {
        if (!isObj(x)) throw new ProtocolError("Invalid message: a modification must be an object");
        if (x.type === "Add")
          return {
            type: "Add",
            queryId: u32(x.queryId, "queryId"),
            udfPath: str(x.udfPath, "udfPath"),
            args: args(x.args),
            ...(x.journal === undefined ? {} : { journal: x.journal === null ? null : str(x.journal, "journal") }),
            ...(x.componentPath == null ? {} : { componentPath: str(x.componentPath, "componentPath") }),
          };
        if (x.type === "Remove") return { type: "Remove", queryId: u32(x.queryId, "queryId") };
        throw new ProtocolError(`Invalid message: unknown query set modification ${JSON.stringify(x.type)}`);
      });
      return {
        type: "ModifyQuerySet",
        baseVersion: u32(m.baseVersion, "baseVersion"),
        newVersion: u32(m.newVersion, "newVersion"),
        modifications,
      };
    }
    case "Mutation":
    case "Action":
      return {
        type: m.type,
        requestId: u32(m.requestId, "requestId"),
        udfPath: str(m.udfPath, "udfPath"),
        args: args(m.args),
        ...(m.componentPath == null ? {} : { componentPath: str(m.componentPath, "componentPath") }),
      };
    case "Authenticate": {
      const baseVersion = u32(m.baseVersion, "baseVersion");
      if (m.tokenType === "None") return { type: "Authenticate", tokenType: "None", baseVersion };
      if (m.tokenType === "User")
        return { type: "Authenticate", tokenType: "User", value: str(m.value, "value"), baseVersion };
      if (m.tokenType === "Admin")
        return {
          type: "Authenticate",
          tokenType: "Admin",
          value: str(m.value, "value"),
          baseVersion,
          // Convex accepts `actingAs` too (crates/convex/sync_types json.rs).
          ...((m.impersonating ?? m.actingAs) === undefined
            ? {}
            : { impersonating: (m.impersonating ?? m.actingAs) as JSONValue }),
        };
      throw new ProtocolError(`Invalid message: unknown tokenType ${JSON.stringify(m.tokenType)}`);
    }
    case "Event":
      return { type: "Event", eventType: str(m.eventType, "eventType"), event: m.event };
    default:
      throw new ProtocolError(`Invalid message: unknown type ${JSON.stringify(m.type)}`);
  }
}

// ---------------------------------------------------------------- client side: encode / parse

/** A client message as its JSON frame. */
export function encodeClientMessage(m: ClientMessage): string {
  if (m.type === "Connect")
    return JSON.stringify({
      ...m,
      maxObservedTimestamp: m.maxObservedTimestamp === undefined ? undefined : encodeU64(m.maxObservedTimestamp),
    });
  return JSON.stringify(m);
}

/** Parse one server frame (the client side). */
export function parseServerMessage(frame: string): ServerMessage {
  const m = JSON.parse(frame) as Record<string, unknown> & { type: string };
  const ver = (x: { querySet: number; ts: string; identity: number }): StateVersion => ({ ...x, ts: decodeU64(x.ts) });
  switch (m.type) {
    case "Transition":
      return {
        ...(m as unknown as Transition),
        startVersion: ver(m.startVersion as never),
        endVersion: ver(m.endVersion as never),
      };
    case "MutationResponse":
      return m.success
        ? ({ ...m, ts: decodeU64(m.ts as string) } as unknown as MutationResponse)
        : (m as unknown as MutationResponse);
    default:
      return m as unknown as ServerMessage;
  }
}

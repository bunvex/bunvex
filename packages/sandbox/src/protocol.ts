// The messages the server (the host) and a sandboxed child exchange (STUDY-171 §7, designed in STUDY-168 §4.3).
//
// - **Framing** (`frames.ts`): each message is a 4-byte little-endian length and the message's JSON, on a socket
//   of the child's own (its fd 3, both ways). The host parses what the untrusted child writes
//   with `JSON.parse` only, and refuses a frame over `MAX_MESSAGE_BYTES` from its header, before reading it.
// - **Values** inside a message are in the value JSON format (`toJsonValue`): an int64 is `{"$integer": …}`, bytes
//   `{"$bytes": …}`, as Convex passes values between its isolate and its Rust host as JSON text.
// - **Requests** carry an `id`, unique per child; the child answers each with exactly one message of that `id`.
// - **The handshake**: the child's first message is `hello` with the protocol version it speaks. The host sends
//   nothing before it, and kills a child that does not say it in time.
//
// What a child sends is checked here (`parseChildMessage`): its shape, never its truth. A child can only
// misdescribe the app code it was given; a message the host cannot use kills it.
//
// - **Calls** (STUDY-171 §8): the host sends `call` (a query or mutation, its arguments, its transaction's clock,
//   snapshot, variables and catalog); the child sends an `op` for each `ctx` operation and answers the call with
//   `done`; the host answers each `op` with a `reply`. Calls and their operations interleave freely: each is named
//   by the call's id and its own number.
// - **Actions** (STUDY-171 §12): the host sends `action` (its arguments and the variables at its start); the child
//   runs the handler outside any transaction, with an action's `ctx` of operations, and answers with `done`. Its
//   console lines go as they come (`lines`), as an action's stream to the function log. Past the action's timeout the
//   host sends `cancel`: the child cuts the handler off from its `ctx` and its `fetch`, says `cancelled`, and sends
//   nothing more for that call; a child that does not say it in time is killed.
// - **HTTP actions** (STUDY-168 PR 6): the host sends `http` (the route its router matched, the request's head, its
//   body as a stream); the child runs the route's handler as an action and answers with `response` (the response's
//   head, its body inline, whole as a stream, or streaming), then `done` once the body was handed over: the call goes on
//   while its body streams. A client that leaves is `disconnect` (the request's signal).
// - **Components** (STUDY-168 PR 7): a child holds the app's version and the component instances' versions loaded
//   beside it, each made by its own `load`; every call names the version it runs (the namespace switch: the data a
//   call reaches is its `ctx`'s, on the host). `unload` forgets a version that runs no more calls.
// - **Bytes** (a `fetch` body, a stored file) go as streams (`streams.ts`): chunk frames of their own, with `end`,
//   `fail`, `credit` and `stop` messages, both ways.
import type { AnalyzedFunction, AnalyzedModule, DefaultExportUse, ModuleSource } from "@bunvex/server/executor";
import type { StreamMessage } from "./streams.ts";

/** How many catalogs and how many variable sets a child keeps (the host's `EpochWindow` counts the same). */
export const EPOCHS_KEPT = 4;

/** Bumped whenever a message changes: host and child are always the same build, but a stale child must not run. */
export const PROTOCOL_VERSION = 8;

/** Convex's argument and result caps (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`, knobs.rs:439-446). */
export const MAX_VALUE_SIZE = 1 << 24;
/**
 * The largest frame a child may send. A message carries at most one value within `MAX_VALUE_SIZE` (Convex's own
 * check of a decoded value, `valueSize`, stays the observable limit), and a value's JSON is at most 7 bytes per
 * byte it counts for (an empty bytes value counts 2 and is sent as `{"$bytes":""}`; a control character counts 1
 * and is sent as `\u00XX`), plus the envelope. A child that sends more is broken or hostile.
 */
export const MAX_MESSAGE_BYTES = 7 * MAX_VALUE_SIZE + (1 << 20);

/** host → child */
export type ToChild =
  | { t: "load"; id: number; sources: ModuleSource[]; options: WireLoadOptions }
  | {
      t: "evaluate";
      id: number;
      source: ModuleSource;
      options: WireLoadOptions & { failOnMissingEnv: boolean };
      use: DefaultExportUse;
    }
  | WireCall
  | WireActionCall
  | WireHttpCall
  | WireReply
  | { t: "cancel"; id: number; error: WireThrown }
  /** The HTTP action's client left: its request's signal aborts with `reason`. */
  | { t: "disconnect"; id: number; reason: WireThrown }
  /** The version a `load` made (named by that load's id) runs no more calls: the child forgets it. */
  | { t: "unload"; version: number }
  | StreamMessage;

/**
 * `LoadOptions` as sent: the seed as numbers, the import time limit resolved. (`MAX_USER_MODULES`, read when the
 * loader loads, reaches the child as the host's environment variable: `host.ts`, `CHILD_KNOBS`.)
 */
export type WireLoadOptions = {
  seed: number[];
  timestamp: number;
  env: Record<string, string>;
  importTimeoutMs: number;
  nodeModules?: string;
};

/** child → host */
export type ToHost =
  | { t: "hello"; protocol: number; pid: number }
  /** `held`: how many versions the child holds now, this one included (each `load`'s, less those `unload`ed). */
  | { t: "loaded"; id: number; version: WireVersion; loadMs: number; held: number }
  | { t: "evaluated"; id: number; export: EvaluatedDefault; loadMs: number }
  | { t: "failed"; id: number; error: WireError }
  | { t: "op"; id: number; op: number; name: string; args: unknown[]; report: WireReport }
  | ({
      t: "done";
      id: number;
      report: WireReport;
      /** An action's operations whose answer it had not taken when it returned (they are its unawaited ones). */
      pending?: number[];
    } & ({ ok: true; value: unknown } | { ok: false; error: WireThrown }))
  /** An action's console lines, sent as they come (a query's or mutation's go with its next message). */
  | { t: "lines"; id: number; lines: WireLogLine[] }
  /** The child cut the action off (`cancel`): nothing more comes for that call. */
  | { t: "cancelled"; id: number }
  /** The app aborted the signal of its `fetch` (operation `op` of call `id`). */
  | { t: "abort"; id: number; op: number }
  /** An HTTP action's response head and how its body comes; its `done` follows once the body was handed over. */
  | WireResponse
  | StreamMessage;

/**
 * A loaded code version as the child describes it: what `CodeVersion.load` analyzed (`analysis`), and what the
 * host's stand-ins need of its functions. Maps are lists of pairs, so their order survives.
 */
export type WireVersion = {
  analysis: [path: string, module: WireAnalyzedModule][];
  moduleHashes: [name: string, hash: string][];
  moduleLoads: [name: string, modules: string[]][];
  functions: [key: string, fn: WireFunction][];
  rooms: [key: string, room: WireRoom][];
};
/**
 * A room or presence definition (AD-42): its validators' JSON (a room's presence and events, a presence scope's
 * state) and which gates it has. The gates run in the child, as queries (`key#canJoin`).
 */
export type WireRoom = {
  kind: "room" | "presence";
  args: string | null;
  /** A room's `presence`, a presence scope's `state`. */
  value: string;
  events: [name: string, validator: string][];
  canJoin: boolean;
  canPublish: boolean;
};
export type WireFunction = {
  kind: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  /** Defined in a `"use node"` module. */
  node: boolean;
  /** Its validators' JSON, as the function has them (null: none; `analysis` cannot tell none from `v.any()`). */
  args: string | null;
  returns: string | null;
};
/** `AnalyzedModule`, its crons' arguments in the value JSON format. */
export type WireAnalyzedModule = Omit<AnalyzedModule, "cronSpecs"> & {
  cronSpecs: [id: string, spec: WireCronSpec][] | null;
};
export type WireCronSpec = { udfPath: string; udfArgs: unknown[]; cronSchedule: Record<string, unknown> };

/**
 * A default export, in the form its use takes (Convex's): the auth config's `JSON.stringify` (`undefined` when it
 * gives none, `unserializable` when it throws), a schema's export, or why it is not one.
 */
export type EvaluatedDefault =
  | { kind: "undefined" }
  | { kind: "json"; json: string }
  | { kind: "unserializable" }
  | { kind: "schema"; json: string }
  | { kind: "notSchema" }
  | { kind: "schemaExportFailed" };

/** The errors a load or an evaluation throws, by class: the host throws the same class with the same words. */
export type WireError =
  | { kind: "InvalidModules"; detail: string }
  | { kind: "FunctionExport"; message: string }
  | { kind: "MissingEnvironmentVariable"; variable: string }
  | { kind: "Error"; message: string };

/** A call's execution, as the child makes it again (core `ExecutionClock`), and the host's id for it. */
export type WireExecution = { id: number; kind: "query" | "mutation"; now: number; perfStart: number; elapsed: number };

/**
 * A table of the call's namespace: its number, and each enabled index's fields and the ts it was enabled at; the
 * indexes being built (`pending`, staged or not) and its text indexes (`search`), when it has any: what a query's
 * start needs to know why an index cannot be read (core `Tx.resolveIndex`).
 */
export type WireTable = {
  name: string;
  number: number;
  indexes: [name: string, fields: string[], readyTs: string | null][];
  pending?: [name: string, staged: boolean][];
  search?: string[];
};

/** host → child: a query's or mutation's call. */
export type WireCall = {
  t: "call";
  id: number;
  /** The id of the `load` that made the version. */
  version: number;
  fn: string;
  kind: "query" | "mutation";
  args: unknown;
  exec: WireExecution;
  /** The transaction's snapshot (`ctx.meta.getSnapshotTs()`), as a decimal string. */
  snapshot: string;
  userMs: number;
  systemMs: number;
  /** How the function was given its `db` (`Functions.invoke`). */
  db: "tx" | "reader" | "writer";
  /** `ctx.storage`'s methods, for this kind. */
  storage: string[];
  /** The variables, by epoch: sent once per child. Null when the function sees none of the deployment's. */
  env: { epoch: number; vars?: [string, string][] } | null;
  /** The namespace's tables, by epoch: sent once per child. */
  catalog: { epoch: number; tables?: WireTable[] };
  /** The tables this transaction created so far. */
  created: WireTable[];
};

/** host → child: an action's call. */
export type WireActionCall = {
  t: "action";
  id: number;
  version: number;
  fn: string;
  args: unknown;
  /** The variables at the action's start (Convex's `get_all`), or null when it sees none of the deployment's. */
  env: [string, string][] | null;
  /** `ctx.meta`'s methods. */
  meta: string[];
};

/** host → child: an HTTP action's call: the route the host's router matched, and the request. */
export type WireHttpCall = {
  t: "http";
  id: number;
  version: number;
  /** The route as the router has it (`getRoutes`): its method and its path (a prefix route's ends in `*`). */
  route: [method: string, path: string];
  request: { url: string; method: string; headers: [string, string][]; body: number | null };
  env: [string, string][] | null;
  meta: string[];
};

/**
 * An HTTP action's response body: none; its bytes inline, or as the stream `s` (`whole`), for a body of known length
 * (`length`: its size, or null for one still to encode, as `bodyLength` tells; `gather`: past the 100 MiB cap, the host
 * has it whole before the server sends it, as in-process); or streaming (`stream`).
 */
export type WireResponseBody =
  | null
  | { kind: "bytes"; b: unknown; length: number | null }
  | { kind: "whole"; s: number; length: number | null; gather: boolean }
  | { kind: "stream"; s: number };

/** child → host: an HTTP action's response: its head, read before its body as the server reads it. */
export type WireResponse = {
  t: "response";
  id: number;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: WireResponseBody;
};

/**
 * host → child: an operation's answer. `created`: the transaction's created tables, when they changed. `sync`: the
 * error was thrown before the engine's call returned, as under `vm` it is thrown at the app's call, with its frames;
 * `link`: by the query chain's link of that id, made when the app made it (STUDY-171 §11.3).
 */
export type WireReply = { t: "reply"; id: number; op: number; created?: WireTable[] } & (
  | { ok: true; value: unknown }
  | { ok: false; error: WireThrown; sync?: true; link?: number }
);

/**
 * What the child ran, observed, read and built since its previous message for the call: `env`, each
 * `process.env` read, in order; `links`, each link of a query chain the function made (`db.query(t)`, then each
 * `withIndex`, `filter`, `order`, …), which the host makes on its `ctx.db` first, as the engine makes each at the
 * app's call (`db.query` and `withIndex` read).
 */
export type WireReport = { ran: number; time: boolean; env: string[]; links: WireLink[]; lines: WireLogLine[] };

/**
 * A console line the function logged since its previous message (STUDY-171 §11): made in the child as the console
 * makes it in-process (rendered, cut at `MAX_LOG_LINE_LENGTH`, stamped with the wall clock), in order.
 */
export type WireLogLine = [level: string, messages: string[], isTruncated: boolean, timestamp: number];

/**
 * A query chain's link: its kind, its id, the link it continues (none for `open`), and its arguments (wire values):
 * `open` [table, system], `withIndex` [name, hasRange, [op, field, value][]], `withSearchIndex` [name,
 * [type, field, value][]], `fullTableScan` [], `order` [dir], `filter` [{ expr: json } | { literal: value }],
 * `limit` [n].
 */
export type WireLink = [kind: string, id: number, from: number | null, args: unknown];

/** A thrown value. */
export type WireThrown =
  /** An operation's error, as it came back: the host throws its original. */
  | { k: "op"; op: number; stack: string | null }
  /**
   * An error, with its class's name; a `BunvexError` with its data; `caller`: a nested call's error for its caller,
   * which the child gives the caller's realm (`asCallerError`).
   */
  | {
      k: "error";
      cls: string;
      name: string;
      message: string;
      stack: string | null;
      bunvex: boolean;
      data?: unknown;
      caller?: true;
    }
  /** An error the host's own check would have thrown (a query object returned). */
  | { k: "host"; message: string }
  /**
   * A system error the server's code raised in the child (an `ExecutorFailure`): the host throws it again as one, so
   * the client gets the internal error, as under `vm` (STUDY-188 §X14).
   */
  | { k: "system"; message: string }
  /** A query's or mutation's promise that can never resolve (STUDY-188 §X16): the host's own error for it. */
  | { k: "never" }
  /** Anything else thrown (`throw "no"`). */
  | { k: "value"; v: unknown };

/** What runs a query chain (`db.query` [link, terminal]). */
export type WireTerminal =
  | { k: "collect" }
  | { k: "take"; n: number }
  | { k: "first" }
  | { k: "unique" }
  | { k: "paginate"; opts: unknown }
  | { k: "count" }
  | { k: "iterate" };

/** A message the host cannot use: the child is killed. */
export class BadMessageError extends Error {}

type Json = unknown;
const fail = (where: string, what: string): never => {
  throw new BadMessageError(`${where}: expected ${what}`);
};
const obj = (x: Json, where: string): Record<string, Json> =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, Json>) : fail(where, "an object");
const arr = (x: Json, where: string): Json[] => (Array.isArray(x) ? x : fail(where, "an array"));
const str = (x: Json, where: string): string => (typeof x === "string" ? x : fail(where, "a string"));
const bool = (x: Json, where: string): boolean => (typeof x === "boolean" ? x : fail(where, "a boolean"));
const int = (x: Json, where: string): number =>
  Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : fail(where, "a non-negative integer");
const num = (x: Json, where: string): number => (typeof x === "number" ? x : fail(where, "a number"));
const oneOf = <T extends string>(x: Json, values: readonly T[], where: string): T =>
  values.includes(x as T) ? (x as T) : fail(where, values.map((v) => JSON.stringify(v)).join(" or "));
const nullable = <T>(x: Json, f: (x: Json, where: string) => T, where: string): T | null =>
  x === null ? null : f(x, where);
const pairs = <T>(x: Json, f: (x: Json, where: string) => T, where: string): [string, T][] =>
  arr(x, where).map((p, i) => {
    const pair = arr(p, `${where}[${i}]`);
    if (pair.length !== 2) fail(`${where}[${i}]`, "a pair");
    return [str(pair[0], `${where}[${i}][0]`), f(pair[1], `${where}[${i}][1]`)];
  });

const position = (x: Json, where: string): AnalyzedFunction["pos"] =>
  nullable(
    x,
    (p, w) => {
      const o = obj(p, w);
      return {
        path: str(o.path, `${w}.path`),
        start_lineno: int(o.start_lineno, `${w}.start_lineno`),
        start_col: int(o.start_col, `${w}.start_col`),
      };
    },
    where,
  );

function analyzedFunction(x: Json, where: string): AnalyzedFunction {
  const o = obj(x, where);
  return {
    name: str(o.name, `${where}.name`),
    pos: position(o.pos, `${where}.pos`),
    udfType: oneOf(o.udfType, ["Query", "Mutation", "Action"], `${where}.udfType`),
    visibility: {
      kind: oneOf(obj(o.visibility, `${where}.visibility`).kind, VISIBILITIES, `${where}.visibility.kind`),
    },
    args: str(o.args, `${where}.args`),
    returns: str(o.returns, `${where}.returns`),
  };
}

const SCHEDULE_FIELDS: Record<string, [required: string[], optional: string[]]> = {
  interval: [["seconds"], []],
  hourly: [[], ["minuteUTC"]],
  daily: [["hourUTC"], ["minuteUTC"]],
  weekly: [["dayOfWeek", "hourUTC"], ["minuteUTC"]],
  monthly: [["day", "hourUTC"], ["minuteUTC"]],
  cron: [["cronExpr"], []],
};

/** A cron's schedule, as `cronSpecs` makes it: its type, and that type's fields only. */
function cronSchedule(x: Json, where: string): Record<string, unknown> {
  const o = obj(x, where);
  const type = oneOf(o.type, Object.keys(SCHEDULE_FIELDS), `${where}.type`);
  const [required, optional] = SCHEDULE_FIELDS[type]!;
  for (const k of Object.keys(o))
    if (k !== "type" && !required.includes(k) && !optional.includes(k)) fail(`${where}.${k}`, "no such field");
  for (const k of required) {
    if (type === "cron") str(o[k], `${where}.${k}`);
    else int(o[k], `${where}.${k}`);
  }
  for (const k of optional) if (o[k] !== undefined) int(o[k], `${where}.${k}`);
  return o;
}

function analyzedModule(x: Json, where: string): WireAnalyzedModule {
  const o = obj(x, where);
  return {
    functions: arr(o.functions, `${where}.functions`).map((f, i) => analyzedFunction(f, `${where}.functions[${i}]`)),
    httpRoutes: nullable(
      o.httpRoutes,
      (r, w) =>
        arr(r, w).map((e, i) => {
          const route = obj(obj(e, `${w}[${i}]`).route, `${w}[${i}].route`);
          return {
            route: {
              path: str(route.path, `${w}[${i}].route.path`),
              method: str(route.method, `${w}[${i}].route.method`),
            },
            pos: position((e as Record<string, Json>).pos, `${w}[${i}].pos`),
          };
        }),
      `${where}.httpRoutes`,
    ),
    cronSpecs: nullable(
      o.cronSpecs,
      (c, w) =>
        pairs(
          c,
          (s, sw) => {
            const spec = obj(s, sw);
            return {
              udfPath: str(spec.udfPath, `${sw}.udfPath`),
              udfArgs: arr(spec.udfArgs, `${sw}.udfArgs`),
              cronSchedule: cronSchedule(spec.cronSchedule, `${sw}.cronSchedule`),
            };
          },
          w,
        ),
      `${where}.cronSpecs`,
    ),
    rooms: arr(o.rooms, `${where}.rooms`).map((r, i) => {
      const room = obj(r, `${where}.rooms[${i}]`);
      return {
        name: str(room.name, `${where}.rooms[${i}].name`),
        kind: oneOf(room.kind, ROOM_KINDS, `${where}.rooms[${i}].kind`),
      };
    }),
  };
}

const VISIBILITIES = ["public", "internal"] as const;
const LOG_LEVELS = ["DEBUG", "ERROR", "WARN", "INFO", "LOG"] as const;
const ROOM_KINDS = ["room", "presence"] as const;

function version(x: Json, where: string): WireVersion {
  const o = obj(x, where);
  return {
    analysis: pairs(o.analysis, analyzedModule, `${where}.analysis`),
    moduleHashes: pairs(o.moduleHashes, str, `${where}.moduleHashes`),
    moduleLoads: pairs(o.moduleLoads, (l, w) => arr(l, w).map((m, i) => str(m, `${w}[${i}]`)), `${where}.moduleLoads`),
    functions: pairs(
      o.functions,
      (f, w) => {
        const fn = obj(f, w);
        return {
          kind: oneOf(fn.kind, ["query", "mutation", "action"], `${w}.kind`),
          visibility: oneOf(fn.visibility, VISIBILITIES, `${w}.visibility`),
          node: bool(fn.node, `${w}.node`),
          args: nullable(fn.args, str, `${w}.args`),
          returns: nullable(fn.returns, str, `${w}.returns`),
        };
      },
      `${where}.functions`,
    ),
    rooms: pairs(
      o.rooms,
      (r, w) => {
        const room = obj(r, w);
        return {
          kind: oneOf(room.kind, ROOM_KINDS, `${w}.kind`),
          args: nullable(room.args, str, `${w}.args`),
          value: str(room.value, `${w}.value`),
          events: pairs(room.events, str, `${w}.events`),
          canJoin: bool(room.canJoin, `${w}.canJoin`),
          canPublish: bool(room.canPublish, `${w}.canPublish`),
        };
      },
      `${where}.rooms`,
    ),
  };
}

function evaluated(x: Json, where: string): EvaluatedDefault {
  const o = obj(x, where);
  const kind = oneOf(
    o.kind,
    ["undefined", "json", "unserializable", "schema", "notSchema", "schemaExportFailed"],
    `${where}.kind`,
  );
  if (kind === "json" || kind === "schema") return { kind, json: str(o.json, `${where}.json`) };
  return { kind };
}

function wireError(x: Json, where: string): WireError {
  const o = obj(x, where);
  const kind = oneOf(
    o.kind,
    ["InvalidModules", "FunctionExport", "MissingEnvironmentVariable", "Error"],
    `${where}.kind`,
  );
  if (kind === "InvalidModules") return { kind, detail: str(o.detail, `${where}.detail`) };
  if (kind === "MissingEnvironmentVariable") return { kind, variable: str(o.variable, `${where}.variable`) };
  return { kind, message: str(o.message, `${where}.message`) };
}

/** What a message reports of the call's time and reads. */
function report(x: Json, where: string): WireReport {
  const o = obj(x, where);
  const ran = num(o.ran, `${where}.ran`);
  if (!Number.isFinite(ran) || ran < 0) fail(`${where}.ran`, "a finite non-negative number");
  return {
    ran,
    time: bool(o.time, `${where}.time`),
    env: arr(o.env, `${where}.env`).map((n, i) => str(n, `${where}.env[${i}]`)),
    links: arr(o.links, `${where}.links`).map((l, i) => {
      const w = `${where}.links[${i}]`;
      const e = arr(l, w);
      if (e.length !== 4) fail(w, "a link: its kind, id, source and arguments");
      return [str(e[0], `${w}[0]`), int(e[1], `${w}[1]`), nullable(e[2], int, `${w}[2]`), e[3]] as WireLink;
    }),
    lines: logLines(o.lines, `${where}.lines`),
  };
}

/** Console lines, checked: each a level, its messages' text, whether it was cut, and a finite time. */
function logLines(x: Json, where: string): WireLogLine[] {
  return arr(x, where).map((l, i) => {
    const w = `${where}[${i}]`;
    const e = arr(l, w);
    if (e.length !== 4) fail(w, "a line: its level, messages, truncation and time");
    const timestamp = num(e[3], `${w}[3]`);
    if (!Number.isFinite(timestamp)) fail(`${w}[3]`, "a finite number");
    return [
      oneOf(e[0], LOG_LEVELS, `${w}[0]`),
      arr(e[1], `${w}[1]`).map((m, j) => str(m, `${w}[1][${j}]`)),
      bool(e[2], `${w}[2]`),
      timestamp,
    ] as WireLogLine;
  });
}

/** A thrown value's description (its values are checked when decoded). */
function thrown(x: Json, where: string): WireThrown {
  const o = obj(x, where);
  const k = oneOf(o.k, ["op", "error", "host", "system", "never", "value"], `${where}.k`);
  if (k === "never") return { k };
  if (k === "op") return { k, op: int(o.op, `${where}.op`), stack: nullable(o.stack, str, `${where}.stack`) };
  if (k === "host" || k === "system") return { k, message: str(o.message, `${where}.message`) };
  if (k === "value") return { k, v: "v" in o ? o.v : fail(`${where}.v`, "a value") };
  return {
    k,
    cls: str(o.cls, `${where}.cls`),
    name: str(o.name, `${where}.name`),
    message: str(o.message, `${where}.message`),
    stack: nullable(o.stack, str, `${where}.stack`),
    bunvex: bool(o.bunvex, `${where}.bunvex`),
    ...(o.data === undefined ? {} : { data: o.data }),
    ...(o.caller === undefined ? {} : { caller: o.caller === true ? true : fail(`${where}.caller`, "true") }),
  };
}

/** An HTTP action's response head, checked (its headers' validity is the host's `Headers`'). */
function response(m: Record<string, Json>, id: number): WireResponse {
  const status = int(m.status, "response.status");
  if (status < 100 || status > 999) fail("response.status", "an HTTP status");
  const b = nullable(m.body, obj, "response.body");
  let body: WireResponseBody = null;
  if (b !== null) {
    const kind = oneOf(b.kind, ["bytes", "whole", "stream"], "response.body.kind");
    const length = () => nullable(b.length, int, "response.body.length");
    if (kind === "stream") body = { kind, s: int(b.s, "response.body.s") };
    else if (kind === "whole")
      body = { kind, s: int(b.s, "response.body.s"), length: length(), gather: bool(b.gather, "response.body.gather") };
    else body = { kind, b: "b" in b ? b.b : fail("response.body.b", "bytes"), length: length() };
  }
  return {
    t: "response",
    id,
    status,
    statusText: str(m.statusText, "response.statusText"),
    headers: pairs(m.headers, str, "response.headers"),
    body,
  };
}

/** A message from a child, checked; throws `BadMessageError` for anything the host does not expect. */
export function parseChildMessage(text: string): ToHost {
  let x: Json;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new BadMessageError(`not JSON (${(e as Error).message})`);
  }
  const m = obj(x, "message");
  const t = oneOf(
    m.t,
    [
      "hello",
      "loaded",
      "evaluated",
      "failed",
      "op",
      "done",
      "lines",
      "cancelled",
      "abort",
      "response",
      "end",
      "mark",
      "fail",
      "credit",
      "stop",
    ],
    "message.t",
  );
  if (t === "hello") return { t, protocol: num(m.protocol, "hello.protocol"), pid: int(m.pid, "hello.pid") };
  if (t === "end" || t === "stop" || t === "mark") return { t, s: int(m.s, `${t}.s`) };
  if (t === "credit") {
    const n = int(m.n, "credit.n");
    if (n === 0) fail("credit.n", "a positive integer");
    return { t, s: int(m.s, "credit.s"), n };
  }
  if (t === "fail") return { t, s: int(m.s, "fail.s"), error: thrown(m.error, "fail.error") };
  const id = int(m.id, `${t}.id`);
  if (t === "loaded")
    return {
      t,
      id,
      version: version(m.version, "loaded.version"),
      loadMs: num(m.loadMs, "loaded.loadMs"),
      held: int(m.held, "loaded.held"),
    };
  if (t === "op")
    return {
      t,
      id,
      op: int(m.op, "op.op"),
      name: str(m.name, "op.name"),
      args: arr(m.args, "op.args"),
      report: report(m.report, "op.report"),
    };
  if (t === "done") {
    const ok = bool(m.ok, "done.ok");
    const r = report(m.report, "done.report");
    const pending =
      m.pending === undefined
        ? {}
        : { pending: arr(m.pending, "done.pending").map((p, i) => int(p, `done.pending[${i}]`)) };
    if (ok) return { t, id, ok, value: "value" in m ? m.value : fail("done.value", "a value"), report: r, ...pending };
    return { t, id, ok, error: thrown(m.error, "done.error"), report: r, ...pending };
  }
  if (t === "lines") return { t, id, lines: logLines(m.lines, "lines.lines") };
  if (t === "cancelled") return { t, id };
  if (t === "abort") return { t, id, op: int(m.op, "abort.op") };
  if (t === "response") return response(m, id);
  if (t === "evaluated")
    return { t, id, export: evaluated(m.export, "evaluated.export"), loadMs: num(m.loadMs, "evaluated.loadMs") };
  return { t, id, error: wireError(m.error, "failed.error") };
}

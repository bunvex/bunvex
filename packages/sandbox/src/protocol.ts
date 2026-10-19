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
// Function calls and their `ctx` operations (`call`, `op`, `result`, `done`) are STUDY-168's PR 3: requests of
// the same shape, one `id` each way, in the same frames.
import type { AnalyzedFunction, AnalyzedModule, DefaultExportUse, ModuleSource } from "@bunvex/server/executor";

/** Bumped whenever a message changes: host and child are always the same build, but a stale child must not run. */
export const PROTOCOL_VERSION = 1;

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
    };

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
  | { t: "loaded"; id: number; version: WireVersion; loadMs: number }
  | { t: "evaluated"; id: number; export: EvaluatedDefault; loadMs: number }
  | { t: "failed"; id: number; error: WireError };

/**
 * A loaded code version as the child describes it: what `CodeVersion.load` analyzed (`analysis`), and what the
 * host's stand-ins need of its functions. Maps are lists of pairs, so their order survives.
 */
export type WireVersion = {
  analysis: [path: string, module: WireAnalyzedModule][];
  moduleHashes: [name: string, hash: string][];
  moduleLoads: [name: string, modules: string[]][];
  functions: [key: string, fn: WireFunction][];
  rooms: [key: string, kind: "room" | "presence"][];
};
export type WireFunction = {
  kind: "query" | "mutation" | "action";
  visibility: "public" | "internal";
  /** Defined in a `"use node"` module. */
  node: boolean;
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
        };
      },
      `${where}.functions`,
    ),
    rooms: pairs(o.rooms, (k, w) => oneOf(k, ROOM_KINDS, w), `${where}.rooms`),
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

/** A message from a child, checked; throws `BadMessageError` for anything the host does not expect. */
export function parseChildMessage(text: string): ToHost {
  let x: Json;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new BadMessageError(`not JSON (${(e as Error).message})`);
  }
  const m = obj(x, "message");
  const t = oneOf(m.t, ["hello", "loaded", "evaluated", "failed"], "message.t");
  if (t === "hello") return { t, protocol: num(m.protocol, "hello.protocol"), pid: int(m.pid, "hello.pid") };
  const id = int(m.id, `${t}.id`);
  if (t === "loaded")
    return { t, id, version: version(m.version, "loaded.version"), loadMs: num(m.loadMs, "loaded.loadMs") };
  if (t === "evaluated")
    return { t, id, export: evaluated(m.export, "evaluated.export"), loadMs: num(m.loadMs, "evaluated.loadMs") };
  return { t, id, error: wireError(m.error, "failed.error") };
}

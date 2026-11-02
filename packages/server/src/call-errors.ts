// A call's error across the call boundary (STUDY-194 §10.2, 2b commit 0b): what a query's or mutation's run threw,
// written as text in its outcome where it ran and made again beside the dispatcher, which tests it with
// `instanceof` (`errors.ts` `isSystemError`, the engine's `OccError`) and reports it (`describeUncaught`).
//
// The server's own errors, and those of the packages it runs on, are made again as their class, with every field
// they carried: a run's error is the same object to every check whichever side it ran on. An app's error is made
// again as the sandbox makes it (`packages/sandbox/src/host-call.ts` `appError`): its built-in class or `Error`, in
// a realm of its own as under `vm`, with its name, message, stack and fields; a `BunvexError` with its data.
import vm from "node:vm";
import * as core from "@bunvex/core";
import * as identity from "@bunvex/identity";
import * as protocol from "@bunvex/protocol";
import * as values from "@bunvex/values";
import { ExecutorFailure, isError } from "./errors.ts";

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * The server's error classes by name: every one its packages export, and every one its modules export (a test holds
 * this list to them, `call-errors.test.ts`).
 */
let KNOWN: Map<string, ErrorClass> | null = null;
/** Whether `c` is made again as itself across the call boundary. */
export const knownCallError = (c: ErrorClass): boolean => known().get(c.name) === c;
const exported = (m: object) =>
  Object.values(m).filter((v): v is ErrorClass => typeof v === "function" && v.prototype instanceof Error);
/** Made on first use, once every module is loaded. */
function known(): Map<string, ErrorClass> {
  if (KNOWN) return KNOWN;
  const map = new Map<string, ErrorClass>();
  // Required here, not imported: the modules that define them import the call boundary's code in turn.
  for (const c of [
    ...exported(core),
    ...exported(values),
    ...exported(protocol),
    ...exported(identity),
    ...exported(require("./errors.ts")),
    ...exported(require("./action-permits.ts")),
    ...exported(require("./action-timeout.ts")),
    ...exported(require("./admin-keys.ts")),
    ...exported(require("./app-metrics-routes.ts")),
    ...exported(require("./code-store.ts")),
    ...exported(require("./code-version.ts")),
    ...exported(require("./component-tree.ts")),
    ...exported(require("./definition-eval.ts")),
    ...exported(require("./execution-workers.ts")),
    ...exported(require("./exports.ts")),
    ...exported(require("./external-deps.ts")),
    ...exported(require("./function-executor.ts")),
    ...exported(require("./http-proxy.ts")),
    ...exported(require("./imports.ts")),
    ...exported(require("./json-body.ts")),
    ...exported(require("./log.ts")),
    ...exported(require("./log-sink-http.ts")),
    ...exported(require("./log-sinks.ts")),
    ...exported(require("./push.ts")),
    ...exported(require("./push-components.ts")),
    ...exported(require("./query-args.ts")),
    ...exported(require("./service-tokens.ts")),
    ...exported(require("./storage.ts")),
    ...exported(require("./streaming-export.ts")),
    ...exported(require("./streaming-import.ts")),
    ...exported(require("./system-functions.ts")),
    ...exported(require("./test-function.ts")),
    ...exported(require("./usage-limits.ts")),
    ...exported(require("./zip-reader.ts")),
  ]) {
    const seen = map.get(c.name);
    if (seen && seen !== c) throw new Error(`two error classes are named ${c.name}`);
    map.set(c.name, c);
  }
  KNOWN = map;
  return map;
}

/** One field of an error: JSON, with what JSON lacks tagged in a one-key object. */
type Field = null | boolean | number | string | Field[] | { [k: string]: Field };

/** An error as text: its class (`known`: the server's), name, own fields and, for any other value, the value. */
type WireError =
  | { k: "known"; cls: string; fields: [key: Field, value: Field, enumerable: boolean][] }
  /** `server`: made in the server's realm (a store's or a driver's error), not in the app's. */
  | { k: "app"; cls: string; name: string; server: boolean; fields: [key: Field, value: Field, enumerable: boolean][] }
  | { k: "value"; v: Field };

/** A field that is no JSON value: `$u` undefined, `$b` bigint, `$n` a non-finite number, `$e` an error, … */
function field(v: unknown, depth: number): Field {
  if (depth > 32) throw new TypeError("too deep");
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number")
    return Number.isFinite(v) && !Object.is(v, -0) ? v : { $n: Object.is(v, -0) ? "-0" : String(v) };
  if (v === undefined) return { $u: 1 };
  if (typeof v === "bigint") return { $b: v.toString() };
  if (isError(v)) return { $e: wire(v, depth + 1) as unknown as Field };
  if (v instanceof ArrayBuffer) return { $a: values.Base64.fromByteArray(new Uint8Array(v)) };
  if (v instanceof Uint8Array) return { $y: values.Base64.fromByteArray(v) };
  if (Array.isArray(v)) return { $l: v.map((x) => field(x, depth + 1)) };
  if (values.isSimpleObject(v)) {
    const o: { [k: string]: Field } = {};
    for (const [k, x] of Object.entries(v)) o[k] = field(x, depth + 1);
    return { $o: o };
  }
  throw new TypeError(`a field of type ${Object.prototype.toString.call(v)}`);
}

function unfield(f: Field): unknown {
  if (f === null || typeof f !== "object") return f;
  if (Array.isArray(f)) throw new TypeError("an untagged array");
  const [tag, x] = Object.entries(f)[0] ?? [];
  switch (tag) {
    case "$u":
      return undefined;
    case "$n":
      return Number(x);
    case "$b":
      return BigInt(x as string);
    case "$e":
      return rebuild(x as unknown as WireError);
    case "$a":
      return values.Base64.toByteArray(x as string).buffer;
    case "$y":
      return values.Base64.toByteArray(x as string);
    case "$l":
      return (x as Field[]).map(unfield);
    case "$o": {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, Field>)) o[k] = unfield(v);
      return o;
    }
  }
  throw new TypeError(`an unknown field tag ${String(tag)}`);
}

/** Its own fields, the non-enumerable `message` and `stack` included; a registered symbol by its key. */
function fieldsOf(e: Error, depth: number): [Field, Field, boolean][] {
  const out: [Field, Field, boolean][] = [];
  for (const key of Reflect.ownKeys(e)) {
    let k: Field;
    if (typeof key === "string") k = key;
    else {
      const name = Symbol.keyFor(key);
      if (name === undefined) continue;
      k = { $s: name };
    }
    const d = Object.getOwnPropertyDescriptor(e, key);
    if (!d || !("value" in d)) continue;
    out.push([k, field(d.value, depth), d.enumerable === true]);
  }
  if (transient?.(e)) out.push([{ $s: TRANSIENT_KEY }, true, false]);
  return out;
}

function wire(e: unknown, depth: number): WireError {
  if (!isError(e)) return { k: "value", v: field(e, depth) };
  const proto = Object.getPrototypeOf(e);
  const cls: unknown = proto?.constructor?.name;
  if (typeof cls === "string" && known().get(cls)?.prototype === proto)
    return { k: "known", cls, fields: fieldsOf(e, depth) };
  return {
    k: "app",
    cls: typeof cls === "string" ? cls : "Error",
    name: String(e.name),
    server: e instanceof Error,
    fields: fieldsOf(e, depth),
  };
}

/**
 * The realm an app's errors are made again in: not this one, as under `vm` (a function's code runs in its own
 * context, whose `Error` is not the server's).
 */
let appRealm: ((cls: string) => Error) | null = null;
function appRealmError(cls: string): Error {
  appRealm ??= vm.runInContext(
    `(cls) => {
  const C = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"].includes(cls)
    ? globalThis[cls]
    : Error;
  return new C();
}`,
    vm.createContext({}),
    { filename: "bunvex-runtime:call-errors.js" },
  ) as (cls: string) => Error;
  return appRealm(cls);
}

/** A built-in error class of this realm by name, else `Error`: a store's or a driver's error made again. */
function serverRealmError(cls: string): Error {
  const C = (globalThis as unknown as Record<string, unknown>)[cls];
  return typeof C === "function" && (C === Error || C.prototype instanceof Error)
    ? Object.create(C.prototype)
    : Object.create(Error.prototype);
}

function rebuild(w: WireError): unknown {
  if (w.k === "value") return unfield(w.v);
  let e: Error;
  if (w.k === "known") e = Object.create(known().get(w.cls)?.prototype ?? Error.prototype);
  else if (w.fields.some(([k]) => typeof k === "object" && (k as { $s?: string } | null)?.$s === "BunvexError"))
    e = Object.create(values.BunvexError.prototype);
  else e = w.server ? serverRealmError(w.cls) : appRealmError(w.cls);
  for (const [k, v, enumerable] of w.fields) {
    const key = typeof k === "string" ? k : Symbol.for((k as { $s: string }).$s);
    Object.defineProperty(e, key, { value: unfield(v), writable: true, configurable: true, enumerable });
  }
  if (w.k === "app" && e.name !== w.name)
    Object.defineProperty(e, "name", { value: w.name, writable: true, configurable: true });
  return e;
}

const TRANSIENT_KEY = "bunvex.transient";
const TRANSIENT = Symbol.for(TRANSIENT_KEY);
/** The store's own test of its errors, while one is written (`encodeCallError`). */
let transient: ((e: unknown) => boolean) | null = null;

/**
 * What a run threw, as its outcome's text. One that does not fit is a system error naming its class.
 * `isTransient`: the store's test of its errors (`Persistence.isTransient`), asked where the error was made, whose
 * answer the error carries (Convex's `ErrorMetadata` crosses its function runner the same way).
 */
export function encodeCallError(e: unknown, isTransient?: (e: unknown) => boolean): string {
  transient = isTransient ?? null;
  try {
    return JSON.stringify(wire(e, 0));
  } catch (cause) {
    const cls = isError(e) ? (Object.getPrototypeOf(e)?.constructor?.name ?? "Error") : typeof e;
    const failure = new ExecutorFailure(`an error that does not cross the call boundary: ${cls}: ${String(cause)}`);
    return JSON.stringify(wire(failure, 0));
  } finally {
    transient = null;
  }
}

/** Whether the store said `e` is transient where it was made, on the other side of the call boundary. */
export const markedTransient = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[TRANSIENT] === true;

/** The error `encodeCallError` wrote, made again. */
export const decodeCallError = (text: string): unknown => rebuild(JSON.parse(text) as WireError);

// What a function's code hands the engine, across the wire (STUDY-171 §8.3): a call's arguments and result, each
// `ctx` operation's arguments and answer. Under `vm` the engine gets the app's own objects and checks them itself
// (`copyValue`, `toJsonValue`, the validators), so the app sees the engine's errors in the engine's order. To keep
// that, this codec carries more than values: whatever the engine's checks read of what is not one.
//
// - **Values** as the value JSON format writes them, with tags of their own: an int64 `{"$n":"5"}` (any bigint,
//   so an out-of-range one still fails where the engine checks it), a special float `{"$f":"NaN"}`, bytes
//   `{"$b":base64}`, `undefined` `{"$u":0}` (a field, an array element, an argument left out), the commit
//   timestamp placeholder `{"$t":0}`.
// - **A plain object** as a JSON object; one with a key that starts with `$` as `{"$o":[[key, value], …]}`, so
//   no field is ever read as a tag.
// - **What is not a value** (a class instance, a `Map`, a function, a symbol) as `{"$x":{…}}`: its kind and the
//   name of its class, which is all the engine's messages print of it (`stringifyValueForError`: `Point {…}`,
//   `"[Function]"`). The host builds an object of the same kind and class name, not of its own realm (as the app's
//   objects are not, under `vm`: a `Set` prints as `Set {…}`), so the same check fails with the same words.
// - **A function reference** (`api.messages.list`) as `{"$r":{…}}`: its name or component path, or the error
//   reading it threw (`anyApi.messages`).
// - **A cycle** as `{"$c":n}`, the ancestor `n` levels up: the engine's checks see the same cycle.
//
// The host decodes what the untrusted child sends with `decode(..., true)`: an unknown tag or a malformed one is
// a `BadMessageError`, and the child is killed.
import { functionName, toReferencePath } from "@bunvex/protocol";
import { Base64, commitTsPlaceholder, isBytes, isCommitTsPlaceholder, isSimpleObject } from "@bunvex/values";
import { BadMessageError } from "./protocol.ts";

/** How deep the codec follows a value: far past the engine's limit (64), short of the stack's. */
export const MAX_WIRE_DEPTH = 4096;

/** A wire value: JSON. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The class name the engine's messages print (`value.ts` `className`): from the prototype, never throwing. */
function classNameOf(x: unknown): string {
  try {
    const name = Object.getPrototypeOf(x)?.constructor?.name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** A function reference's address, if `x` is one (what the engine reads of it: `getFunctionAddress`). */
function referenceOf(x: object): Json | undefined {
  let name: unknown;
  let path: unknown;
  try {
    name = (x as Record<symbol, unknown>)[functionName];
    path = (x as Record<symbol, unknown>)[toReferencePath];
  } catch (e) {
    return { e: String((e as Error)?.message ?? e) };
  }
  if (name === undefined && path === undefined) return undefined;
  const out: Record<string, Json> = {};
  if (name !== undefined) out.n = encode(name);
  if (path !== undefined) out.p = encode(path);
  return out;
}

/** `x`, for the wire. Throws only what reading `x` throws (a getter). */
export function encode(x: unknown): Json {
  return enc(x, [], 0);
}

function enc(x: unknown, ancestors: object[], depth: number): Json {
  switch (typeof x) {
    case "undefined":
      return { $u: 0 };
    case "boolean":
    case "string":
      return x;
    case "number":
      if (Number.isNaN(x)) return { $f: "NaN" };
      if (!Number.isFinite(x)) return { $f: x > 0 ? "Infinity" : "-Infinity" };
      if (Object.is(x, -0)) return { $f: "-0" };
      return x;
    case "bigint":
      return { $n: x.toString() };
    case "symbol":
      return { $x: { k: "symbol", d: x.description ?? null } };
    case "function": {
      const ref = referenceOf(x);
      if (ref !== undefined) return { $r: ref };
      return { $x: { k: "function", c: classNameOf(x) } };
    }
  }
  if (x === null) return null;
  const o = x as object;
  const up = ancestors.lastIndexOf(o);
  if (up !== -1) return { $c: ancestors.length - up };
  if (depth >= MAX_WIRE_DEPTH) return { $u: 0 };
  if (isCommitTsPlaceholder(o)) return { $t: 0 };
  if (isBytes(o)) return { $b: Base64.fromByteArray(new Uint8Array(o)) };
  ancestors.push(o);
  try {
    if (Array.isArray(o)) {
      const out: Json[] = new Array(o.length);
      for (let i = 0; i < o.length; i++) out[i] = enc(o[i], ancestors, depth + 1);
      return out;
    }
    const ref = referenceOf(o);
    if (ref !== undefined) return { $r: ref };
    if (!isSimpleObject(o)) return { $x: { k: "object", c: classNameOf(o) } };
    let escaped = false;
    const keys = Object.keys(o);
    for (const k of keys)
      if (k.charCodeAt(0) === 36 /* $ */) {
        escaped = true;
        break;
      }
    if (escaped) return { $o: keys.map((k) => [k, enc((o as Record<string, unknown>)[k], ancestors, depth + 1)]) };
    const out: Record<string, Json> = {};
    for (const k of keys) {
      const v = enc((o as Record<string, unknown>)[k], ancestors, depth + 1);
      if (k === "__proto__")
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      else out[k] = v;
    }
    return out;
  } finally {
    ancestors.pop();
  }
}

/** An object whose class the engine's messages name `name` (its prototype's `constructor.name`). */
function namedInstance(name: string): object {
  return Object.create({ constructor: { name } });
}

const FUNCTION_KINDS: Record<string, () => unknown> = {
  Function: () => () => {},
  AsyncFunction: () => async () => {},
  GeneratorFunction: () => function* () {},
  AsyncGeneratorFunction: () => async function* () {},
};

function namedFunction(name: string): unknown {
  const make = FUNCTION_KINDS[name];
  if (make) return make();
  const f = () => {};
  Object.setPrototypeOf(f, { constructor: { name } });
  return f;
}

/** A function reference as the engine reads it back: its name or path, or the error reading it threw. */
function reference(r: Record<string, Json>, strict: boolean): object {
  if (typeof r.e === "string") {
    const message = r.e;
    return new Proxy(
      {},
      {
        get(_, p) {
          if (p === functionName || p === toReferencePath) throw new Error(message);
          if (p === Symbol.toStringTag) return "FunctionReference";
          return undefined;
        },
      },
    );
  }
  const out: Record<symbol, unknown> = {};
  if ("n" in r) out[functionName] = dec(r.n!, strict, []);
  if ("p" in r) out[toReferencePath] = dec(r.p!, strict, []);
  return out;
}

const bad = (what: string): never => {
  throw new BadMessageError(`a value that is not valid: ${what}`);
};

/** A wire value back as the engine (or the app) sees it. `strict`: from the child, checked. */
export function decode(x: unknown, strict: boolean): unknown {
  return dec(x as Json, strict, []);
}

function dec(x: Json, strict: boolean, ancestors: object[]): unknown {
  if (x === null || typeof x !== "object") {
    if (strict && typeof x !== "boolean" && typeof x !== "number" && typeof x !== "string" && x !== null) bad(typeof x);
    return x;
  }
  if (Array.isArray(x)) {
    const out: unknown[] = new Array(x.length);
    ancestors.push(out);
    for (let i = 0; i < x.length; i++) out[i] = dec(x[i]!, strict, ancestors);
    ancestors.pop();
    return out;
  }
  const keys = Object.keys(x);
  const tag = keys.length === 1 && keys[0]!.charCodeAt(0) === 36 ? keys[0]! : null;
  if (tag === null) {
    if (strict) for (const k of keys) if (k.charCodeAt(0) === 36) bad(`the key ${JSON.stringify(k)}`);
    const out: Record<string, unknown> = {};
    ancestors.push(out);
    for (const k of keys) {
      const v = dec(x[k]!, strict, ancestors);
      if (k === "__proto__")
        Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      else out[k] = v;
    }
    ancestors.pop();
    return out;
  }
  const body = x[tag]!;
  switch (tag) {
    case "$u":
      return undefined;
    case "$t":
      return commitTsPlaceholder;
    case "$n":
      if (typeof body !== "string" || !/^-?\d+$/.test(body)) return bad("$n");
      return BigInt(body);
    case "$f":
      if (body === "NaN") return Number.NaN;
      if (body === "Infinity") return Number.POSITIVE_INFINITY;
      if (body === "-Infinity") return Number.NEGATIVE_INFINITY;
      if (body === "-0") return -0;
      return bad("$f");
    case "$b": {
      if (typeof body !== "string") return bad("$b");
      const bytes = Base64.toByteArray(body);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case "$c": {
      if (typeof body !== "number" || !Number.isInteger(body) || body < 1 || body > ancestors.length) return bad("$c");
      return ancestors[ancestors.length - body];
    }
    case "$o": {
      if (!Array.isArray(body)) return bad("$o");
      const out: Record<string, unknown> = {};
      ancestors.push(out);
      for (const e of body) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") return bad("$o entry");
        Object.defineProperty(out, e[0], {
          value: dec(e[1]!, strict, ancestors),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      ancestors.pop();
      return out;
    }
    case "$r":
      if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("$r");
      return reference(body, strict);
    case "$x": {
      if (body === null || typeof body !== "object" || Array.isArray(body)) return bad("$x");
      const k = body.k;
      if (k === "symbol") {
        if (body.d !== null && typeof body.d !== "string") return bad("$x symbol");
        return body.d === null ? Symbol() : Symbol(body.d);
      }
      if (k === "function") return typeof body.c === "string" ? namedFunction(body.c) : bad("$x function");
      if (k === "object") return typeof body.c === "string" ? namedInstance(body.c) : bad("$x object");
      return bad("$x");
    }
  }
  return strict ? bad(`the tag ${JSON.stringify(tag)}`) : undefined;
}

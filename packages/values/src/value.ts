// Convex values (STUDY-18): the types a document, an argument or a result may hold, and their JSON form.
//
//   null · bigint (Int64) · number (Float64, NaN/±Infinity/−0 included) · boolean · string ·
//   ArrayBuffer (Bytes) · Value[] · { [field]: Value }
//
// JSON: bigint → {"$integer": base64 LE}, special float → {"$float": base64 LE}, bytes → {"$bytes": base64};
// object fields are sorted and `undefined` fields are dropped. Anything else is refused.
import { fromBase64, toBase64, utf8Length } from "./bytes.ts";
import { type CommitTsPlaceholder, isCommitTsPlaceholder } from "./commit-ts.ts";

/** A Convex value; `CommitTsPlaceholder` is `db.vars.commitTs` before its mutation commits (STUDY-53). */
export type Value =
  | null
  | bigint
  | number
  | boolean
  | string
  | ArrayBuffer
  | CommitTsPlaceholder
  | Value[]
  | { [field: string]: Value };
export type JSONValue = null | boolean | number | string | JSONValue[] | { [field: string]: JSONValue };

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const MAX_FIELD_NAME_LEN = 1024;
const MAX_VALUE_FOR_ERROR_LEN = 16384;

/**
 * Convex's `MAX_NESTING` (crates/value/src/size.rs): how deeply arrays and objects may nest in any value — an
 * argument, a result, a written value. Documents have their own, lower limit (16).
 */
export const MAX_VALUE_NESTING = 64;

/**
 * Convex's `TooNestedError` message. Convex checks the limit as it builds a value from its leaves up, so the
 * level it reports is always the first one past the limit.
 */
export const TOO_NESTED_MESSAGE = `Value is too nested (nested ${MAX_VALUE_NESTING + 1} levels deep > maximum nesting ${MAX_VALUE_NESTING})`;

/** NaN, ±Infinity and −0 cannot be plain JSON numbers. */
export const isSpecialFloat = (n: number) => Number.isNaN(n) || !Number.isFinite(n) || Object.is(n, -0);

const b64 = toBase64;
const unb64 = fromBase64;

export function validateObjectField(k: string) {
  if (k.length > MAX_FIELD_NAME_LEN)
    throw new Error(`Field name ${k} exceeds maximum field name length ${MAX_FIELD_NAME_LEN}.`);
  if (k.startsWith("$")) throw new Error(`Field name ${k} starts with a '$', which is reserved.`);
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (c < 32 || c >= 127)
      throw new Error(
        `Field name ${k} has invalid character '${k[i]}': Field names can only contain non-control ASCII characters`,
      );
  }
}

/**
 * An ArrayBuffer (a bytes value), from this realm or another: a function's code runs in its own context
 * (STUDY-35), whose `ArrayBuffer` is not this one, so `instanceof` would miss it.
 */
export function isBytes(v: unknown): v is ArrayBuffer {
  return v instanceof ArrayBuffer || Object.prototype.toString.call(v) === "[object ArrayBuffer]";
}

/** A plain object: `{}` / `Object.create(null)` / an object literal, not a class instance (of any realm). */
export function isSimpleObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype || proto?.constructor?.name === "Object";
}

/**
 * The name an error gives a value that is not plain data: its class's (`Point`, `Map`), or "" when it has
 * none. It reads the prototype, not the value's own fields, and never throws.
 */
function className(value: unknown): string {
  try {
    const name = Object.getPrototypeOf(value)?.constructor?.name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** A value an error message names but does not open (anything but plain data): `Point {…}`. */
export const opaque = (value: unknown) => {
  const name = className(value);
  return name ? `${name} {…}` : "{…}";
};

/** An object's own enumerable string keys, in `JSON.stringify`'s order, one at a time. */
function* ownKeys(o: object): Generator<string> {
  for (const k in o) if (Object.hasOwn(o, k)) yield k;
}

// Escaping only lengthens a string, so a prefix two past the limit decides the cut.
const quote = (s: string) =>
  JSON.stringify(s.length > MAX_VALUE_FOR_ERROR_LEN ? s.slice(0, MAX_VALUE_FOR_ERROR_LEN + 2) : s);

/**
 * A value in an error message, as Convex's `stringifyValueForError` prints it (npm-packages/convex/src/values/
 * value.ts): its JSON, with `undefined` as `"undefined"`, a bigint as `"5n"`, a function as `"[Function]"` and
 * a symbol as its description (`"Symbol(s)"`), cut at
 * MAX_VALUE_FOR_ERROR_LEN characters with `[...truncated]`.
 *
 * Unlike `JSON.stringify`, it opens only plain data: arrays, plain objects and their fields. A class instance,
 * a `Map`, a `Date` or a function's context object prints as its class name and `{…}`, never its fields, and
 * no `toJSON` or other method of it runs. Function code holds engine objects (`ctx.db`, a query) whose
 * fields reach the transaction, the catalog and the store; serialising them put all of that in a message the
 * client receives. A cycle prints as `"[Circular]"`, and the walk stops once the output is past the limit,
 * so a huge or cyclic value costs no more than the message.
 */
export function stringifyValueForError(value: unknown): string {
  const out: string[] = [];
  let length = 0;
  const ancestors = new Set<object>();
  const emit = (s: string) => {
    out.push(s);
    length += s.length;
  };
  const full = () => length > MAX_VALUE_FOR_ERROR_LEN;
  // A scalar's text, or what an object prints as when it is not opened; null for an array or a plain object.
  // Undefined is "undefined"; since Convex aab5a04 a function is "[Function]" and a symbol its description,
  // wherever they are (`JSON.stringify` alone dropped them from objects and made them null in arrays).
  const closed = (v: unknown): string | null => {
    if (v === undefined) return '"undefined"';
    if (v === null) return "null";
    switch (typeof v) {
      case "function":
        return '"[Function]"';
      case "symbol":
        return quote(String(v));
      case "bigint":
        return `"${v.toString()}n"`;
      case "number":
      case "boolean":
        return JSON.stringify(v);
      case "string":
        return quote(v);
    }
    const o = v as object;
    if (ancestors.has(o)) return '"[Circular]"';
    if (isBytes(o)) return "{}"; // what `JSON.stringify` prints for bytes
    if (!Array.isArray(o) && !isSimpleObject(o)) return opaque(o);
    return null;
  };
  // Iterative, not recursive: the value can nest deeper than the stack (a 100 000-deep array overflowed it
  // on Linux). Each frame is an open array or object, with what it has left to print.
  type Frame = { o: object; close: string; next: () => { key?: string; value: unknown } | null; first: boolean };
  const stack: Frame[] = [];
  const open = (o: object) => {
    ancestors.add(o);
    if (Array.isArray(o)) {
      let i = 0;
      emit("[");
      stack.push({ o, close: "]", first: true, next: () => (i < o.length ? { value: o[i++] } : null) });
    } else {
      const keys = ownKeys(o);
      emit("{");
      stack.push({
        o,
        close: "}",
        first: true,
        next: () => {
          const r = keys.next();
          return r.done ? null : { key: r.value, value: (o as Record<string, unknown>)[r.value] };
        },
      });
    }
  };
  // one value: printed at once when closed, else opened as a frame
  const write = (v: unknown) => {
    const text = closed(v);
    if (text !== null) emit(text);
    else open(v as object);
  };
  write(value);
  while (stack.length && !full()) {
    const top = stack[stack.length - 1]!;
    const member = top.next();
    if (member === null) {
      stack.pop();
      ancestors.delete(top.o);
      emit(top.close);
      continue;
    }
    if (!top.first) emit(",");
    top.first = false;
    if (member.key !== undefined) emit(`${quote(member.key)}:`);
    write(member.value);
  }
  const s = out.join("");
  if (s.length <= MAX_VALUE_FOR_ERROR_LEN) return s;
  const rest = "[...truncated]";
  let at = MAX_VALUE_FOR_ERROR_LEN - rest.length;
  const cp = s.codePointAt(at - 1);
  if (cp !== undefined && cp > 0xffff) at -= 1;
  return s.substring(0, at) + rest;
}

function unsupported(context: string, typeName: string, value: unknown, original: unknown) {
  return context
    ? `${typeName}${stringifyValueForError(value)} is not a supported value type (present at path ${context} in original object ${stringifyValueForError(original)}).`
    : `${typeName}${stringifyValueForError(value)} is not a supported value type.`;
}

function toJson(value: unknown, original: unknown, context: string): JSONValue {
  if (value === undefined) {
    const where = context && ` (present at path ${context} in original object ${stringifyValueForError(original)})`;
    throw new Error(`undefined is not a valid value${where}.`);
  }
  if (value === null) return null;
  // Convex's wire token for an unresolved commit timestamp (STUDY-53); resolved before any client sees it.
  if (isCommitTsPlaceholder(value)) return { $commitTs: null };
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || MAX_INT64 < value)
      throw new Error(`BigInt ${value} does not fit into a 64-bit signed integer.`);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, value, true);
    return { $integer: b64(buf) };
  }
  if (typeof value === "number") {
    if (!isSpecialFloat(value)) return value;
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, value, true);
    return { $float: b64(buf) };
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (isBytes(value)) return { $bytes: b64(new Uint8Array(value)) };
  if (Array.isArray(value)) return value.map((v, i) => toJson(v, original, `${context}[${i}]`));
  if (value instanceof Set) throw new Error(unsupported(context, "Set", [...value], original));
  if (value instanceof Map) throw new Error(unsupported(context, "Map", [...value], original));
  if (!isSimpleObject(value)) {
    // An object prints as `Name {…}` (stringifyValueForError); a function or a symbol as its kind's name and
    // `"[Function]"` or its description, as Convex's message does since aab5a04.
    const name = typeof value === "object" ? "" : className(value);
    throw new Error(unsupported(context, name ? `${name} ` : "", value, original));
  }
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (v === undefined) continue;
    validateObjectField(k);
    out[k] = toJson(v, original, `${context}.${k}`);
  }
  return out;
}

/** A Convex value as JSON (throws on anything that is not a Convex value). */
export function toJsonValue(value: Value): JSONValue {
  return toJson(value, value, "");
}

/**
 * Parse the JSON form back: `$integer` → bigint, `$float` → number, `$bytes` → ArrayBuffer. A value nested
 * deeper than `MAX_VALUE_NESTING` throws `TOO_NESTED_MESSAGE` before going further down.
 */
export function fromJsonValue(value: JSONValue): Value {
  return fromJson(value, 1);
}

/** `depth`: the nesting an array or object here adds up to, counted from the root (whose own is 1). */
function fromJson(value: JSONValue, depth: number): Value {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth > MAX_VALUE_NESTING) throw new Error(TOO_NESTED_MESSAGE);
    return value.map((e) => fromJson(e, depth + 1));
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const k = keys[0];
    const v = value[k];
    if (k === "$integer" && typeof v === "string") {
      const bytes = unb64(v);
      if (bytes.length !== 8) throw new Error(`Received ${bytes.length} bytes, expected 8 for $integer`);
      return new DataView(bytes.buffer).getBigInt64(0, true);
    }
    if (k === "$float" && typeof v === "string") {
      const bytes = unb64(v);
      if (bytes.length !== 8) throw new Error(`Received ${bytes.length} bytes, expected 8 for $float`);
      const f = new DataView(bytes.buffer).getFloat64(0, true);
      if (!isSpecialFloat(f)) throw new Error(`Float ${f} should be encoded as a number`);
      return f;
    }
    if (k === "$bytes" && typeof v === "string") {
      const bytes = unb64(v);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  }
  if (depth > MAX_VALUE_NESTING) throw new Error(TOO_NESTED_MESSAGE);
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(value)) {
    validateObjectField(k);
    out[k] = fromJson(v, depth + 1);
  }
  return out;
}

/** The type rank of Convex's cross-type order (`crates/value/src/sorting.rs`); undefined is lowest. */
function rank(v: Value | undefined): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  if (typeof v === "bigint") return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "boolean") return 4;
  if (typeof v === "string") return 5;
  if (isBytes(v)) return 6;
  if (Array.isArray(v)) return 7;
  return 8;
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
/** IEEE-754 total order, as the sort key encodes it. */
function floatKey(n: number): bigint {
  f64[0] = n;
  const bits = u64[0];
  return bits & (1n << 63n) ? ~bits & 0xffffffffffffffffn : bits | (1n << 63n);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
const utf8 = new TextEncoder();

/** Convex's total order on values (equal to comparing their sort keys). */
export function compareValues(a: Value | undefined, b: Value | undefined): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
    case 1:
      return 0;
    case 2:
      return a! < b! ? -1 : a! > b! ? 1 : 0;
    case 3: {
      const x = floatKey(a as number);
      const y = floatKey(b as number);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 4:
      return Number(a) - Number(b);
    case 5:
      return compareBytes(utf8.encode(a as string), utf8.encode(b as string));
    case 6:
      return compareBytes(new Uint8Array(a as ArrayBuffer), new Uint8Array(b as ArrayBuffer));
    case 7: {
      const x = a as Value[];
      const y = b as Value[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareValues(x[i], y[i]);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    default: {
      const x = Object.entries(a as Record<string, Value>).sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0));
      const y = Object.entries(b as Record<string, Value>).sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0));
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareBytes(utf8.encode(x[i][0]), utf8.encode(y[i][0])) || compareValues(x[i][1], y[i][1]);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
  }
}

function copy(value: unknown, original: unknown, context: string, depth: number, max: number): Value {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "bigint" || value === undefined) return toJson(value, original, context) && (value as Value);
  if (isBytes(value)) return value.slice(0);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LEN)
      throw new Error(`Array length is too long (${value.length} > maximum length ${MAX_ARRAY_LEN})`);
    if (depth > max) throw new Error(TOO_NESTED_MESSAGE);
    return value.map((v, i) => copy(v, original, `${context}[${i}]`, depth + 1, max));
  }
  if (!isSimpleObject(value)) return toJson(value, original, context) as never; // throws Convex's message
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length > MAX_OBJECT_FIELDS)
    throw new Error(`Object has too many fields (${keys.length} > maximum number ${MAX_OBJECT_FIELDS})`);
  if (depth > max) throw new Error(TOO_NESTED_MESSAGE);
  const out: Record<string, Value> = {};
  for (const k of keys.sort()) {
    validateObjectField(k);
    out[k] = copy(value[k], original, `${context}.${k}`, depth + 1, max);
  }
  return out;
}

const MAX_ARRAY_LEN = 8192;
const MAX_OBJECT_FIELDS = 1024;
const utf8len = utf8Length;

/**
 * Convex's notion of a value's size (`Size::size`, crates/value): the unit of the document limit. Convex's
 * client exports it as `getConvexSize` (values/size.ts), whose edges it keeps: `undefined` is 0, a commit-ts
 * placeholder 9 (an int64), and anything else that is not a value throws `Unsupported value type: <typeof>`.
 */
export function valueSize(v: Value | undefined): number {
  return sizeOf(v, true, 1);
}

/**
 * `valueSize` for a value not validated yet (a function's arguments, result or writes, measured for the
 * limits): something that is not a value counts as an empty object instead of throwing, so its own
 * validation reports it with its path.
 */
export function rawValueSize(v: Value | undefined): number {
  return sizeOf(v, false, 1);
}

/**
 * `rawValueSize` and the nesting, in one walk (a function's arguments and result: Convex checks both as it
 * builds the value). The walk stops going down past `maxNesting`, so a value of any depth is safe to measure:
 * `nesting` is exact up to `maxNesting + 1`, and past that `size` counts only what was walked.
 */
export function measureRawValue(
  v: Value | undefined,
  maxNesting = MAX_VALUE_NESTING,
): { size: number; nesting: number } {
  deepest = 0;
  depthCap = maxNesting + 1;
  try {
    const size = sizeOf(v, false, 1);
    return { size, nesting: deepest };
  } finally {
    depthCap = Number.POSITIVE_INFINITY;
  }
}

/** The deepest array or object `sizeOf` reached, and the depth it does not go below (`measureRawValue`). */
let deepest = 0;
let depthCap = Number.POSITIVE_INFINITY;

/** `depth`: the nesting an array or object here adds up to, counted from the root (whose own is 1). */
function sizeOf(v: Value | undefined, strict: boolean, depth: number): number {
  // Plain loops: this walks every result and argument (the 16 MiB limits, STUDY-64), so no per-field arrays.
  switch (typeof v) {
    case "string":
      return utf8len(v) + 2;
    case "number":
    case "bigint":
      return 9;
    case "boolean":
      return 1;
    case "undefined":
      return 0;
    case "object":
      break;
    default:
      if (strict) throw new Error(`Unsupported value type: ${typeof v}`);
      return 2;
  }
  if (v === null) return 1;
  if (Array.isArray(v)) {
    if (depth > deepest && deeper(depth)) return 2;
    let n = 2;
    for (let i = 0; i < v.length; i++) n += sizeOf(v[i], strict, depth + 1);
    return n;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype) {
    if (isBytes(v)) return v.byteLength + 2;
    if (isCommitTsPlaceholder(v)) return 9;
    if (strict && !isSimpleObject(v)) throw new Error(`Unsupported value type: ${typeof v}`);
  }
  if (depth > deepest && deeper(depth)) return 2;
  const o = v as { [k: string]: Value | undefined };
  let n = 2;
  for (const k of Object.keys(o)) {
    const e = o[k];
    if (e !== undefined) n += utf8len(k) + 1 + sizeOf(e, strict, depth + 1);
  }
  return n;
}

/** A new deepest level for `sizeOf`: whether it is the cap, past which it does not go down. */
function deeper(depth: number): boolean {
  deepest = depth;
  return depth >= depthCap;
}

/** Convex's estimate of a stored `_id` (a 32-character id) and `_creationTime` (values/size.ts). */
const SYSTEM_ID_SIZE = 38;
const SYSTEM_CREATION_TIME_SIZE = 23;

/**
 * A document's size as stored (Convex's `getDocumentSize`): `valueSize`, plus Convex's estimate of the system
 * fields it does not have yet — 38 bytes for `_id` (or `customIdLength` + 6), 23 for `_creationTime`.
 */
export function getDocumentSize(value: Record<string, Value>, options?: { customIdLength?: number }): number {
  const size = valueSize(value);
  let extra = 0;
  if (value._id === undefined) extra += options?.customIdLength ? options.customIdLength + 6 : SYSTEM_ID_SIZE;
  if (value._creationTime === undefined) extra += SYSTEM_CREATION_TIME_SIZE;
  return size + extra;
}

/** How deeply arrays and objects nest: a scalar is 0, `[1]` is 1, `{a: [1]}` is 2. */
export function valueNesting(v: Value): number {
  if (Array.isArray(v)) return 1 + v.reduce<number>((m, e) => Math.max(m, valueNesting(e)), 0);
  if (v !== null && typeof v === "object" && !isBytes(v))
    return 1 + Object.values(v).reduce<number>((m, e) => Math.max(m, e === undefined ? 0 : valueNesting(e)), 0);
  return 0;
}

/**
 * A validated deep copy of a value, as a `fromJsonValue(toJsonValue(v))` round trip would give (same
 * checks and messages, fields sorted, undefined fields dropped) without building the JSON. Nested deeper
 * than `maxNesting`, it throws `TOO_NESTED_MESSAGE` before going further down.
 */
export function copyValue(value: Value, maxNesting = MAX_VALUE_NESTING): Value {
  return copy(value, value, "", 1, maxNesting);
}

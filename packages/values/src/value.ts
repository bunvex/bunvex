// Convex values (STUDY-18): the types a document, an argument or a result may hold, and their JSON form.
//
//   null · bigint (Int64) · number (Float64, NaN/±Infinity/−0 included) · boolean · string ·
//   ArrayBuffer (Bytes) · Value[] · { [field]: Value }
//
// JSON: bigint → {"$integer": base64 LE}, special float → {"$float": base64 LE}, bytes → {"$bytes": base64};
// object fields are sorted and `undefined` fields are dropped. Anything else is refused.

export type Value = null | bigint | number | boolean | string | ArrayBuffer | Value[] | { [field: string]: Value };
export type JSONValue = null | boolean | number | string | JSONValue[] | { [field: string]: JSONValue };

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const MAX_FIELD_NAME_LEN = 1024;
const MAX_VALUE_FOR_ERROR_LEN = 16384;

/** NaN, ±Infinity and −0 cannot be plain JSON numbers. */
export const isSpecialFloat = (n: number) => Number.isNaN(n) || !Number.isFinite(n) || Object.is(n, -0);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

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

export function stringifyValueForError(value: unknown): string {
  const s = JSON.stringify(value, (_k, v) =>
    v === undefined ? "undefined" : typeof v === "bigint" ? `${v.toString()}n` : v,
  );
  if (s === undefined || s.length <= MAX_VALUE_FOR_ERROR_LEN) return String(s);
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
    const name = (value as { constructor?: { name?: string } })?.constructor?.name;
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

/** Parse the JSON form back: `$integer` → bigint, `$float` → number, `$bytes` → ArrayBuffer. */
export function fromJsonValue(value: JSONValue): Value {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(fromJsonValue);
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
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(value)) {
    validateObjectField(k);
    out[k] = fromJsonValue(v);
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

function copy(value: unknown, original: unknown, context: string): Value {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "bigint" || value === undefined) return toJson(value, original, context) && (value as Value);
  if (isBytes(value)) return value.slice(0);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LEN)
      throw new Error(`Array length is too long (${value.length} > maximum length ${MAX_ARRAY_LEN})`);
    return value.map((v, i) => copy(v, original, `${context}[${i}]`));
  }
  if (!isSimpleObject(value)) return toJson(value, original, context) as never; // throws Convex's message
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length > MAX_OBJECT_FIELDS)
    throw new Error(`Object has too many fields (${keys.length} > maximum number ${MAX_OBJECT_FIELDS})`);
  const out: Record<string, Value> = {};
  for (const k of keys.sort()) {
    validateObjectField(k);
    out[k] = copy(value[k], original, `${context}.${k}`);
  }
  return out;
}

const MAX_ARRAY_LEN = 8192;
const MAX_OBJECT_FIELDS = 1024;
const utf8len = (s: string) => Buffer.byteLength(s, "utf8");

/** Convex's notion of a value's size (`Size::size`, crates/value): the unit of the document limit. */
export function valueSize(v: Value): number {
  if (v === null || typeof v === "boolean") return 1;
  if (typeof v === "number" || typeof v === "bigint") return 9;
  if (typeof v === "string") return utf8len(v) + 2;
  if (isBytes(v)) return v.byteLength + 2;
  if (Array.isArray(v)) return v.reduce<number>((n, e) => n + valueSize(e), 2);
  let n = 2;
  for (const [k, e] of Object.entries(v)) if (e !== undefined) n += utf8len(k) + 1 + valueSize(e);
  return n;
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
 * checks and messages, fields sorted, undefined fields dropped) without building the JSON.
 */
export function copyValue(value: Value): Value {
  return copy(value, value, "");
}

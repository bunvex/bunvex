// A `_system/` function's arguments (STUDY-161 §6). Convex does not parse them before the run
// (`ValidatedPathAndArgs::new_with_returns_validator`, crates/udf/src/validation.rs: a system path skips
// everything but the identity check): they reach the system function as JSON, and its wrapper reads them with
// the JS values library's `jsonToConvex` (npm-packages/convex/src/values/value.ts). So arguments the backend's
// parse refuses can still be read there (no nesting limit, `$commitTs: null`), and what that reader refuses is
// the function's own error, in the JS library's words, after the access check.
import {
  Base64,
  commitTsPlaceholder,
  isSpecialFloat,
  type JSONValue,
  type Value,
  validateObjectField,
} from "@bunvex/values";

/** Arguments a system function's reader refused: the function throws `message` once it runs. */
export class UnparsedSystemArgs {
  constructor(readonly message: string) {}
}

/** Eight bytes of `$integer` / `$float`, else the reader's error. */
function eightBytes(b64: string, tag: "$integer" | "$float"): DataView {
  const bytes = Base64.toByteArray(b64);
  if (bytes.byteLength !== 8) throw new Error(`Received ${bytes.byteLength} bytes, expected 8 for ${tag}`);
  return new DataView(bytes.buffer, bytes.byteOffset, 8);
}

/** The JS library's reading of a JSON value, with its errors (`jsonToConvex`). */
function read(value: JSONValue): Value {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(read);
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const k = keys[0]!;
    const x = value[k];
    // `${value}` of a plain object, as the JS library prints it.
    const malformed = () => new Error(`Malformed ${k} field on [object Object]`);
    if (k === "$bytes") {
      if (typeof x !== "string") throw malformed();
      const bytes = Base64.toByteArray(x);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
    if (k === "$integer") {
      if (typeof x !== "string") throw malformed();
      return eightBytes(x, "$integer").getBigInt64(0, true);
    }
    if (k === "$float") {
      if (typeof x !== "string") throw malformed();
      const f = eightBytes(x, "$float").getFloat64(0, true);
      if (!isSpecialFloat(f)) throw new Error(`Float ${f} should be encoded as a number`);
      return f;
    }
    if (k === "$commitTs") {
      if (x !== null) throw malformed();
      return commitTsPlaceholder as unknown as Value;
    }
    // The JS library says "a Convex type"; bunvex names itself (rule 5).
    if (k === "$set") throw new Error("Received a Set which is no longer supported as a bunvex type.");
    if (k === "$map") throw new Error("Received a Map which is no longer supported as a bunvex type.");
  }
  const out: Record<string, Value> = {};
  for (const [k, x] of Object.entries(value)) {
    validateObjectField(k);
    out[k] = read(x as JSONValue);
  }
  return out;
}

/**
 * A system function's arguments the backend's parse refused, read as the system function's wrapper reads them:
 * the value, or `UnparsedSystemArgs` with the reader's message.
 */
export function readSystemArgs(json: unknown): Value | UnparsedSystemArgs {
  try {
    return read(json as JSONValue);
  } catch (e) {
    return new UnparsedSystemArgs((e as Error).message);
  }
}

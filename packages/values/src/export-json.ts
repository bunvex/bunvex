// The snapshot export's value encoding (STUDY-42), Convex's "clean lossless" ConvexExportJSON
// (crates/value/src/export.rs `export_clean_lossless`, serde_json with `float_roundtrip` and ryu):
//
// - int64 (bigint) is a plain JSON integer; float64 always prints as a float (`123.0`, `-0.0`, `1.5e-7`,
//   `1e21`), in ryu's shortest form, so an importer tells them apart;
// - NaN and ±Infinity are `{"$float": base64 of the little-endian bytes}`; bytes are `{"$bytes": base64}`;
// - object keys in byte order (Convex's objects are BTreeMaps).
// Decoding (`fromExportJson`) reads the same: an integer literal is int64, a number with a point or an
// exponent float64, an object whose first key starts with `$` the internal form.
import { compareUtf8, toBase64 } from "./bytes.ts";
import type { Value } from "./value.ts";
import { fromJsonValue, type JSONValue } from "./value.ts";

const b64 = toBase64;

/** A finite float64 as serde_json writes it (ryu's `format64`): shortest round-trip digits, always a float. */
export function formatExportFloat(n: number): string {
  if (Object.is(n, 0)) return "0.0";
  if (Object.is(n, -0)) return "-0.0";
  const sign = n < 0 ? "-" : "";
  // JS's shortest round-trip digits, as ryu's: `d.ddde±x`.
  const [mant, expStr] = Math.abs(n).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const length = digits.length;
  const kk = Number(expStr) + 1; // the decimal point's position after the first digit
  const k = kk - length;
  let out: string;
  if (k >= 0 && kk <= 16) out = `${digits}${"0".repeat(k)}.0`;
  else if (kk > 0 && kk <= 16) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) out = `0.${"0".repeat(-kk)}${digits}`;
  else if (length === 1) out = `${digits}e${kk - 1}`;
  else out = `${digits[0]}.${digits.slice(1)}e${kk - 1}`;
  return sign + out;
}

const byteOrder = compareUtf8;

function write(v: Value): string {
  if (v === null) return "null";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (Number.isFinite(v)) return formatExportFloat(v);
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, v, true);
    return `{"$float":"${b64(buf)}"}`;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (v instanceof ArrayBuffer) return `{"$bytes":"${b64(new Uint8Array(v))}"}`;
  if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
  const keys = Object.keys(v).sort(byteOrder);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${write((v as Record<string, Value>)[k]!)}`).join(",")}}`;
}

/** A value (a document) in the export's encoding, as one line of `documents.jsonl` (without the newline). */
export const toExportJson = (v: Value): string => write(v);

/**
 * A value from the export's encoding. Integer literals are int64 and other numbers float64, so the text is
 * parsed with the numbers kept as written.
 */
export function fromExportJson(text: string): Value {
  // Mark each number token by its form before JSON.parse loses it: integer literals become `{"$int": "…"}`.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j++;
      const tok = text.slice(i, j);
      out += /^-?\d+$/.test(tok) ? `{"$__int":"${tok}"}` : tok;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  const revive = (v: unknown): Value => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === "$__int") return BigInt(o.$__int as string);
      if (keys[0]?.startsWith("$")) return fromJsonValue(o as JSONValue);
      return Object.fromEntries(keys.map((k) => [k, revive(o[k])]));
    }
    return v as Value;
  };
  return revive(JSON.parse(out));
}

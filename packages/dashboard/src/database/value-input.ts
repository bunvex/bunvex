// What a person types into a filter value box, as a Value — and back. JSON is read as JSON (`42`, `true`,
// `null`, `"a string"`, `[1, 2]`, `{"a": 1}`); `42n` is a 64-bit integer; anything else that is not JSON is
// the text itself, so `ada@example.com` needs no quotes.
import type { Value } from "../data-source.ts";
import { decodeInt64, encodeInt64, valueType } from "../filters.ts";

export type Parsed = { ok: true; value: Value } | { ok: false; error: string };

const INT64 = /^-?\d+n$/;

export function parseValueInput(text: string): Parsed {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Type a value" };
  if (INT64.test(t)) {
    const n = BigInt(t.slice(0, -1));
    if (n < -(2n ** 63n) || n >= 2n ** 63n) return { ok: false, error: "Out of the 64-bit integer range" };
    return { ok: true, value: encodeInt64(n) };
  }
  try {
    const v = JSON.parse(t) as Value;
    if (typeof v === "number" && !Number.isFinite(v)) return { ok: false, error: "Not a finite number" };
    return { ok: true, value: v };
  } catch {
    // a bare word or an unfinished JSON literal
    if (/^[[{"]/.test(t)) return { ok: false, error: "Not valid JSON" };
    return { ok: true, value: t };
  }
}

/** How a value is written in a value box: the inverse of parseValueInput. */
export function formatValueInput(v: Value): string {
  switch (valueType(v)) {
    case "int64":
      return `${decodeInt64(v as { $integer: string })}n`;
    case "string": {
      const s = v as string;
      // a string that would read back as something else keeps its quotes
      const reads = parseValueInput(s);
      return reads.ok && reads.value === s ? s : JSON.stringify(s);
    }
    default:
      return JSON.stringify(v);
  }
}

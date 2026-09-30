// What a person types into a value box — a filter value, a cell — as a Value, and back. The syntax is
// JavaScript literals, as in Convex's dashboard (STUDY-12 D9): `42`, `"text"`, `true`, `null`, `[1, 2]`,
// `{ a: 1 }`, `10n` for a 64-bit integer, `Bytes("…")`. Text needs quotes. `undefined` (in a cell) removes
// the field.
import type { Value } from "../data-source.ts";
import { formatLiteral, type Literal, parseLiteral, UNSET } from "./literal.ts";

export type Parsed = { ok: true; value: Value } | { ok: false; error: string; offset?: number };

/** A value; `undefined` is refused (there is nothing to compare with). */
export function parseValueInput(text: string): Parsed {
  const r = parseLiteral(text);
  if (!r.ok) return r;
  if (r.value === UNSET) return { ok: false, error: "undefined is not a value here", offset: 0 };
  return { ok: true, value: r.value };
}

/** How a value is written in a value box: the inverse of parseValueInput. */
export const formatValueInput = (v: Literal): string => formatLiteral(v);

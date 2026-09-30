// How document values read in a table cell, and which columns a page of documents has. Pure, so it is
// tested without a DOM.
import type { Document, Value } from "../data-source.ts";
import { valueType } from "../filters.ts";
import { formatLiteral } from "./literal.ts";

/** `_id` first, then every other field in the order it first appears, `_creationTime` last (as Convex). */
export function documentFields(docs: Document[]): string[] {
  const seen = new Set<string>(["_id", "_creationTime"]);
  const out = ["_id"];
  for (const d of docs)
    for (const k of Object.keys(d))
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
  out.push("_creationTime");
  return out;
}

export type CellKind =
  | "missing"
  | "null"
  | "string"
  | "id"
  | "number"
  | "int64"
  | "boolean"
  | "bytes"
  | "json"
  | "time";
export type CellText = { text: string; kind: CellKind };

const ID = /^[0-9a-hjkmnp-tv-z]{32}$/;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const MAX = 120;
const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** A wall-clock ms time as "2026-09-29 12:04:05" in the viewer's time zone. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A value as a compact JavaScript literal: `12n` for int64, `Bytes("…")` for bytes (STUDY-12 D9). */
export const literal = (v: Value): string => formatLiteral(v);

/** One cell: `undefined` is a field the document does not have, which is not the same as `null`. */
export function cellText(field: string, value: Value | undefined): CellText {
  const t = valueType(value);
  if (t === "unset") return { text: "unset", kind: "missing" };
  if (t === "null") return { text: "null", kind: "null" };
  if (field === "_creationTime" && t === "number") return { text: formatTime(value as number), kind: "time" };
  if (t === "string") return { text: cut(value as string), kind: ID.test(value as string) ? "id" : "string" };
  if (t === "number") return { text: String(value), kind: "number" };
  if (t === "boolean") return { text: String(value), kind: "boolean" };
  if (t === "int64") return { text: literal(value as Value), kind: "int64" };
  if (t === "bytes") return { text: cut(literal(value as Value)), kind: "bytes" };
  return { text: cut(literal(value as Value)), kind: "json" };
}

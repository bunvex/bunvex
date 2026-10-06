// System rows against Convex's (STUDY-134): the rows of a fresh Convex deployment's SQLite database, kept here
// as fixtures (one JSON file per table, `globals.json` for the persistence globals), and a comparison of a
// row's SHAPE — each field's value type, recursively — with theirs. Values (ids, times, hashes) differ from
// run to run; the shape is what bunvex must write as Convex does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toJsonValue, type Value } from "@bunvex/values";

/** A value's type as stored (Convex's JSON export format): an int64, a float64, bytes, a string, …; an array's
 * element shapes; an object's fields. */
export type Shape = string | { array: Shape[] } | { object: Record<string, Shape> };

/** The shape of a stored JSON value. */
export function shapeOf(v: unknown): Shape {
  if (v === null) return "null";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "float64";
  if (Array.isArray(v)) {
    const seen = new Map<string, Shape>();
    for (const e of v) {
      const s = shapeOf(e);
      seen.set(JSON.stringify(s), s);
    }
    return { array: [...seen.values()] };
  }
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === "$integer") return "int64";
  if (keys.length === 1 && keys[0] === "$bytes") return "bytes";
  if (keys.length === 1 && keys[0] === "$float") return "float64";
  return { object: Object.fromEntries(keys.sort().map((k) => [k, shapeOf(o[k])])) };
}

/**
 * Where `actual`'s shape differs from `expected`'s, as paths (empty: the same). An empty array matches any
 * array (one of the two runs had no element to show); `ignore` names top-level fields left out on both sides.
 */
export function shapeDiff(actual: unknown, expected: unknown, ignore: string[] = []): string[] {
  const drop = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([k]) => !ignore.includes(k)))
      : v;
  const out: string[] = [];
  compare(shapeOf(drop(actual)), shapeOf(drop(expected)), "$", out);
  return out;
}

function compare(a: Shape, b: Shape, path: string, out: string[]) {
  if (typeof a === "string" || typeof b === "string") {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${describe(a)}, Convex: ${describe(b)}`);
    return;
  }
  if ("array" in a && "array" in b) {
    if (a.array.length === 0 || b.array.length === 0) return;
    const bs = new Set(b.array.map((s) => JSON.stringify(s)));
    const as = new Set(a.array.map((s) => JSON.stringify(s)));
    if (a.array.length === 1 && b.array.length === 1) compare(a.array[0]!, b.array[0]!, `${path}[]`, out);
    else if ([...as].some((s) => !bs.has(s)) || [...bs].some((s) => !as.has(s)))
      out.push(`${path}[]: ${a.array.map(describe).join(" | ")}, Convex: ${b.array.map(describe).join(" | ")}`);
    return;
  }
  if ("object" in a && "object" in b) {
    for (const k of new Set([...Object.keys(a.object), ...Object.keys(b.object)])) {
      if (!(k in b.object)) out.push(`${path}.${k}: not in Convex's row`);
      else if (!(k in a.object)) out.push(`${path}.${k}: missing (Convex: ${describe(b.object[k]!)})`);
      else compare(a.object[k]!, b.object[k]!, `${path}.${k}`, out);
    }
    return;
  }
  out.push(`${path}: ${describe(a)}, Convex: ${describe(b)}`);
}

const describe = (s: Shape): string =>
  typeof s === "string" ? s : "array" in s ? `array of ${s.array.map(describe).join(" | ") || "nothing"}` : "object";

/** A document as bunvex stores it: the JSON its value encodes to. */
export const stored = (doc: unknown): unknown => toJsonValue(doc as Value);

type Fixture = { source: string; table: string; rows: Record<string, unknown>[]; note?: string };

/** Convex's rows of one system table, from the fixture of that name. */
export function convexRows(table: string): Record<string, unknown>[] {
  return (JSON.parse(readFileSync(join(import.meta.dir, `${table}.json`), "utf8")) as Fixture).rows;
}

/** Convex's persistence globals, by key. */
export function convexGlobals(): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(join(import.meta.dir, "globals.json"), "utf8")) as { globals: Record<string, unknown> }
  ).globals;
}

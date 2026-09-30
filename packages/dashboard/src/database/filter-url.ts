// The Database screen's filter lives in the URL as one `filter` param: the FilterExpression as JSON, in
// base64url (UI-01 §12.3). Reading is defensive — a hand-edited, truncated or old link yields `null` and
// the screen opens unfiltered — and structural only: whether the expression fits the table's indexes is
// the source's call (`validateFilter`), shown on the filter bar.
import {
  FIELD_OPS,
  type FieldFilter,
  type FilterExpression,
  type IndexFilter,
  VALUE_TYPES,
  type Value,
} from "../data-source.ts";

export function encodeFilter(expr: FilterExpression): string {
  const bytes = new TextEncoder().encode(JSON.stringify(expr));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Values are JSON; only their shape is checked here. */
const isValue = (v: unknown): v is Value => v !== undefined && typeof v !== "function";

function parseClause(v: unknown): FieldFilter | null {
  if (!isObject(v)) return null;
  const { id, field, op, value, enabled } = v;
  if (typeof id !== "string" || typeof field !== "string" || typeof enabled !== "boolean") return null;
  if (!FIELD_OPS.includes(op as never)) return null;
  const clause: FieldFilter = { id, field, op: op as FieldFilter["op"], enabled };
  if (value !== undefined) {
    if ((op === "type" || op === "notype") && !VALUE_TYPES.includes(value as never)) return null;
    if (!isValue(value)) return null;
    clause.value = value as FieldFilter["value"];
  }
  return clause;
}

function parseIndex(v: unknown): IndexFilter | null {
  if (!isObject(v) || typeof v.name !== "string" || !Array.isArray(v.eq)) return null;
  const eq: IndexFilter["eq"] = [];
  for (const c of v.eq) {
    if (!isObject(c) || typeof c.enabled !== "boolean" || !isValue(c.value)) return null;
    eq.push({ value: c.value, enabled: c.enabled });
  }
  const out: IndexFilter = { name: v.name, eq };
  if (v.range !== undefined) {
    if (!isObject(v.range)) return null;
    const range: NonNullable<IndexFilter["range"]> = {};
    const { lower, upper } = v.range;
    if (lower !== undefined) {
      if (!isObject(lower) || (lower.op !== "gt" && lower.op !== "gte") || !isValue(lower.value)) return null;
      range.lower = { op: lower.op, value: lower.value };
    }
    if (upper !== undefined) {
      if (!isObject(upper) || (upper.op !== "lt" && upper.op !== "lte") || !isValue(upper.value)) return null;
      range.upper = { op: upper.op, value: upper.value };
    }
    out.range = range;
  }
  return out;
}

/** The expression a `filter` param holds, or `null` when it is missing or not one. */
export function decodeFilter(param: string | undefined): FilterExpression | null {
  if (!param) return null;
  let raw: unknown;
  try {
    const b64 = param.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isObject(raw) || (raw.order !== "asc" && raw.order !== "desc") || !Array.isArray(raw.clauses)) return null;
  const clauses: FieldFilter[] = [];
  for (const c of raw.clauses) {
    const parsed = parseClause(c);
    if (!parsed) return null;
    clauses.push(parsed);
  }
  const expr: FilterExpression = { clauses, order: raw.order };
  if (raw.index !== undefined) {
    const index = parseIndex(raw.index);
    if (!index) return null;
    expr.index = index;
  }
  return expr;
}

/** The expression that means "no filter": it stays out of the URL. */
export const isEmptyFilter = (e: FilterExpression) =>
  e.order === "desc" &&
  e.clauses.length === 0 &&
  (!e.index || (e.index.name === "by_creation_time" && e.index.eq.length === 0 && !e.index.range));

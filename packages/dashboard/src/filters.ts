// What a FilterExpression means (UI-01 §12.4), as pure functions: the value order, the type of a value,
// validating an expression against a table's indexes, and deciding whether a document passes. The mock
// source evaluates with them; the filter bar uses them to offer only valid moves. A server implements the
// same semantics in its own terms — the contract suite checks that it does.
import {
  DataSourceError,
  type Document,
  FIELD_OPS,
  type FieldFilter,
  type FilterExpression,
  type IndexInfo,
  VALUE_TYPES,
  type Value,
  type ValueType,
} from "./data-source.ts";

export const DEFAULT_INDEX = "by_creation_time";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isEncoding = (v: unknown, key: "$integer" | "$bytes") =>
  isObject(v) && Object.keys(v).length === 1 && typeof v[key] === "string";

/** The type of a value; `undefined` (a field the document does not have) is `unset`. */
export function valueType(v: Value | undefined): ValueType {
  if (v === undefined) return "unset";
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  if (isEncoding(v, "$integer")) return "int64";
  if (isEncoding(v, "$bytes")) return "bytes";
  return "object";
}

const RANK: Record<ValueType, number> = {
  unset: 0,
  null: 1,
  int64: 2,
  number: 3,
  boolean: 4,
  string: 5,
  bytes: 6,
  array: 7,
  object: 8,
};

/** A 64-bit integer's value from its encoding (8 bytes, little-endian two's complement, base64). */
export function decodeInt64(e: { $integer: string }): bigint {
  const bytes = Uint8Array.from(atob(e.$integer), (c) => c.charCodeAt(0));
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] ?? 0);
  return BigInt.asIntN(64, n);
}

export function encodeInt64(n: bigint): { $integer: string } {
  let u = BigInt.asUintN(64, n);
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(u & 0xffn);
    u >>= 8n;
  }
  return { $integer: btoa(String.fromCharCode(...bytes)) };
}

/** The total order of values (Convex's): unset < null < int64 < number < boolean < string < bytes < array < object. */
export function compareValues(a: Value | undefined, b: Value | undefined): number {
  const ta = valueType(a);
  const tb = valueType(b);
  if (ta !== tb) return RANK[ta] - RANK[tb];
  switch (ta) {
    case "unset":
    case "null":
      return 0;
    case "int64": {
      const x = decodeInt64(a as { $integer: string });
      const y = decodeInt64(b as { $integer: string });
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "bytes": {
      const x = atob((a as { $bytes: string }).$bytes);
      const y = atob((b as { $bytes: string }).$bytes);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "array": {
      const x = a as Value[];
      const y = b as Value[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compareValues(x[i], y[i]);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    case "object": {
      // key by key, in key order, then the value — enough for a stable, total order
      const x = Object.entries(a as object).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0));
      const y = Object.entries(b as object).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0));
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const [kx, vx] = x[i]!;
        const [ky, vy] = y[i]!;
        if (kx !== ky) return kx < ky ? -1 : 1;
        const c = compareValues(vx as Value, vy as Value);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    default: {
      const x = a as number | string | boolean;
      const y = b as number | string | boolean;
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
}

/** A document's field, following dots into nested objects ("meta.edited"). */
export function fieldValue(doc: Document, field: string): Value | undefined {
  let v: Value | undefined = doc;
  for (const part of field.split(".")) {
    if (!isObject(v) || isEncoding(v, "$integer") || isEncoding(v, "$bytes")) return undefined;
    v = (v as Record<string, Value>)[part];
  }
  return v;
}

/** Whether a document passes one (enabled) field filter. */
export function matchesClause(doc: Document, c: FieldFilter): boolean {
  const v = fieldValue(doc, c.field);
  const cmp = () => compareValues(v, c.value as Value);
  switch (c.op) {
    case "eq":
      return v !== undefined && cmp() === 0;
    case "neq":
      return v === undefined || cmp() !== 0;
    case "gt":
      return v !== undefined && cmp() > 0;
    case "gte":
      return v !== undefined && cmp() >= 0;
    case "lt":
      return v !== undefined && cmp() < 0;
    case "lte":
      return v !== undefined && cmp() <= 0;
    case "anyOf":
      return v !== undefined && (c.value as Value[]).some((x) => compareValues(v, x) === 0);
    case "noneOf":
      return v === undefined || !(c.value as Value[]).some((x) => compareValues(v, x) === 0);
    case "type":
      return valueType(v) === c.value;
    case "notype":
      return valueType(v) !== c.value;
  }
}

const bad = (message: string, clause: string) => new DataSourceError("invalid_request", message, { clause });

/**
 * Checks an expression against a table's indexes; throws `invalid_request` naming the clause. Returns the
 * index it reads (the default when none is given).
 */
export function validateFilter(expr: FilterExpression, indexes: IndexInfo[]): IndexInfo {
  if (expr.order !== "asc" && expr.order !== "desc") throw bad(`order must be "asc" or "desc"`, "order");
  const name = expr.index?.name ?? DEFAULT_INDEX;
  const ix = indexes.find((i) => i.name === name);
  if (!ix) throw bad(`no index "${name}"`, "index");
  if (ix.state !== "ready") throw bad(`index "${name}" is still backfilling`, "index");
  if (expr.index) {
    const { eq, range } = expr.index;
    const fields = ix.name === "by_id" ? ["_id"] : ix.fields;
    if (eq.length > fields.length) throw bad(`"${name}" has ${fields.length} field(s), got ${eq.length}`, "index");
    const firstDisabled = eq.findIndex((c) => !c.enabled);
    if (firstDisabled >= 0 && eq.slice(firstDisabled).some((c) => c.enabled))
      throw bad("an enabled index clause cannot follow a disabled one", "index");
    if (range) {
      const enabledEq = firstDisabled >= 0 ? firstDisabled : eq.length;
      if (enabledEq >= fields.length) throw bad("no index field is left for the range", "index");
      if (range.lower && range.lower.op !== "gt" && range.lower.op !== "gte")
        throw bad("the lower bound must be gt or gte", "index");
      if (range.upper && range.upper.op !== "lt" && range.upper.op !== "lte")
        throw bad("the upper bound must be lt or lte", "index");
    }
  }
  const ids = new Set<string>();
  for (const c of expr.clauses) {
    if (!c.id || ids.has(c.id)) throw bad("every clause needs a unique id", c.id || "?");
    ids.add(c.id);
    if (!c.enabled) continue;
    if (!c.field) throw bad("a clause needs a field", c.id);
    if (!FIELD_OPS.includes(c.op)) throw bad(`unknown operator "${c.op}"`, c.id);
    if ((c.op === "anyOf" || c.op === "noneOf") && !Array.isArray(c.value))
      throw bad(`${c.op} takes a list of values`, c.id);
    if ((c.op === "type" || c.op === "notype") && !VALUE_TYPES.includes(c.value as ValueType))
      throw bad(`${c.op} takes a type name`, c.id);
    if (!["anyOf", "noneOf", "type", "notype"].includes(c.op) && c.value === undefined)
      throw bad(`${c.op} needs a value`, c.id);
  }
  return ix;
}

/** Whether a document is inside the index part the expression reads (its eq prefix and range). */
export function inIndexRange(doc: Document, expr: FilterExpression, ix: IndexInfo): boolean {
  if (!expr.index) return true;
  const fields = ix.name === "by_id" ? ["_id"] : ix.fields;
  const eq = expr.index.eq.filter((c) => c.enabled);
  for (let i = 0; i < eq.length; i++) if (compareValues(fieldValue(doc, fields[i]!), eq[i]!.value) !== 0) return false;
  const r = expr.index.range;
  if (r) {
    const v = fieldValue(doc, fields[eq.length]!);
    if (r.lower && (r.lower.op === "gt" ? compareValues(v, r.lower.value) <= 0 : compareValues(v, r.lower.value) < 0))
      return false;
    if (r.upper && (r.upper.op === "lt" ? compareValues(v, r.upper.value) >= 0 : compareValues(v, r.upper.value) > 0))
      return false;
  }
  return true;
}

/** Whether a document passes the whole expression (index part and every enabled clause). */
export const matchesFilter = (doc: Document, expr: FilterExpression, ix: IndexInfo) =>
  inIndexRange(doc, expr, ix) && expr.clauses.every((c) => !c.enabled || matchesClause(doc, c));

/** The same query, whatever its disabled clauses or clause ids: what a cursor is bound to. */
export function canonicalFilter(table: string, expr: FilterExpression | undefined): string {
  if (!expr) return JSON.stringify([table, DEFAULT_INDEX, [], null, [], "desc"]);
  const eq = (expr.index?.eq ?? []).filter((c) => c.enabled).map((c) => c.value);
  const clauses = expr.clauses.filter((c) => c.enabled).map((c) => [c.field, c.op, c.value ?? null]);
  return JSON.stringify([table, expr.index?.name ?? DEFAULT_INDEX, eq, expr.index?.range ?? null, clauses, expr.order]);
}

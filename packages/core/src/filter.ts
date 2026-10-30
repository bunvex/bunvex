// `.filter(q => …)` (STUDY-15): the filter builder and its evaluation, with the semantics of Convex's
// `Expression::eval` (crates/common/src/query.rs): comparisons in index-key order (a missing field is
// `undefined`, below null), arithmetic only on two int64s or two float64s, booleans only for and/or/not.
import {
  compareValues,
  displayValue,
  fromJsonValue,
  hasCommitTs,
  isBytes,
  type JSONValue,
  toJsonValue,
  type Value,
} from "@bunvex/values";
import type { Doc } from "./schema.ts";
import { fieldValue } from "./schema.ts";

type MaybeValue = Value | undefined;

// `T` for the types only (STUDY-36); `json` as Convex's `ExpressionImpl.serialize()`; the cursor check is STUDY-17 D3.
/**
 * An expression of a filter; `T` is its value's type (types only). `json` is its serialized form
 * (`{ $eq: [{ $field: "a" }, { $literal: 1 }] }`): a paginated query's cursor fingerprint covers it, so a cursor of
 * another filter is refused.
 */
// biome-ignore lint/correctness/noUnusedVariables: T is only for the typed filter builder
export class Expression<T = unknown> {
  constructor(
    readonly evaluate: (doc: Doc) => MaybeValue,
    readonly json: JSONValue,
  ) {}
}

/** A literal's serialized form, as Convex's `{ $literal: … }` (`undefined` as Convex's `$undefined`). */
function literalJson(x: unknown): JSONValue {
  if (x === undefined) return { $literal: { $undefined: null } };
  try {
    return { $literal: toJsonValue(x as Value) };
  } catch {
    // Not a value: evaluating it fails as before (the predicate must be a boolean); the fingerprint only needs
    // to tell it apart.
    return { $literal: { $notAValue: String(x) } };
  }
}
/** What the filter builder takes at run time: an expression or a literal (the typed form is `ExpressionOrValueOf`). */
export type FilterOperand<T = unknown> = Expression | (T & Value) | undefined;

const toExpr = (x: FilterOperand): Expression => {
  if (x instanceof Expression) return x;
  // A literal is a plain value: Convex's expression JSON refuses the commit timestamp's token (STUDY-53).
  if (hasCommitTs(x)) throw new Error("Field name $commitTs starts with '$', which is reserved.");
  return new Expression(() => x as MaybeValue, literalJson(x));
};

/** A predicate's serialized form (a literal one included): what a cursor's fingerprint covers. */
export const expressionJson = (x: FilterOperand): JSONValue => toExpr(x).json;

/** A value's type as Convex's errors name it (`MaybeValue::type_name`, crates/value/src/walk.rs): `Float64`, `Bytes`, … */
function typeName(v: MaybeValue): string {
  if (v === undefined) return "undefined";
  if (v === null) return "Null";
  if (typeof v === "bigint") return "Int64";
  if (typeof v === "number") return "Float64";
  if (typeof v === "boolean") return "Boolean";
  if (typeof v === "string") return "String";
  if (isBytes(v)) return "Bytes";
  return Array.isArray(v) ? "Array" : "Object";
}

function asBoolean(v: MaybeValue): boolean {
  if (typeof v === "boolean") return v;
  throw new Error(`Cannot use value ${displayValue(v)} (type ${typeName(v)}) as a Boolean`);
}

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

function arithmetic(
  name: string,
  l: MaybeValue,
  r: MaybeValue,
  ints: (a: bigint, b: bigint) => bigint | null,
  floats: (a: number, b: number) => number,
): Value {
  if (typeof l === "bigint" && typeof r === "bigint") {
    const res = ints(l, r);
    if (res === null) throw new Error(`Cannot ${name} ${l} by zero`);
    if (res < MIN_INT64 || res > MAX_INT64)
      throw new Error(`Cannot ${name} ${l} and ${r}: the result is out of range for Int64`);
    return res;
  }
  if (typeof l === "number" && typeof r === "number") return floats(l, r);
  throw new Error(
    `Cannot ${name} ${displayValue(l)} (type ${typeName(l)}) and ${displayValue(r)} (type ${typeName(r)})`,
  );
}

const binary =
  (op: string, f: (l: MaybeValue, r: MaybeValue) => MaybeValue) => (a: FilterOperand, b: FilterOperand) => {
    const [x, y] = [toExpr(a), toExpr(b)];
    return new Expression((doc) => f(x.evaluate(doc), y.evaluate(doc)), { [op]: [x.json, y.json] });
  };

/** The builder a filter predicate receives, as Convex's `FilterBuilder`. */
export const filterBuilder = {
  field: (path: string) => new Expression((doc) => fieldValue(doc, path), { $field: path }),
  eq: binary("$eq", (l, r) => compareValues(l, r) === 0),
  neq: binary("$neq", (l, r) => compareValues(l, r) !== 0),
  lt: binary("$lt", (l, r) => compareValues(l, r) < 0),
  lte: binary("$lte", (l, r) => compareValues(l, r) <= 0),
  gt: binary("$gt", (l, r) => compareValues(l, r) > 0),
  gte: binary("$gte", (l, r) => compareValues(l, r) >= 0),
  add: binary("$add", (l, r) =>
    arithmetic(
      "add",
      l,
      r,
      (a, b) => a + b,
      (a, b) => a + b,
    ),
  ),
  sub: binary("$sub", (l, r) =>
    arithmetic(
      "subtract",
      l,
      r,
      (a, b) => a - b,
      (a, b) => a - b,
    ),
  ),
  mul: binary("$mul", (l, r) =>
    arithmetic(
      "multiply",
      l,
      r,
      (a, b) => a * b,
      (a, b) => a * b,
    ),
  ),
  div: binary("$div", (l, r) =>
    arithmetic(
      "divide",
      l,
      r,
      (a, b) => (b === 0n ? null : a / b),
      (a, b) => a / b,
    ),
  ),
  mod: binary("$mod", (l, r) =>
    arithmetic(
      "mod",
      l,
      r,
      (a, b) => (b === 0n ? null : a % b),
      (a, b) => a % b,
    ),
  ),
  neg: (x: FilterOperand) => {
    const e = toExpr(x);
    return new Expression(
      (doc) => {
        const v = e.evaluate(doc);
        if (typeof v === "bigint") {
          if (-v > MAX_INT64) throw new Error(`Cannot negate ${v}: the result is out of range for Int64`);
          return -v;
        }
        if (typeof v === "number") return -v;
        throw new Error(`Cannot negate ${displayValue(v)} (type ${typeName(v)})`);
      },
      { $neg: e.json },
    );
  },
  and: (...xs: FilterOperand[]) => {
    const es = xs.map(toExpr);
    return new Expression((doc) => es.every((e) => asBoolean(e.evaluate(doc))), { $and: es.map((e) => e.json) });
  },
  or: (...xs: FilterOperand[]) => {
    const es = xs.map(toExpr);
    return new Expression((doc) => es.some((e) => asBoolean(e.evaluate(doc))), { $or: es.map((e) => e.json) });
  },
  not: (x: FilterOperand) => {
    const e = toExpr(x);
    return new Expression((doc) => !asBoolean(e.evaluate(doc)), { $not: e.json });
  },
};
export type FilterBuilder = typeof filterBuilder;

/** Whether `doc` passes a predicate's expression (it must evaluate to a boolean). */
export const passes = (e: FilterOperand, doc: Doc) => asBoolean(toExpr(e).evaluate(doc));

const BINARY = {
  $eq: "eq",
  $neq: "neq",
  $lt: "lt",
  $lte: "lte",
  $gt: "gt",
  $gte: "gte",
  $add: "add",
  $sub: "sub",
  $mul: "mul",
  $div: "div",
  $mod: "mod",
} as const;

/**
 * A predicate's serialized form (`expressionJson`) back as what the filter builder made: the function sandbox's
 * host runs the filter a child's query built (STUDY-171 §8.4). A literal is its value (a top-level one too, as the
 * predicate returned it); a literal that was not a value comes back as its description, which no value equals.
 * Throws on anything `expressionJson` never makes.
 */
export function expressionFromJson(j: JSONValue): FilterOperand {
  const parse = (x: JSONValue): FilterOperand => {
    if (x === null || typeof x !== "object" || Array.isArray(x)) throw new Error("not a filter expression");
    const keys = Object.keys(x);
    if (keys.length !== 1) throw new Error("not a filter expression");
    const op = keys[0]!;
    const body = (x as Record<string, JSONValue>)[op]!;
    if (op === "$field") {
      if (typeof body !== "string") throw new Error("not a filter expression");
      return filterBuilder.field(body);
    }
    if (op === "$literal") {
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        if ("$undefined" in body) return undefined;
        if ("$notAValue" in body) return String(body.$notAValue) as Value;
      }
      return fromJsonValue(body) as Value;
    }
    if (op in BINARY) {
      if (!Array.isArray(body) || body.length !== 2) throw new Error("not a filter expression");
      return filterBuilder[BINARY[op as keyof typeof BINARY]](parse(body[0]!), parse(body[1]!));
    }
    if (op === "$neg" || op === "$not") return filterBuilder[op === "$neg" ? "neg" : "not"](parse(body));
    if (op === "$and" || op === "$or") {
      if (!Array.isArray(body)) throw new Error("not a filter expression");
      return filterBuilder[op === "$and" ? "and" : "or"](...body.map(parse));
    }
    throw new Error("not a filter expression");
  };
  return parse(j);
}

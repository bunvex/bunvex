// `.filter(q => …)` (STUDY-15): the filter builder and its evaluation, with the semantics of Convex's
// `Expression::eval` (crates/common/src/query.rs): comparisons in index-key order (a missing field is
// `undefined`, below null), arithmetic only on two int64s or two float64s, booleans only for and/or/not.
import { compareValues, displayValue, hasCommitTs, isBytes, type Value } from "@bunvex/values";
import type { Doc } from "./schema.ts";
import { fieldValue } from "./schema.ts";

type MaybeValue = Value | undefined;

/** An expression of a filter; `T` is its value's type (types only, STUDY-36). */
// biome-ignore lint/correctness/noUnusedVariables: T is only for the typed filter builder
export class Expression<T = unknown> {
  constructor(readonly evaluate: (doc: Doc) => MaybeValue) {}
}
export type ExpressionOrValue<T = unknown> = Expression | (T & Value) | undefined;

const toExpr = (x: ExpressionOrValue): Expression => {
  if (x instanceof Expression) return x;
  // A literal is a plain value: Convex's expression JSON refuses the commit timestamp's token (STUDY-53).
  if (hasCommitTs(x)) throw new Error("Field name $commitTs starts with '$', which is reserved.");
  return new Expression(() => x as MaybeValue);
};

function typeName(v: MaybeValue): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "bigint") return "int64";
  if (typeof v === "number") return "float64";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "string";
  if (isBytes(v)) return "bytes";
  return Array.isArray(v) ? "array" : "object";
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

const binary = (f: (l: MaybeValue, r: MaybeValue) => MaybeValue) => (a: ExpressionOrValue, b: ExpressionOrValue) => {
  const [x, y] = [toExpr(a), toExpr(b)];
  return new Expression((doc) => f(x.evaluate(doc), y.evaluate(doc)));
};

/** The builder a filter predicate receives, as Convex's `FilterBuilder`. */
export const filterBuilder = {
  field: (path: string) => new Expression((doc) => fieldValue(doc, path)),
  eq: binary((l, r) => compareValues(l, r) === 0),
  neq: binary((l, r) => compareValues(l, r) !== 0),
  lt: binary((l, r) => compareValues(l, r) < 0),
  lte: binary((l, r) => compareValues(l, r) <= 0),
  gt: binary((l, r) => compareValues(l, r) > 0),
  gte: binary((l, r) => compareValues(l, r) >= 0),
  add: binary((l, r) =>
    arithmetic(
      "add",
      l,
      r,
      (a, b) => a + b,
      (a, b) => a + b,
    ),
  ),
  sub: binary((l, r) =>
    arithmetic(
      "subtract",
      l,
      r,
      (a, b) => a - b,
      (a, b) => a - b,
    ),
  ),
  mul: binary((l, r) =>
    arithmetic(
      "multiply",
      l,
      r,
      (a, b) => a * b,
      (a, b) => a * b,
    ),
  ),
  div: binary((l, r) =>
    arithmetic(
      "divide",
      l,
      r,
      (a, b) => (b === 0n ? null : a / b),
      (a, b) => a / b,
    ),
  ),
  mod: binary((l, r) =>
    arithmetic(
      "mod",
      l,
      r,
      (a, b) => (b === 0n ? null : a % b),
      (a, b) => a % b,
    ),
  ),
  neg: (x: ExpressionOrValue) => {
    const e = toExpr(x);
    return new Expression((doc) => {
      const v = e.evaluate(doc);
      if (typeof v === "bigint") {
        if (-v > MAX_INT64) throw new Error(`Cannot negate ${v}: the result is out of range for Int64`);
        return -v;
      }
      if (typeof v === "number") return -v;
      throw new Error(`Cannot negate ${displayValue(v)} (type ${typeName(v)})`);
    });
  },
  and: (...xs: ExpressionOrValue[]) => {
    const es = xs.map(toExpr);
    return new Expression((doc) => es.every((e) => asBoolean(e.evaluate(doc))));
  },
  or: (...xs: ExpressionOrValue[]) => {
    const es = xs.map(toExpr);
    return new Expression((doc) => es.some((e) => asBoolean(e.evaluate(doc))));
  },
  not: (x: ExpressionOrValue) => {
    const e = toExpr(x);
    return new Expression((doc) => !asBoolean(e.evaluate(doc)));
  },
};
export type FilterBuilder = typeof filterBuilder;

/** Whether `doc` passes a predicate's expression (it must evaluate to a boolean). */
export const passes = (e: ExpressionOrValue, doc: Doc) => asBoolean(toExpr(e).evaluate(doc));

// A query's operators (STUDY-66 §1), as Convex's (npm-packages/convex/src/server/impl/query_impl.ts,
// crates/database/src/query/{filter,limit}.rs): `filter` and `limit`, applied in the order the app chained
// them. Each wraps the stream before it, so `.limit(5).filter(f)` keeps those of the first five that pass,
// and a limit that is full ends the whole stream before anything more is read.
import { type ExpressionOrValue, passes } from "./filter.ts";
import { opaqueToInspect } from "./inspect.ts";
import type { Doc } from "./schema.ts";

/** Convex's MAX_QUERY_OPERATORS (crates/common/src/query.rs). */
export const MAX_QUERY_OPERATORS = 256;

export type QueryOp = { filter: ExpressionOrValue } | { limit: number };

/** What `filter` throws when the query already has the most operators (Convex's client-side check). */
export const TOO_MANY_OPERATORS = `Can't construct query with more than ${MAX_QUERY_OPERATORS} operators`;

/**
 * The checks Convex's backend makes when a query starts (`Query::try_from`, crates/common/src/json/query.rs):
 * each limit is a `usize`, then at most MAX_QUERY_OPERATORS operators — the terminal's limit (`take`,
 * `first`, `unique`) included. As Convex's `with_argument_error`, the message names the syscall:
 * `queryStream`, or `queryPage` for `paginate`.
 */
export function checkOps(ops: QueryOp[], syscall: "queryStream" | "queryPage", terminalLimit = false) {
  for (const op of ops)
    if ("limit" in op) {
      const why = usizeError(op.limit);
      if (why) throw new Error(`Invalid argument \`query\` for \`${syscall}\`: ${why}`);
    }
  const n = ops.length + (terminalLimit ? 1 : 0);
  if (n > MAX_QUERY_OPERATORS)
    throw new Error(`Invalid argument \`query\` for \`${syscall}\`: Query has too many operators: ${n}`);
}

/**
 * Why a JSON value is not a `usize`, worded as the deserializer Convex uses words it (serde's `Unexpected`):
 * the limit travels as JSON, so `NaN` and the infinities arrive as `null`.
 */
function usizeError(n: unknown): string | null {
  if (typeof n === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  if (typeof n === "number") {
    if (!Number.isFinite(n)) return "invalid type: null, expected usize";
    // JSON integers parse as u64 or i64; anything else is a float.
    if (Number.isInteger(n) && n >= 0 && n < 2 ** 64) return null;
    if (Number.isInteger(n) && n < 0 && n >= -(2 ** 63)) return `invalid value: integer \`${n}\`, expected usize`;
    return `invalid type: floating point \`${floatText(n)}\`, expected usize`;
  }
  if (n === null) return "invalid type: null, expected usize";
  if (typeof n === "boolean") return `invalid type: boolean \`${n}\`, expected usize`;
  if (typeof n === "string") return `invalid type: string ${JSON.stringify(n)}, expected usize`;
  if (Array.isArray(n)) return "invalid type: sequence, expected usize";
  return "invalid type: map, expected usize";
}

/** A float as Rust prints one (no exponent), with a decimal point (serde's `WithDecimalPoint`). */
function floatText(x: number): string {
  let s = String(x);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(s);
  if (m) {
    const [, sign, head, tail = "", dir, exp] = m;
    const digits = head + tail;
    const e = Number(exp);
    s =
      dir === "+" ? sign + digits + "0".repeat(Math.max(0, e - tail.length)) : `${sign}0.${"0".repeat(e - 1)}${digits}`;
  }
  return s.includes(".") ? s : `${s}.0`;
}

/**
 * One run of a query's operators over its stream, then `take`'s limit when the terminal is `take(n)` /
 * `first()` / `unique()` (Convex's `limit(n).collect()`). `offer` says whether a document comes out; `done`
 * turns true once a limit is full, and then nothing more may be read (Convex's `Limit::next` returns before
 * it pulls from its source).
 */
export class Pipeline {
  done: boolean;
  /** The smallest limit, when every operator is a limit (the scan can then stop there); else null. */
  readonly onlyLimits: number | null;
  private readonly counts: number[] | null = null;
  private taken = 0;

  constructor(
    private readonly ops: QueryOp[],
    private readonly take: number = Number.POSITIVE_INFINITY,
  ) {
    let min = take;
    let filters = false;
    let limits = false;
    for (const op of ops) {
      if ("limit" in op) {
        limits = true;
        if (op.limit < min) min = op.limit;
      } else filters = true;
    }
    if (limits) this.counts = ops.map(() => 0);
    this.done = min <= 0;
    this.onlyLimits = filters ? null : min;
  }

  offer(doc: Doc): boolean {
    const ops = this.ops;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]!;
      if ("filter" in op) {
        if (!passes(op.filter, doc)) return false;
      } else if (++this.counts![i]! >= op.limit) this.done = true;
    }
    if (++this.taken >= this.take) this.done = true;
    return true;
  }
}

// Printed by name only: `console.log` of one never shows the engine's state (inspect.ts).
opaqueToInspect(Pipeline);

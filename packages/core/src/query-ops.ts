// A query's operators (STUDY-66 §1), as Convex's (npm-packages/convex/src/server/impl/query_impl.ts,
// crates/database/src/query/{filter,limit}.rs): `filter` and `limit`, applied in the order the app chained
// them. Each wraps the stream before it, so `.limit(5).filter(f)` keeps those of the first five that pass,
// and a limit that is full ends the whole stream before anything more is read.
import { identifierError } from "@bunvex/values";
import { expressionJson, type FilterOperand, passes } from "./filter.ts";
import { opaqueToInspect } from "./inspect.ts";
import type { Doc } from "./schema.ts";

/** Convex's MAX_QUERY_OPERATORS (crates/common/src/query.rs). */
export const MAX_QUERY_OPERATORS = 256;

export type QueryOp = { filter: FilterOperand } | { limit: number };

/** The operators as Convex's query JSON (`{ filter: <expression> }`, `{ limit: n }`); "" when there are none. */
export const serializeOps = (ops: QueryOp[]): string =>
  ops.length === 0
    ? ""
    : JSON.stringify(ops.map((op) => ("filter" in op ? { filter: expressionJson(op.filter) } : { limit: op.limit })));

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
    if (isU64(n)) return null;
    if (isNegativeI64(n)) return `invalid value: integer \`${n}\`, expected usize`;
  }
  return `invalid type: ${unexpected(n)}, expected usize`;
}

// A JSON integer parses as a u64 or an i64; anything else (a fraction, an exponent, out of range) as a float.
// `JSON.stringify` writes an integer below 1e21 with all its digits, so the bounds are the number's own.
const isU64 = (n: number) => Number.isInteger(n) && n >= 0 && n < 2 ** 64;
const isNegativeI64 = (n: number) => Number.isInteger(n) && n < 0 && n > -(2 ** 63);

/** How serde_json names a JSON value it did not expect (`invalid type: <this>, expected …`). */
function unexpected(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return `boolean \`${v}\``;
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (typeof v === "number")
    return isU64(v) || isNegativeI64(v) ? `integer \`${v}\`` : `floating point \`${floatText(v)}\``;
  if (Array.isArray(v)) return "sequence";
  return "map";
}

/**
 * A float as serde_json words one in an error (its `JsonUnexpected`, formatted by `zmij`): the shortest digits
 * that round-trip, plain for decimal exponents -5 to 15 (`0.5`, `123456.75`, `.0` when whole), else scientific
 * with a sign (`1e-7`, `1.8446744073709552e+19`), which is JavaScript's `toExponential()`.
 */
function floatText(x: number): string {
  const sci = x.toExponential();
  const exp = Number(sci.slice(sci.indexOf("e") + 1));
  if (exp < -5 || exp > 15) return sci;
  const s = String(x);
  return s.includes(".") ? s : `${s}.0`;
}

/** `paginate`'s options as the `queryPage` syscall reads them: absent limits are null. */
export type QueryPageArgs = {
  cursor: string | null;
  endCursor: string | null;
  pageSize: number;
  maximumRowsRead: number | null;
  maximumBytesRead: number | null;
};

/**
 * `paginate`'s options as Convex's client sends them and its `queryPage` syscall reads them (query_impl.ts
 * `paginate`, async_syscall.rs `query_page`). The client writes `{query, cursor, endCursor, pageSize,
 * maximumRowsRead, maximumBytesRead}` with `JSON.stringify` (a BigInt fails it; undefined is left out; `NaN` and
 * the infinities become null), `endCursor` and `maximumRowsRead` read with `?? null`. The syscall reads the
 * fields in that order, each an optional string or a `usize` (`pageSize` required), and the first that does not
 * fit fails with serde's message, as `with_argument_error` words it.
 */
export function queryPageArgs(opts: {
  numItems: number;
  cursor?: unknown;
  endCursor?: unknown;
  maximumRowsRead?: unknown;
  maximumBytesRead?: unknown;
}): QueryPageArgs {
  const sent = {
    cursor: opts.cursor,
    endCursor: opts.endCursor ?? null,
    pageSize: opts.numItems,
    maximumRowsRead: opts.maximumRowsRead ?? null,
    maximumBytesRead: opts.maximumBytesRead,
  };
  const json = JSON.parse(
    JSON.stringify(sent, (_k, x) => {
      // Convex's client rethrows the syscall's failure as an `Error` with its message.
      if (typeof x === "bigint") throw new Error("Do not know how to serialize a BigInt");
      return x;
    }),
  ) as Record<string, unknown>;
  const bad = (why: string) => new Error(`Invalid arguments for \`queryPage\`: ${why}`);
  const string = (v: unknown) => {
    if (v === undefined || v === null || typeof v === "string") return (v ?? null) as string | null;
    throw bad(`invalid type: ${unexpected(v)}, expected a string`);
  };
  const size = (v: unknown, optional: boolean) => {
    if (optional && (v === undefined || v === null)) return null;
    const why = usizeError(v);
    if (why) throw bad(why);
    return v as number;
  };
  const cursor = string(json.cursor);
  const endCursor = string(json.endCursor);
  const pageSize = size(json.pageSize, false) as number;
  const maximumRowsRead = size(json.maximumRowsRead, true);
  const maximumBytesRead = size(json.maximumBytesRead, true);
  return { cursor, endCursor, pageSize, maximumRowsRead, maximumBytesRead };
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

/**
 * Why a query's `table.index` name does not parse, as Convex's `IndexName::from_str` (crates/common/src/types/
 * index.rs) words it, or null: a bad table or a bad index descriptor are both its `invalid_table_name` (the
 * descriptor's error is wrapped in it too); a third component is too many.
 */
export function indexNameError(full: string): string | null {
  const parts = full.split(".");
  const invalid = (part: string) =>
    `Invalid table name: "${part}". Identifiers must start with a letter and can only contain letters, digits, and underscores.`;
  if (identifierError(parts[0]!) !== null) return invalid(parts[0]!);
  if (parts.length < 2) return `Insufficient components in index name ${full}`;
  if (identifierError(parts[1]!) !== null) return invalid(parts[1]!);
  if (parts.length > 2) return `Too many components in index name ${full}`;
  return null;
}

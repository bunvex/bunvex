// A query string as Convex's `Query` extractor reads it (`common/src/http/extract.rs`): serde_urlencoded into the
// route's struct, behind serde_path_to_error, an error being 400 `BadQueryArgs` "Failed to deserialize query
// string: <field>: <reason>" ("missing field `<field>`" for an absent one). Pairs are read in order, so a bad
// value is reported before a missing field; keys the struct does not have are ignored.

/** A query string field's Rust type. */
export type QueryKind = "string" | { int: "u64" | "u16" | "usize" | "i64" } | "bool" | { variants: readonly string[] };

/** A field: its name, its type, and whether it may be absent (`Option` or `#[serde(default)]`). */
export type QueryField = [name: string, kind: QueryKind, optional?: boolean];

export class QueryArgsError extends Error {
  readonly status = 400;
  readonly code = "BadQueryArgs";
  constructor(reason: string) {
    super(`Failed to deserialize query string: ${reason}`);
  }
}

const RANGE = {
  u64: [0n, 2n ** 64n - 1n],
  usize: [0n, 2n ** 64n - 1n],
  u16: [0n, 65535n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
} as const;

/** Rust's `str::parse` of an integer: its error message, or null when it parses and fits. */
export function intError(v: string, type: keyof typeof RANGE): string | null {
  if (v === "") return "cannot parse integer from empty string";
  const signed = type === "i64";
  const body = v.startsWith("+") || (signed && v.startsWith("-")) ? v.slice(1) : v;
  if (body === "" || !/^\d+$/.test(body)) return "invalid digit found in string";
  const n = BigInt(v.startsWith("+") ? v.slice(1) : v);
  const [lo, hi] = RANGE[type];
  if (n > hi) return "number too large to fit in target type";
  if (n < lo) return "number too small to fit in target type";
  return null;
}

/** serde's "expected" list of a unit enum's variants. */
function expectedVariants(variants: readonly string[]): string {
  const q = variants.map((v) => `\`${v}\``);
  if (q.length === 0) return "there are no variants";
  if (q.length === 1) return q[0]!;
  if (q.length === 2) return `${q[0]} or ${q[1]}`;
  return `one of ${q.join(", ")}`;
}

/**
 * The fields of `q` as the struct `fields` declares them: strings as given, integers as strings of digits
 * (exact past 2^53), booleans, variant names. Throws `QueryArgsError`.
 */
export function queryArgs(q: URLSearchParams, fields: QueryField[]): Record<string, string | boolean | undefined> {
  const out: Record<string, string | boolean | undefined> = {};
  const seen = new Set<string>();
  for (const [key, v] of q) {
    const field = fields.find(([name]) => name === key);
    if (!field) continue;
    if (seen.has(key)) throw new QueryArgsError(`duplicate field \`${key}\``);
    seen.add(key);
    const kind = field[1];
    if (kind === "string") out[key] = v;
    else if (kind === "bool") {
      if (v !== "true" && v !== "false")
        throw new QueryArgsError(`${key}: provided string was not \`true\` or \`false\``);
      out[key] = v === "true";
    } else if ("int" in kind) {
      const e = intError(v, kind.int);
      if (e !== null) throw new QueryArgsError(`${key}: ${e}`);
      out[key] = v.startsWith("+") ? v.slice(1) : v;
    } else {
      if (!kind.variants.includes(v))
        throw new QueryArgsError(`${key}: unknown variant \`${v}\`, expected ${expectedVariants(kind.variants)}`);
      out[key] = v;
    }
  }
  for (const [name, , optional] of fields)
    if (!seen.has(name) && !optional) throw new QueryArgsError(`missing field \`${name}\``);
  return out;
}

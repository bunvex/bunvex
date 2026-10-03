// The commit timestamp placeholder (STUDY-53), as Convex's `CommitTsPlaceholder` (convex/values value.ts):
// what a mutation writes with `db.vars.commitTs`, resolved when the mutation commits to the commit
// timestamp — an int64 of nanoseconds, increasing in commit order. Before that it cannot be used as a
// number; validators and indexes see it as the largest int64, after every real timestamp.

const UNRESOLVED =
  "This commit timestamp is unresolved: its value is assigned when the mutation commits. Read the document after the mutation completes to get its value.";

/** The largest int64: the placeholder's value until the commit (Convex's `MAX_COMMIT_TS`). */
export const MAX_COMMIT_TS = (1n << 63n) - 1n;

export class CommitTsPlaceholder {
  // A nominal brand: structurally like no other value.
  readonly #brand = true;
  get [Symbol.toStringTag]() {
    return "CommitTsPlaceholder";
  }
  [Symbol.toPrimitive](hint: string) {
    if (hint === "string") return this.toString();
    throw new Error(UNRESOLVED);
  }
  valueOf(): never {
    throw new Error(UNRESOLVED);
  }
  toJSON(): never {
    throw new Error(UNRESOLVED);
  }
  toString() {
    return "[unresolved commit timestamp]";
  }
  /** @internal */
  static isBranded(x: unknown) {
    return x instanceof CommitTsPlaceholder && #brand in x;
  }
}

/** The one placeholder: read back within the mutation, it is `===` to `db.vars.commitTs`. */
export const commitTsPlaceholder = new CommitTsPlaceholder();

export const isCommitTsPlaceholder = (x: unknown): x is CommitTsPlaceholder => x instanceof CommitTsPlaceholder;

/** `x` with every placeholder in it replaced by `by` (a resolved timestamp), copied only where needed. */
export function resolveCommitTs<T>(x: T, by: bigint): T {
  if (x instanceof CommitTsPlaceholder) return by as T;
  if (Array.isArray(x)) {
    let changed = false;
    const out = x.map((e) => {
      const r = resolveCommitTs(e, by);
      if (r !== e) changed = true;
      return r;
    });
    return (changed ? out : x) as T;
  }
  if (
    x !== null &&
    typeof x === "object" &&
    !(x instanceof ArrayBuffer) &&
    Object.getPrototypeOf(x) === Object.prototype
  ) {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(x)) {
      const r = resolveCommitTs(v, by);
      if (r !== v) {
        out ??= { ...(x as Record<string, unknown>) };
        out[k] = r;
      }
    }
    return (out ?? x) as T;
  }
  return x;
}

/** A value's JSON (the `$integer` form) with each `{"$commitTs":null}` token replaced by `ns`. */
export function resolveCommitTsJson(json: string, ns: bigint): string {
  if (!json.includes('"$commitTs"')) return json;
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, ns, true);
  const integer = JSON.stringify({ $integer: btoa(String.fromCharCode(...buf)) });
  return json.replaceAll('{"$commitTs":null}', integer);
}

/** Whether `x` holds a placeholder anywhere. */
export function hasCommitTs(x: unknown): boolean {
  if (x instanceof CommitTsPlaceholder) return true;
  if (Array.isArray(x)) return x.some(hasCommitTs);
  if (
    x !== null &&
    typeof x === "object" &&
    !(x instanceof ArrayBuffer) &&
    Object.getPrototypeOf(x) === Object.prototype
  )
    return Object.values(x).some(hasCommitTs);
  return false;
}

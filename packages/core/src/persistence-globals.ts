// The persistence globals' values as Convex encodes them (STUDY-134): a timestamp is an int64 of nanoseconds,
// written as a value (`{"$integer": …}`, crates/database/src/retention.rs `write_persistence_global`) for the
// retention globals, or as a `JsonInteger` string (base64 of the little-endian bytes,
// crates/database/src/table_summary.rs) inside `table_summary_v2`. bunvex's commit timestamps are the same
// nanoseconds (STUDY-133 §5.3).
import { fromJsonValue, toJsonValue } from "@bunvex/values";

/** Convex's `JsonInteger::encode`: base64 of an int64's 8 little-endian bytes. */
export function jsonInteger(n: bigint): string {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return Buffer.from(b).toString("base64");
}

/** `jsonInteger`'s inverse; throws on anything else. */
export function fromJsonInteger(s: unknown): bigint {
  if (typeof s !== "string") throw new Error("not a JSON integer");
  const b = Buffer.from(s, "base64");
  if (b.length !== 8 || b.toString("base64") !== s) throw new Error("not a JSON integer");
  return new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true);
}

/** A retention global's value: the ts as Convex writes it, `{"$integer": …}` of nanoseconds. */
export const tsGlobal = (ts: bigint): unknown => toJsonValue(ts);

/** A retention global read back: its ts, 0n when absent or not one. */
export function readTsGlobal(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  try {
    const n = fromJsonValue(v as never);
    return typeof n === "bigint" && n >= 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

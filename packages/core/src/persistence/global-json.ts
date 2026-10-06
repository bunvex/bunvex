// A persistence global's JSON text (PERSIST-01 C14), as Convex writes it: serde_json, where an integer is a
// plain JSON number whatever its size. `max_repeatable_ts` is one, an int64 of nanoseconds above 2^53
// (crates/common/src/persistence/mod.rs, `Timestamp`'s `From<Timestamp> for JsonValue`), so a global's
// integers above 2^53 travel as `bigint`: written as the exact digits, read back from their source text.

// ES2025's `JSON.rawJSON` (in Bun), not yet in TypeScript's lib.
const rawJson = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

/** A global's value as the JSON text drivers store: a `bigint` is written as its digits. */
export function encodeGlobal(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? rawJson(v.toString()) : v));
}

/** `encodeGlobal`'s inverse: an integer that a `number` cannot hold exactly comes back as a `bigint`. */
export function decodeGlobal(text: string): unknown {
  return JSON.parse(text, (_k, v, ctx?: { source?: string }) =>
    typeof v === "number" && !Number.isSafeInteger(v) && ctx?.source !== undefined && /^-?\d+$/.test(ctx.source)
      ? BigInt(ctx.source)
      : v,
  );
}

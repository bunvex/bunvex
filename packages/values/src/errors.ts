// The application error: a function throws `new BunvexError(data)` to send structured data to the client,
// as Convex's `ConvexError` does (npm-packages/convex/src/values/errors.ts). `data` is any value; it
// crosses the wire as `errorData` (never redacted, unlike every other error's message), and the client
// rebuilds a `BunvexError` with the same `data`.
import { stringifyValueForError, type Value } from "./value.ts";

/**
 * Marks a BunvexError without `instanceof`, so an error thrown by one copy of this package is recognised by
 * another (Convex tags its class with a registered symbol for the same reason).
 */
const IDENTIFYING_FIELD = Symbol.for("BunvexError");

export class BunvexError<TData extends Value> extends Error {
  override name = "BunvexError";
  data: TData;
  [IDENTIFYING_FIELD] = true;

  constructor(data: TData) {
    super(typeof data === "string" ? data : stringifyValueForError(data));
    this.data = data;
  }
}

/** True for a `BunvexError` from any copy of this package. */
export function isBunvexError(e: unknown): e is BunvexError<Value> {
  return typeof e === "object" && e !== null && IDENTIFYING_FIELD in e;
}

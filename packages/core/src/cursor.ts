// Pagination cursors (STUDY-17). Convex's cursor is a position — after an index key, or the end — plus a
// fingerprint of the query, encrypted with the instance's secret (crates/common/src/query.rs `Cursor`,
// crates/keybroker). bunvex's is the same content, base64url-encoded and signed with HMAC-SHA256 under the
// instance secret: opaque to clients, and a cursor of another query or instance is refused.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BunvexError } from "@bunvex/values";

export type CursorPosition = { after: Uint8Array } | "end";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

/** A query's fingerprint: what it reads (table, index, range) and in which order. */
export function queryFingerprint(parts: {
  tablet: number;
  index: number;
  lo: Uint8Array;
  hi: Uint8Array;
  desc: boolean;
}) {
  return createHash("sha256")
    .update(`${parts.tablet}:${parts.index}:${b64(parts.lo)}:${b64(parts.hi)}:${parts.desc ? "desc" : "asc"}`)
    .digest("base64url")
    .slice(0, 22);
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest().subarray(0, 16);

export function encodeCursor(secret: string, pos: CursorPosition, fingerprint: string): string {
  const body = `${pos === "end" ? "e" : `a${b64(pos.after)}`}.${fingerprint}`;
  return `${Buffer.from(body).toString("base64url")}.${b64(sign(secret, body))}`;
}

const parseError = () => new Error("InvalidCursor: Failed to parse cursor");

/**
 * A cursor of another query (the data under a paginated query changed its shape): an app error with data, as
 * Convex's `invalid_cursor()` (crates/database/src/query/mod.rs), so a function may catch it and a client
 * recognizes it and restarts the pagination. Convex's key `isConvexSystemError` is `isBunvexSystemError` here
 * (STUDY-26 P1). A cursor that does not parse stays a plain error, as Convex's keybroker's.
 */
export const INVALID_CURSOR_DATA = { isBunvexSystemError: true, paginationError: "InvalidCursor" } as const;
function differentQueryError() {
  const e = new BunvexError<{ isBunvexSystemError: boolean; paginationError: string }>({ ...INVALID_CURSOR_DATA });
  e.message =
    "InvalidCursor: Tried to run a query starting from a cursor, but it looks like this cursor is from a different query.";
  return e;
}

export function decodeCursor(secret: string, cursor: string, fingerprint: string): CursorPosition {
  const [bodyB64, sigB64, ...rest] = cursor.split(".");
  if (!bodyB64 || !sigB64 || rest.length) throw parseError();
  const body = Buffer.from(bodyB64, "base64url").toString();
  const sig = unb64(sigB64);
  const want = sign(secret, body);
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) throw parseError();
  const [pos, fp] = body.split(".");
  if (fp !== fingerprint) throw differentQueryError();
  if (pos === "e") return "end";
  if (!pos?.startsWith("a")) throw parseError();
  return { after: unb64(pos.slice(1)) };
}

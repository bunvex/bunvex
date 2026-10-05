// How a sync connection ends when it fails (STUDY-104), as Convex's `ErrorMetadata::close_frame` and
// `is_deterministic_user_error` (crates/errors/src/lib.rs) and the end of `run_sync_socket`
// (crates/local_backend/src/subs/mod.rs):
//
// - a client error the client must not retry (`BadRequest`, `Conflict`, `PaginationLimit`, `Forbidden`) is
//   reported in a `FatalError` first; `Unauthenticated` and `AuthUpdateFailed` get an `AuthError` instead;
// - then the close frame: 1000 with the error's short code for `NotFound`, `PaginationLimit`, `Forbidden` and
//   `ClientDisconnect`; 1013 ("try again later") for OCC, overload and rate limits; 1011 for an internal error;
//   none at all for the client errors, which the client ends itself.

/** Convex's `ErrorCode`: what kind of failure ended the connection. */
export type ErrorCode =
  | "BadRequest"
  | "Unauthenticated"
  | "AuthUpdateFailed"
  | "Conflict"
  | "NotFound"
  | "PaginationLimit"
  | "Forbidden"
  | "ClientDisconnect"
  | "OCC"
  | "OutOfRetention"
  | "Overloaded"
  | "FeatureTemporarilyUnavailable"
  | "RateLimited"
  | "RejectedBeforeExecution"
  | "MisdirectedRequest"
  | "TooEarly"
  | "OperationalInternalServerError";

/** A failure that ends a connection: its kind, its short code (the close reason) and its message. */
export type SyncFailure = { code: ErrorCode; shortMsg: string; msg: string };

/** Close codes (RFC 6455 §7.4.1). */
export const CLOSE_NORMAL = 1000;
export const CLOSE_INTERNAL_ERROR = 1011;
export const CLOSE_TRY_AGAIN_LATER = 1013;

/** A close frame's reason is at most 123 bytes: its payload is 125, two of them the code. */
const MAX_REASON_BYTES = 123;

/** The close frame a failure ends the connection with, or null for a close frame without a code. */
export function closeFrame(f: Pick<SyncFailure, "code" | "shortMsg">): { code: number; reason: string } | null {
  let code: number;
  switch (f.code) {
    case "NotFound":
    case "PaginationLimit":
    case "Forbidden":
    case "ClientDisconnect":
      code = CLOSE_NORMAL;
      break;
    case "OCC":
    case "OutOfRetention":
    case "Overloaded":
    case "FeatureTemporarilyUnavailable":
    case "RateLimited":
    case "RejectedBeforeExecution":
    case "MisdirectedRequest":
    case "TooEarly":
      code = CLOSE_TRY_AGAIN_LATER;
      break;
    case "OperationalInternalServerError":
      code = CLOSE_INTERNAL_ERROR;
      break;
    case "BadRequest":
    case "Unauthenticated":
    case "AuthUpdateFailed":
    case "Conflict":
      return null;
  }
  return { code, reason: truncateUtf8(f.shortMsg, MAX_REASON_BYTES) };
}

/** A client error, which the client does not retry: it is told in a `FatalError` before the close. */
export function isDeterministicUserError(code: ErrorCode): boolean {
  switch (code) {
    case "BadRequest":
    case "Conflict":
    case "PaginationLimit":
    case "Unauthenticated":
    case "AuthUpdateFailed":
    case "Forbidden":
      return true;
    case "OperationalInternalServerError":
    case "ClientDisconnect":
    case "NotFound":
    case "RateLimited":
    case "OCC":
    case "OutOfRetention":
    case "Overloaded":
    case "FeatureTemporarilyUnavailable":
    case "RejectedBeforeExecution":
    case "MisdirectedRequest":
    case "TooEarly":
      return false;
  }
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, cut at a character boundary. */
export function truncateUtf8(s: string, max: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= max) return s;
  let end = max;
  // A continuation byte (10xxxxxx) cannot start a character: back up to the start of the one it is in.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

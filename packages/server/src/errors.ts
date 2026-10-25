// How a function's error reaches a client, as Convex words and redacts it (STUDY-20):
//
//   crates/isolate/src/error.rs + helpers.rs   `Uncaught <Name>: <message>` and the stack frames
//   crates/application/src/redaction.rs        `[Request ID: <id>] Server Error`, then the details unless
//                                              the deployment redacts them (`--redact-logs-to-client`)
//   crates/errors/src/lib.rs                   system failures: a fixed message, never the details
//
// A `BunvexError`'s data always goes to the client (`errorData`), redacted or not: it is the app's own
// answer, not an internal detail.
import { randomBytes } from "node:crypto";
import {
  CommitterStoppedError,
  IndexesUnavailableError,
  OutOfRetentionError,
  PersistenceReadError,
  QueryCursorError,
} from "@bunvex/core";
import {
  isBunvexError,
  type JSONValue,
  toJsonValue,
  type Value,
  valueHasLoneSurrogate,
  withoutLoneSurrogates,
} from "@bunvex/values";
import { ActionTimeoutError } from "./action-timeout.ts";
import { mapStack } from "./stack-map.ts";

/** The message a client gets for a failure that is not the function's (Convex's INTERNAL_SERVER_ERROR_MSG). */
export const INTERNAL_SERVER_ERROR_MESSAGE = "Your request couldn't be completed. Try again later.";

/** A request id: 16 hex characters, as Convex's `RequestId::new`. */
export const newRequestId = () => randomBytes(8).toString("hex");

/**
 * A failure of the server rather than of the function: the committer stopped after a persistence error, a
 * store read failed under a function (STUDY-20 D8), or a timestamp fell out of the write log's retention
 * (Convex's `OutOfRetention`, STUDY-06 D10).
 */
/**
 * The function sandbox failed a call that is not the function's fault: its child process died or broke the protocol
 * (STUDY-171 §8.6). A system error, as Convex's internal error for a terminated isolate: the client gets the
 * internal-error message, and a function cannot catch it.
 */
export class ExecutorFailure extends Error {
  override name = "ExecutorFailure";
}

export const isSystemError = (e: unknown) =>
  e instanceof ExecutorFailure ||
  e instanceof CommitterStoppedError ||
  e instanceof OutOfRetentionError ||
  e instanceof PersistenceReadError ||
  e instanceof QueryCursorError ||
  e instanceof IndexesUnavailableError;

/**
 * A system failure the client should simply retry: Convex's `ErrorCode::OutOfRetention` answers HTTP 503 and
 * closes a WebSocket with 1013 ("try again later"), where other internal errors are 500 / 1011
 * (crates/errors/src/lib.rs `http_status_code`, `close_frame`).
 */
export const isTryAgainError = (e: unknown) => e instanceof OutOfRetentionError || e instanceof IndexesUnavailableError;

/** The error as the function's runtime reports it, before redaction: message line, then frames. */
export type UncaughtError = { message: string; data?: JSONValue };

/**
 * `Uncaught <Name>: <message>` followed by the stack frames, one per line, ending with a newline — the shape
 * of Convex's `JsError` display. A `BunvexError` also carries its data as JSON; a `BunvexError` whose data
 * is not a value becomes an error about that instead, with no data (Convex does the same).
 */
/**
 * An error the runtime reports with its message alone (no `Uncaught`, no frames), as Convex's
 * `JsError::from_message`: a function that does not exist, or of another kind.
 */
/** An Error from this realm or another (a function's code runs in its own context, STUDY-35). */
export const isError = (e: unknown): e is Error =>
  e instanceof Error || Object.prototype.toString.call(e) === "[object Error]";

export class FunctionPathError extends Error {
  override name = "FunctionPathError";
}

/**
 * A path that names no function, or one of another kind ("Could not find public function", "Trying to execute …").
 * To a client, its message alone, as any `FunctionPathError`. To a function whose nested call it fails, Convex's
 * syscall error: a plain `Error` made in the caller's code, with the caller's frames (STUDY-188 §X21).
 */
export class FunctionLookupError extends FunctionPathError {}

/**
 * A query's or mutation's promise that can never resolve (`Tx.watch`): Convex's `JsError::from_message`, its message
 * alone (`environment/udf/mod.rs`, STUDY-188 §X16).
 */
export const neverResolves = () => new FunctionPathError("Returned promise will never resolve");

/**
 * A call's arguments that do not decode into values, held for the run: Convex resolves the function first, then
 * `parse_udf_args` fails it (`ValidatedPathAndArgs`, crates/udf/src/validation.rs), so the call is a failed run
 * of the function in the function log, and a missing function is "Could not find public function" whatever came.
 */
export class UndecodedArgs {
  constructor(readonly error: FunctionPathError) {}
}

/** `decode()`'s value, or its "Invalid arguments" error held as `UndecodedArgs` for the run to throw. */
export function decodeCallArgs(decode: () => unknown): unknown {
  try {
    return decode();
  } catch (e) {
    if (e instanceof FunctionPathError) return new UndecodedArgs(e);
    throw e;
  }
}

/**
 * A function path that names no public function, or one of another kind, with `UDF_404_ON_BAD_PATH` on
 * (STUDY-147 §3.8): Convex's `ErrorMetadata::not_found` instead of the function's error, so the request fails
 * (HTTP 404 `{code, message}`, a whole batch with it; a sync session closes with the code).
 */
export class FunctionPathNotFoundError extends Error {
  override name = "FunctionPathNotFoundError";
  constructor(
    readonly code: "FunctionPathNotFound" | "FunctionPathWrongType",
    message: string,
  ) {
    super(message);
  }
}

/**
 * An argument or result that misses its validator: Convex checks both in Rust, around the run
 * (`ArgsValidator::check_args`, `ReturnsValidator::check_output`), so the error is a message alone — no
 * `Uncaught`, no frames — and its message is the `JsError`'s display, newline included, for the client and
 * for a function that called this one alike. `ArgumentValidationError: <check>` wraps the check's own
 * `JsError`, so it ends with two newlines (STUDY-67 H6).
 */
export class ValidatorError extends Error {
  static args = (check: string) => new ValidatorError(`ArgumentValidationError: ${check}\n\n`);
  static returns = (check: string) => new ValidatorError(`ReturnsValidationError: ${check}\n`);
}

export function describeUncaught(e: unknown): UncaughtError {
  if (e instanceof FunctionPathError || e instanceof ActionTimeoutError) return { message: `${e.message}\n` };
  // a `_system/` function refused (admin-keys.ts `SystemIdentityRequiredError`): Convex's runner reports its
  // `ErrorMetadata` message alone, raised in Rust before any code runs
  if (isError(e) && (e as { code?: unknown }).code === "SystemIdentityRequired") return { message: `${e.message}\n` };
  if (e instanceof ValidatorError) return { message: e.message };
  if (!isError(e)) {
    const what = typeof e === "object" && e !== null ? "#<Object>" : String(e);
    return { message: withoutLoneSurrogates(`Uncaught ${what}\n`) };
  }
  // The app's frames only, mapped to its sources (STUDY-95), from the stack after the message (a message may
  // hold a nested function's frames, which are part of the message).
  const frames = mapStack(stackAfterMessage(e))
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .map((l) => `${l.replace(/^\s+/, "    ")}\n`)
    .join("");
  let head = uncaughtLine(e.name, e.message);
  let data: JSONValue | undefined;
  // Data holding a lone surrogate does not reach Convex's Rust (STUDY-135): with object data its error has none
  // (Q2), and with string data bunvex does the same where Convex fails as a system error (Q1, DV-431).
  if (isBunvexError(e) && !valueHasLoneSurrogate(e.data)) {
    try {
      data = toJsonValue((e.data === undefined ? null : e.data) as Value);
    } catch (invalid) {
      head = `BunvexError with invalid data: ${(invalid as Error).message}`;
    }
  }
  // Convex reads the message into Rust with a lossy conversion: a lone surrogate becomes U+FFFD (STUDY-135).
  const message = withoutLoneSurrogates(`${head}\n${frames}`);
  return data === undefined ? { message } : { message, data };
}

/**
 * An error's stack without its first lines, `<name>: <message>`, when the stack starts with them — whatever name
 * the error had when its stack was taken, or `Error` for a `"use node"` action's (`app-errors.ts`, as Convex's
 * Node executor names every error).
 */
export function stackAfterMessage(e: Error): string {
  const stack = String(e.stack ?? "");
  if (!e.message) return stack.startsWith(e.name) ? stack.slice(e.name.length) : stack;
  const at = stack.indexOf(`: ${e.message}`);
  return at >= 0 && !stack.slice(0, at).includes("\n") ? stack.slice(at + 2 + e.message.length) : stack;
}

function uncaughtLine(name: string | undefined, message: string | undefined): string {
  // A failed nested call rejects with the callee's display, already `Uncaught <Name>: …`; as Convex's
  // `format_uncaught_error` since b352fab (crates/isolate/src/helpers.rs), each level does not add another.
  if (name && message?.startsWith(`Uncaught ${name}: `)) return message;
  if (name && message) return `Uncaught ${name}: ${message}`;
  if (name) return `Uncaught ${name}`;
  if (message) return `Uncaught ${message}`;
  return "Uncaught";
}

/** A function's error for the client, without the request id: `Server Error`, plus details unless redacted. */
export function clientError(e: unknown, redact: boolean): UncaughtError {
  const u = describeUncaught(e);
  const message = redact ? "Server Error" : `Server Error\n${u.message}`;
  return u.data === undefined ? { message } : { message, data: u.data };
}

/** The same, with the request id Convex puts in front of every function error. */
export const withRequestId = (message: string, requestId = newRequestId()) => `[Request ID: ${requestId}] ${message}`;

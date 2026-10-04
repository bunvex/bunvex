// Approaching-limit warnings (STUDY-76), as Convex's `add_warnings_to_log_lines` (crates/udf/src/warnings.rs,
// crates/isolate/src/environment/udf/mod.rs, environment/action/mod.rs): when a function ends past
// FUNCTION_LIMIT_WARNING_RATIO (80 %) of a limit without crossing it, a WARN system line is added after its own
// lines — the client prints it, the function log and the log streams carry it (`system_code`
// `warning:<code>`). The messages are Convex's (DV-04: no link to its docs).
import {
  formatDuration,
  MAX_DOCUMENT_NESTING,
  MAX_USER_SIZE,
  OVER_LIMIT_HELP,
  TRANSACTION_MAX_NUM_SCHEDULED,
  TRANSACTION_MAX_NUM_USER_WRITES,
  TRANSACTION_MAX_READ_SET_INTERVALS,
  TRANSACTION_MAX_READ_SIZE_BYTES,
  TRANSACTION_MAX_READ_SIZE_ROWS,
  TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES,
  TRANSACTION_MAX_USER_WRITE_SIZE_BYTES,
  type Tx,
} from "@bunvex/core";
import { logSystemLine } from "./logs.ts";

/** Convex's `MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES`: one scheduled function's arguments (not yet enforced). */
const MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES = 4 << 20;

/** Convex's FUNCTION_LIMIT_WARNING_RATIO knob (0.8). */
const ratio = () => Number(process.env.FUNCTION_LIMIT_WARNING_RATIO ?? 0.8);

const warn = (code: string, message: string) => logSystemLine("WARN", message, `warning:${code}`);

/** Convex's `approaching_limit_warning`: past `ratio × limit` (floored), not past the limit (an error then). */
function approaching(
  actual: number,
  limit: number,
  code: string,
  message: string,
  opts: { unit?: string; suffix?: string } = {},
) {
  if (!(actual > Math.floor(ratio() * limit) && actual <= limit)) return;
  const unit = opts.unit ?? "";
  warn(code, `${message} (actual: ${actual}${unit}, limit: ${limit}${unit}).${opts.suffix ? ` ${opts.suffix}` : ""}`);
}

/** Convex's `approaching_duration_limit_warning`, durations as Rust's `Duration` prints them. */
function approachingDuration(actualMs: number, limitMs: number) {
  if (!(actualMs > limitMs * ratio() && actualMs <= limitMs)) return;
  warn(
    "UserTimeout",
    `Function execution took a long time. (maximum duration: ${formatDuration(limitMs)}, actual duration: ${formatDuration(actualMs)}).`,
  );
}

/**
 * A query's or mutation's warnings, in Convex's order, when it ended (a value or the app's error; a system
 * failure has none). `result`: its value's size when it returned one.
 */
export function functionWarnings(o: {
  argsBytes: number;
  maxArgsBytes: number;
  tx: Tx;
  resultBytes: number | null;
  maxResultBytes: number;
  userMs: number;
  userLimitMs: number;
}) {
  const used = o.tx.usage;
  approaching(o.argsBytes, o.maxArgsBytes, "TooLargeFunctionArguments", "Large size of the function arguments", {
    unit: " bytes",
  });
  approaching(
    used.documentsRead,
    TRANSACTION_MAX_READ_SIZE_ROWS,
    "TooManyDocumentsRead",
    "Many documents read in a single function execution",
    { suffix: OVER_LIMIT_HELP },
  );
  approaching(
    used.databaseQueries,
    TRANSACTION_MAX_READ_SET_INTERVALS,
    "TooManyReads",
    "Many reads in a single function execution",
    { suffix: OVER_LIMIT_HELP },
  );
  approaching(
    used.bytesRead,
    TRANSACTION_MAX_READ_SIZE_BYTES,
    "TooManyBytesRead",
    "Many bytes read in a single function execution",
    { unit: " bytes", suffix: OVER_LIMIT_HELP },
  );
  approaching(
    used.documentsWritten,
    TRANSACTION_MAX_NUM_USER_WRITES,
    "TooManyWrites",
    "Many writes in a single function execution",
  );
  approaching(
    used.bytesWritten,
    TRANSACTION_MAX_USER_WRITE_SIZE_BYTES,
    "TooManyBytesWritten",
    "Many bytes written in a single function execution",
    { unit: " bytes" },
  );
  approaching(
    used.functionsScheduled,
    TRANSACTION_MAX_NUM_SCHEDULED,
    "TooManyFunctionsScheduled",
    "Many functions scheduled by this mutation",
  );
  approaching(
    used.scheduledFunctionArgsBytes,
    TRANSACTION_MAX_SCHEDULED_TOTAL_ARGUMENT_SIZE_BYTES,
    "ScheduledFunctionsArgumentsTooLarge",
    "Large total size of the arguments of scheduled functions from this mutation",
    { unit: " bytes" },
  );
  // Convex's `scheduled_arg_size_warning`: no upper bound, as the limit is not enforced yet.
  const maxScheduled = o.tx.scheduledMaxBytes;
  if (maxScheduled > Math.floor(ratio() * MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES)) {
    const over = maxScheduled > MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES;
    warn(
      "ScheduledFunctionsArgumentsTooLarge",
      `Large arguments for a single scheduled function from this mutation${over ? ". This will become a hard error in the future" : ""} (actual: ${maxScheduled} bytes, limit: ${MAX_SCHEDULED_JOB_ARGUMENT_SIZE_BYTES} bytes).`,
    );
  }
  const biggest = o.tx.biggestWrites();
  if (biggest) {
    const [sizeId, size] = biggest.maxSize;
    approaching(size, MAX_USER_SIZE, "ValueTooLargeError", `Large document written with ID "${sizeId}"`, {
      unit: " bytes",
    });
    const [nestingId, nesting] = biggest.maxNesting;
    approaching(nesting, MAX_DOCUMENT_NESTING, "TooNested", `Deeply nested document written with ID "${nestingId}"`, {
      unit: " levels",
    });
  }
  if (o.resultBytes !== null)
    approaching(o.resultBytes, o.maxResultBytes, "TooLargeFunctionResult", "Large size of the function return value", {
      unit: " bytes",
    });
  approachingDuration(o.userMs, o.userLimitMs);
}

/** Convex's `V8_ACTION_USER_TIMEOUT`: what an action's duration warning measures against (1800 s). */
export const V8_ACTION_USER_TIMEOUT_MS = 1800 * 1000;

/**
 * Convex's dangling-operation warning: the action's operations still pending when it returned, by name
 * (`name_when_dangling`), sorted (STUDY-76; DV-04: no link to its docs).
 */
export function unawaitedWarning(pending: Map<string, number>) {
  const total = [...pending.values()].reduce((n, c) => n + c, 0);
  if (total === 0) return;
  const names = [...pending.entries()]
    .filter(([, c]) => c > 0)
    .map(([n]) => n)
    .sort()
    .join(", ");
  logSystemLine(
    "WARN",
    `${total} unawaited operation${total === 1 ? "" : "s"}: [${names}]. Async operations should be awaited or they might not run.`,
    "UnawaitedOperations",
  );
}

/** An action's warnings, in Convex's order: its arguments, its pending operations, its duration, its result. */
export function actionWarnings(o: {
  argsBytes: number;
  maxArgsBytes: number;
  pending: Map<string, number>;
  elapsedMs: number;
  resultBytes: number | null;
  maxResultBytes: number;
}) {
  approaching(o.argsBytes, o.maxArgsBytes, "FunctionArgumentsTooLarge", "Large size of the action arguments", {
    unit: " bytes",
  });
  unawaitedWarning(o.pending);
  approachingDuration(o.elapsedMs, V8_ACTION_USER_TIMEOUT_MS);
  if (o.resultBytes !== null)
    approaching(o.resultBytes, o.maxResultBytes, "TooLargeFunctionResult", "Large size of the action return value", {
      unit: " bytes",
    });
}

/**
 * An HTTP action's warnings once its response is sent (or its handler failed): the response's size, its
 * pending operations, its duration.
 */
export function httpActionWarnings(o: {
  sentBytes: number;
  limitBytes: number;
  pending: Map<string, number>;
  elapsedMs: number;
}) {
  approaching(o.sentBytes, o.limitBytes, "HttpResponseTooLarge", "Large response returned from an HTTP action", {
    unit: " bytes",
  });
  unawaitedWarning(o.pending);
  approachingDuration(o.elapsedMs, V8_ACTION_USER_TIMEOUT_MS);
}

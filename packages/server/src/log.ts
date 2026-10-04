// `log.audit(body)` and `log.vars` (STUDY-82), as Convex's `log` export (npm-packages/convex/src/server/log.ts,
// audit_logging.ts, logVars.ts; crates/common/src/audit_log_lines.rs):
//
// - `log.audit` deep-copies the body, refusing keys that start with "$" and replacing each `log.vars` symbol
//   with a sentinel `{ $var: name }`; in a query or mutation it adds the line to the running function's (a
//   nested call's lines join its caller's), in an action it fails ("not yet supported in actions");
// - when the top-level query or mutation ends (each attempt of a mutation), its lines are resolved: each
//   sentinel becomes the request's value (`requestId`, `ip`, `userAgent`, `now` in ms, and the admin actor,
//   always null on a self-hosted deployment), within Convex's limits (500 lines, 100 KB a line counting each
//   variable at its maximum, 4 MB in all), and sent to the log streams as `custom_audit` events;
// - `custom_audit` needs an entitlement no self-hosted deployment has (DV-304), so no sink receives them: what
//   an app observes is the API and its checks.
//
// This module holds what `bunvex/server` exports, with nothing of the runtime (its isomorphic entry, STUDY-91):
// the running function's lines come from log-audit.ts, which sets `setAuditScope`.

const REQUEST_ID = Symbol("var.requestId");
const IP = Symbol("var.ip");
const USER_AGENT = Symbol("var.userAgent");
const NOW = Symbol("var.now");
const ACTOR = Symbol("var.bunvexActor");

export type LogVar = typeof REQUEST_ID | typeof IP | typeof USER_AGENT | typeof NOW | typeof ACTOR;

const VAR_NAMES = new Map<symbol, string>([
  [REQUEST_ID, "requestId"],
  [IP, "ip"],
  [USER_AGENT, "userAgent"],
  [NOW, "now"],
  [ACTOR, "bunvexActor"],
]);

/** Values resolved when the function's audit log lines are emitted (Convex's `log.vars`). */
export const vars = {
  /** Resolved to the request ID. */
  requestId: REQUEST_ID,
  /** Resolved to the client's IP address. */
  ip: IP,
  /** Resolved to the client's User-Agent header. */
  userAgent: USER_AGENT,
  /** Resolved to the current server timestamp, as milliseconds from the Unix epoch. */
  now: NOW,
  /**
   * The admin who invoked the function (Convex's `convexActor`; bunvex's name, DV-03): null on a self-hosted
   * deployment, whose admin keys belong to no member.
   */
  bunvexActor: ACTOR,
} as const;

export type AuditLogValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | LogVar
  | AuditLogValue[]
  | { [key: string]: AuditLogValue };
export type AuditLogBody = { [key: string]: AuditLogValue };
type JsonValue = null | undefined | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Convex's knobs: AUDIT_LOG_MAX_LINES, _MAX_LINE_SIZE_BYTES, _MAX_TOTAL_SIZE_BYTES, _MAX_HEAP_SIZE_BYTES. */
const knob = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const auditLogLimits = () => ({
  maxLines: knob("AUDIT_LOG_MAX_LINES", 500),
  maxLineBytes: knob("AUDIT_LOG_MAX_LINE_SIZE_BYTES", 100_000),
  maxTotalBytes: knob("AUDIT_LOG_MAX_TOTAL_SIZE_BYTES", 4_000_000),
  maxHeapBytes: knob("AUDIT_LOG_MAX_HEAP_SIZE_BYTES", 4_000_000),
});
/** Convex's `AuditLogVars::MAX_VAR_LENGTH`: what each variable may add to a line, at most. */
export const MAX_VAR_LENGTH = 1026;

function validateKey(key: string) {
  if (key.startsWith("$")) throw new Error(`Audit log body keys must not start with "$": "${key}"`);
}

function cloneValue(value: AuditLogValue): JsonValue {
  if (typeof value === "symbol") {
    const name = VAR_NAMES.get(value);
    if (name === undefined) throw new Error(`Unknown audit var symbol: ${String(value)}.`);
    return { $var: name };
  }
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const out: { [key: string]: JsonValue } = {};
  for (const [key, v] of Object.entries(value)) {
    validateKey(key);
    out[key] = cloneValue(v);
  }
  return out;
}

/** Convex's `cloneWithSentinels`: the body as JSON, each `log.vars` symbol as `{ $var: name }`. */
export function cloneWithSentinels(body: AuditLogBody): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, v] of Object.entries(body)) {
    validateKey(key);
    out[key] = cloneValue(v);
  }
  return out;
}

/** A query's or mutation's audit log lines so far, as JSON text (and their total, Convex's heap check). */
export type AuditLines = { lines: string[]; bytes: number };

/** The running function's lines: null in an action, undefined outside any function (set by log-audit.ts). */
let auditScope: () => AuditLines | null | undefined = () => undefined;
export function setAuditScope(s: typeof auditScope) {
  auditScope = s;
}

/** `log.audit` (Convex's `audit` and its `1.0/auditLog` syscall). */
export async function audit(body: AuditLogBody): Promise<void> {
  const json = JSON.stringify(cloneWithSentinels(body));
  const scope = auditScope();
  if (!scope) throw new Error("Audit logging is not yet supported in actions");
  // Convex's `emit_audit_log_line`: the lines a function holds are bounded as it adds them.
  if (scope.bytes + json.length > auditLogLimits().maxHeapBytes)
    throw new Error("Audit logs exceed function execution limits");
  scope.lines.push(json);
  scope.bytes += json.length;
}

/** A function's audit log lines over Convex's limits, once they are resolved: a bad request (HTTP 400). */
export class AuditLogLimitError extends Error {
  constructor(
    readonly code: "TooManyAuditLogLines" | "AuditLogLineTooLarge" | "AuditLogLinesTooLarge" | "UnknownAuditLogVar",
    message: string,
  ) {
    super(message);
    this.name = "AuditLogLimitError";
  }
}

/** Convex's `log` export: `log.audit(body)` and `log.vars`. */
export const log: { audit: typeof audit; vars: typeof vars } = { audit, vars };

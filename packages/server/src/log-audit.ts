// The runtime side of `log.audit` (STUDY-82, see log.ts): each top-level query's or mutation's lines, and their
// resolution with the request's variables within Convex's limits when the function ends.
import { AsyncLocalStorage } from "node:async_hooks";
import { type AuditLines, AuditLogLimitError, auditLogLimits, MAX_VAR_LENGTH, setAuditScope } from "./log.ts";

type Lines = AuditLines;
const scopes = new AsyncLocalStorage<Lines | null>();
setAuditScope(() => scopes.getStore());

/** Run a top-level query's or mutation's body collecting its audit log lines; nested calls share them. */
export function collectingAuditLines<T>(fn: () => T): { lines: Lines; result: T } {
  const lines: Lines = { lines: [], bytes: 0 };
  return { lines, result: scopes.run(lines, fn) };
}

/** Run an action's body: `log.audit` is refused there. */
export function withoutAuditLines<T>(fn: () => T): T {
  return scopes.run(null, fn);
}

export type AuditLogVars = {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  now: number;
  bunvexActor: null;
};

/** Replace each sentinel in `value` with its variable; how many there were. */
function resolve(value: unknown, v: AuditLogVars): { value: unknown; count: number } {
  if (value === null || typeof value !== "object") return { value, count: 0 };
  if (Array.isArray(value)) {
    let count = 0;
    const out = value.map((x) => {
      const r = resolve(x, v);
      count += r.count;
      return r.value;
    });
    return { value: out, count };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1 && entries[0]![0] === "$var" && typeof entries[0]![1] === "string") {
    const name = entries[0]![1];
    if (!(name in v)) throw new AuditLogLimitError("UnknownAuditLogVar", `Unknown audit log variable: "${name}"`);
    return { value: v[name as keyof AuditLogVars], count: 1 };
  }
  let count = 0;
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries) {
    const r = resolve(x, v);
    count += r.count;
    out[k] = r.value;
  }
  return { value: out, count };
}

/**
 * Convex's `resolve_bodies`: the lines with their variables, within the limits (a line's maximum size counts
 * each variable at its longest, so whether it fits does not depend on the request).
 */
export function resolveAuditLines(lines: Lines, v: AuditLogVars): unknown[] {
  const { maxLines, maxLineBytes, maxTotalBytes } = auditLogLimits();
  if (lines.lines.length > maxLines)
    throw new AuditLogLimitError(
      "TooManyAuditLogLines",
      `Function execution exceeded the maximum of ${maxLines} audit log lines.`,
    );
  let total = 0;
  const out = lines.lines.map((json) => {
    const r = resolve(JSON.parse(json), v);
    const max = json.length + r.count * MAX_VAR_LENGTH;
    if (max > maxLineBytes)
      throw new AuditLogLimitError(
        "AuditLogLineTooLarge",
        `An audit log line may have a maximum possible size of ${maxLineBytes} bytes, but this line could be up to ${max} bytes.`,
      );
    total += max;
    return r.value;
  });
  if (total > maxTotalBytes)
    throw new AuditLogLimitError(
      "AuditLogLinesTooLarge",
      `The total maximum possible size of audit log lines from a single function execution is ${maxTotalBytes} bytes, but this execution could produce up to ${total} bytes.`,
    );
  return out;
}

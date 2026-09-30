// Function log lines: what a query, mutation or action writes with `console.*` is captured and returned to
// the caller with its result (`logLines`), as Convex does (crates/common/src/log_lines.rs,
// crates/isolate/src/ops/console.rs, npm-packages/udf-runtime/src/02_console.ts; STUDY-20).
//
// Convex gives each function its own isolate and its own `console`. bunvex shares one process, so the
// console methods are replaced once and each call looks up the current invocation in an
// AsyncLocalStorage; outside an invocation they are the originals. Lines are still printed to the server's
// own console as before: capturing only adds the copy the client gets back.
import { AsyncLocalStorage } from "node:async_hooks";
import { wallClock } from "@bunvex/core";
import inspect from "object-inspect";

/** At most this many lines per invocation; the last one is the overflow notice (Convex's MAX_LOG_LINES). */
export const MAX_LOG_LINES = 256;
/** A line's messages are cut at this many UTF-8 bytes (Convex's MAX_LOG_LINE_LENGTH: 32 KiB). */
export const MAX_LOG_LINE_LENGTH = 32768;
const TRUNCATED_LINE_SUFFIX = " (truncated due to length)";

export type LogLevel = "DEBUG" | "ERROR" | "WARN" | "INFO" | "LOG";

/**
 * The lines of one execution. A mutation re-run after a conflict replaces its previous attempt's lines (an
 * aborted attempt never happened, as far as the caller can tell); a function called from an action nests
 * its execution as an entry of the action's, the way Convex keeps sub-function lines in place.
 */
type Execution = { entries: (string | Execution)[]; timers: Map<string, number> };

const current = new AsyncLocalStorage<Execution>();
const newExecution = (): Execution => ({ entries: [], timers: new Map() });

export type WithLogLines<T> = ({ ok: true; value: T } | { ok: false; error: unknown }) & { logLines: string[] };

/** Run one invocation (an HTTP call, a WebSocket mutation) and collect the lines it logs. */
export async function collectLogs<T>(run: () => Promise<T> | T): Promise<WithLogLines<T>> {
  installLogCapture();
  const execution = newExecution();
  try {
    const value = await current.run(execution, run);
    return { ok: true, value, logLines: logLinesOf(execution) };
  } catch (error) {
    return { ok: false, error, logLines: logLinesOf(execution) };
  }
}

/**
 * Wrap a transaction body the engine may run more than once (a mutation retried after a conflict): each
 * run's lines replace the previous run's, so the caller sees the lines of the attempt that committed.
 */
export function perAttempt<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R {
  let attempt: Execution | undefined;
  return (...args) => {
    const parent = current.getStore();
    if (!parent) return body(...args);
    if (attempt) {
      attempt.entries = [];
      attempt.timers.clear();
    } else {
      attempt = newExecution();
      parent.entries.push(attempt);
    }
    return current.run(attempt, () => body(...args));
  };
}

/**
 * Run `fn` outside any invocation: its lines go only to the server's console. For work that is not the
 * caller's even though it starts inside the caller's call, such as re-running subscriptions after a commit.
 */
export function withoutLogs<T>(fn: () => T): T {
  return current.exit(fn);
}

function logLinesOf(execution: Execution): string[] {
  const lines: string[] = [];
  const walk = (e: Execution) => {
    for (const entry of e.entries) {
      if (typeof entry === "string") lines.push(entry);
      else walk(entry);
    }
  };
  walk(execution);
  if (lines.length < MAX_LOG_LINES) return lines;
  // Convex keeps MAX_LOG_LINES - 1 lines and spends the last on an [ERROR] notice.
  lines.length = MAX_LOG_LINES - 1;
  lines.push(`[ERROR] Log overflow (maximum ${MAX_LOG_LINES}). Remaining log lines omitted.`);
  return lines;
}

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** The longest prefix of `s` that fits in `bytes` UTF-8 bytes, cut on a character boundary. */
function cutToBytes(s: string, bytes: number): string {
  let used = 0;
  let end = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > bytes) break;
    used += n;
    end += ch.length;
  }
  return s.slice(0, end);
}

/** One line as the client sees it: `[LEVEL] msg1 msg2…`, cut at MAX_LOG_LINE_LENGTH bytes. */
export function formatLogLine(level: LogLevel, messages: string[]): string {
  const total = messages.reduce((n, m) => n + byteLength(m) + 1, 0) - 1;
  if (total <= MAX_LOG_LINE_LENGTH) return `[${level}] ${messages.join(" ")}`;
  const kept: string[] = [];
  let used = 0;
  for (const m of messages) {
    const room = Math.max(0, MAX_LOG_LINE_LENGTH - used);
    const n = byteLength(m);
    if (n <= room) {
      kept.push(m);
      used += n + 1;
    } else {
      kept.push(cutToBytes(m, room));
      break;
    }
  }
  return `[${level}] ${kept.join(" ")}${TRUNCATED_LINE_SUFFIX}`;
}

/** Each console argument as Convex renders it (object-inspect, strings quoted, nested objects indented). */
const render = (args: unknown[]) =>
  args.map((a) => inspect(a, { maxStringLength: MAX_LOG_LINE_LENGTH, indent: 2, customInspect: true }));

function emit(execution: Execution, level: LogLevel, messages: string[]) {
  execution.entries.push(formatLogLine(level, messages));
}

let installed = false;
/** Replace the console methods (idempotent). `collectLogs` calls it. */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  const c = console as unknown as Record<string, (...args: unknown[]) => void>;
  const levels: [string, LogLevel][] = [
    ["debug", "DEBUG"],
    ["error", "ERROR"],
    ["info", "INFO"],
    ["log", "LOG"],
    ["warn", "WARN"],
  ];
  for (const [method, level] of levels) {
    const original = c[method].bind(console);
    c[method] = (...args: unknown[]) => {
      const e = current.getStore();
      if (e) emit(e, level, render(args));
      original(...args);
    };
  }
  const originalTrace = c.trace.bind(console);
  c.trace = (...args: unknown[]) => {
    const e = current.getStore();
    if (e) {
      // The frames below this wrapper, under the message, as a browser prints them.
      const frames = (new Error().stack ?? "").split("\n").slice(2).join("\n");
      emit(e, "LOG", [...render(args), `\n${frames}`]);
    }
    originalTrace(...args);
  };
  const label = (l: unknown) => (l === undefined ? "default" : String(l));
  const originalTime = c.time.bind(console);
  c.time = (l?: unknown) => {
    const e = current.getStore();
    if (!e) return originalTime(l as string);
    const name = label(l);
    if (e.timers.has(name)) emit(e, "WARN", [`Timer '${name}' already exists`]);
    else e.timers.set(name, wallClock());
  };
  const originalTimeLog = c.timeLog.bind(console);
  c.timeLog = (l?: unknown, ...args: unknown[]) => {
    const e = current.getStore();
    if (!e) return originalTimeLog(l as string, ...args);
    const name = label(l);
    const start = e.timers.get(name);
    if (start === undefined) emit(e, "WARN", [`Timer '${name}' does not exist`]);
    else emit(e, "INFO", [`${name}: ${wallClock() - start}ms`, ...render(args)]);
  };
  const originalTimeEnd = c.timeEnd.bind(console);
  c.timeEnd = (l?: unknown) => {
    const e = current.getStore();
    if (!e) return originalTimeEnd(l as string);
    const name = label(l);
    const start = e.timers.get(name);
    if (start === undefined) emit(e, "WARN", [`Timer '${name}' does not exist`]);
    else {
      e.timers.delete(name);
      emit(e, "INFO", [`${name}: ${wallClock() - start}ms`]);
    }
  };
}

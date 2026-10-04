// Function log lines: what a query, mutation or action writes with `console.*` is captured and returned to
// the caller with its result (`logLines`), as Convex does (crates/common/src/log_lines.rs,
// crates/isolate/src/ops/console.rs, npm-packages/udf-runtime/src/02_console.ts; STUDY-20).
//
// Convex gives each function its own isolate and its own `console`. bunvex shares one process, so the
// console methods are replaced once and each call looks up the current invocation in an
// AsyncLocalStorage; outside an invocation they are the originals. As in Convex, a function's lines are not
// printed to the server's own output: they reach the caller, the function log and the log stream
// (`bunvex logs`, `dev`, the dashboard; STUDY-47).
//
// Lines are kept structured, as Convex's `LogLineStructured`: clients get them as `[LEVEL] message`
// strings, the function log (function-log.ts, STUDY-47) as they are.
import { AsyncLocalStorage } from "node:async_hooks";
import { wallClock } from "@bunvex/core";
import inspect from "object-inspect";

/** At most this many lines per invocation; the last one is the overflow notice (Convex's MAX_LOG_LINES). */
export const MAX_LOG_LINES = 256;
/** A line's messages are cut at this many UTF-8 bytes (Convex's MAX_LOG_LINE_LENGTH: 32 KiB). */
export const MAX_LOG_LINE_LENGTH = 32768;
const TRUNCATED_LINE_SUFFIX = " (truncated due to length)";

export type LogLevel = "DEBUG" | "ERROR" | "WARN" | "INFO" | "LOG";

/** One line (Convex's `LogLineStructured`): `timestamp` in wall-clock ms, `isTruncated` when it was cut. */
export type LogLine = {
  level: LogLevel;
  messages: string[];
  isTruncated: boolean;
  timestamp: number;
  /**
   * A line the system wrote, not the function (Convex's `SystemLogMetadata`): its code, e.g.
   * `warning:TooManyReads` (STUDY-76). Never cut, and not counted against the line limit.
   */
  systemCode?: string;
};

/**
 * The function execution lines belong to, for the function log (STUDY-47). Set on the executions the
 * server logs; every execution under one (attempts, cached runs) shares its owner, until a nested logged
 * execution starts its own. `onLine` sees each line as it is logged (an action's lines stream out as
 * they come); `cached` is set when a cached query result answered it; `tx` is the transaction it ran in.
 */
export type LogOwner = { onLine: ((line: LogLine) => void) | null; cached: boolean; tx: unknown; timer?: unknown };

/**
 * The lines of one execution. A mutation re-run after a conflict replaces its previous attempt's lines (an
 * aborted attempt never happened, as far as the caller can tell); a function called from an action nests
 * its execution as an entry of the action's, the way Convex keeps sub-function lines in place.
 */
type Execution = { entries: (LogLine | Execution)[]; timers: Map<string, number>; owner: LogOwner | null };

const current = new AsyncLocalStorage<Execution>();
const newExecution = (owner: LogOwner | null): Execution => ({ entries: [], timers: new Map(), owner });
const isLine = (e: LogLine | Execution): e is LogLine => "level" in e;

export type WithLogLines<T> = ({ ok: true; value: T } | { ok: false; error: unknown }) & { logLines: string[] };

/** Run one invocation (an HTTP call, a WebSocket mutation) and collect the lines it logs. */
export async function collectLogs<T>(run: () => Promise<T> | T): Promise<WithLogLines<T>> {
  installLogCapture();
  const execution = newExecution(null);
  try {
    const value = await current.run(execution, run);
    return { ok: true, value, logLines: logLinesOf(execution) };
  } catch (error) {
    return { ok: false, error, logLines: logLinesOf(execution) };
  }
}

/**
 * Run one logged function execution under `owner`. Its lines join the current invocation's, if any, as
 * before; `lines` are its own — not those of a logged execution it started.
 */
export async function withOwner<T>(
  owner: LogOwner,
  run: () => Promise<T>,
): Promise<({ ok: true; value: T } | { ok: false; error: unknown }) & { lines: LogLine[] }> {
  installLogCapture();
  const execution = newExecution(owner);
  current.getStore()?.entries.push(execution);
  try {
    const value = await current.run(execution, run);
    return { ok: true, value, lines: ownLinesOf(execution) };
  } catch (error) {
    return { ok: false, error, lines: ownLinesOf(execution) };
  }
}

/** The owner of the current execution, if it runs under a logged one. */
export const currentOwner = (): LogOwner | null => current.getStore()?.owner ?? null;

/** The current execution's own lines so far (none outside a logged execution). */
export function currentOwnLines(): LogLine[] {
  const e = current.getStore();
  return e?.owner ? ownLinesOf(e) : [];
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
      attempt = newExecution(parent.owner);
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

/**
 * A query's lines kept with its cached result (STUDY-20 D2), for `Engine` queries: on a miss the body runs in
 * its own execution, whose lines are stored with the result; on a hit the stored lines join the current
 * invocation, and its logged execution is a cache hit. One shared object, so a cache hit allocates nothing
 * for it.
 */
export const cachedQueryLogs = {
  wrap<A extends unknown[], R>(body: (...args: A) => R): { body: (...args: A) => R; capture(): LogLine[] } {
    let own: Execution | undefined;
    return {
      body: (...args) => {
        const parent = current.getStore();
        if (!parent) return body(...args);
        own = newExecution(parent.owner);
        parent.entries.push(own);
        return current.run(own, () => body(...args));
      },
      capture: () => (own ? capped(allLines(own)) : []),
    };
  },
  /** A cached run's lines into the current invocation; `hit`: it is served from the cache (the default). */
  replay(extra: unknown, hit = true) {
    const parent = current.getStore();
    if (!parent) return;
    if (parent.owner && hit) parent.owner.cached = true;
    if (Array.isArray(extra) && extra.length > 0) parent.entries.push(...(extra as LogLine[]));
  },
};

/** The lines the current invocation has logged so far (none outside an invocation). */
export function currentLogLines(): string[] {
  const e = current.getStore();
  return e ? logLinesOf(e) : [];
}

/** Every line of `execution`, nested executions included. */
function allLines(execution: Execution): LogLine[] {
  const lines: LogLine[] = [];
  const walk = (e: Execution) => {
    for (const entry of e.entries)
      if (isLine(entry)) lines.push(entry);
      else walk(entry);
  };
  walk(execution);
  return lines;
}

/** The lines of `execution` that are its owner's: nested logged executions left out. */
function ownLinesOf(execution: Execution): LogLine[] {
  const lines: LogLine[] = [];
  const walk = (e: Execution) => {
    for (const entry of e.entries)
      if (isLine(entry)) lines.push(entry);
      else if (entry.owner === execution.owner) walk(entry);
  };
  walk(execution);
  return capped(lines);
}

const logLinesOf = (execution: Execution): string[] => capped(allLines(execution)).map(prettyLogLine);

/**
 * Convex keeps MAX_LOG_LINES - 1 lines and spends the last on an [ERROR] notice. System lines are not the
 * function's: they are kept whatever its count (Convex writes them past the limit).
 */
function capped(all: LogLine[]): LogLine[] {
  const lines = all.filter((l) => l.systemCode === undefined);
  if (lines.length < MAX_LOG_LINES) return lines.length === all.length ? all : [...lines, ...systemLines(all)];
  const kept = lines.slice(0, MAX_LOG_LINES - 1);
  kept.push({
    level: "ERROR",
    messages: [`Log overflow (maximum ${MAX_LOG_LINES}). Remaining log lines omitted.`],
    isTruncated: false,
    timestamp: kept[kept.length - 1]!.timestamp,
  });
  return [...kept, ...systemLines(all)];
}

const systemLines = (lines: LogLine[]) => lines.filter((l) => l.systemCode !== undefined);

/**
 * A system warning on the running function's lines (Convex's `SystemWarning`, STUDY-76): a WARN line with its
 * code, after the function's own lines, never cut. Outside a logged function, nothing.
 */
export function logSystemLine(level: LogLevel, message: string, systemCode: string) {
  const e = current.getStore();
  if (!e) return;
  const line: LogLine = { level, messages: [message], isTruncated: false, timestamp: wallClock(), systemCode };
  e.entries.push(line);
  e.owner?.onLine?.(line);
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

/** A line of `messages`, cut at MAX_LOG_LINE_LENGTH bytes (Convex's `LogLineStructured::new_developer_log_line`). */
export function makeLogLine(level: LogLevel, messages: string[], timestamp = wallClock()): LogLine {
  const total = messages.reduce((n, m) => n + byteLength(m) + 1, 0) - 1;
  if (total <= MAX_LOG_LINE_LENGTH) return { level, messages, isTruncated: false, timestamp };
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
  return { level, messages: kept, isTruncated: true, timestamp };
}

/** A line as clients get it: `[LEVEL] msg1 msg2…`, with the truncation notice (Convex's `to_pretty_string`). */
export const prettyLogLine = (l: LogLine): string =>
  `[${l.level}] ${l.messages.join(" ")}${l.isTruncated ? TRUNCATED_LINE_SUFFIX : ""}`;

/** One line as the client sees it, cut at MAX_LOG_LINE_LENGTH bytes. */
export const formatLogLine = (level: LogLevel, messages: string[]): string =>
  prettyLogLine(makeLogLine(level, messages));

/** Each console argument as Convex renders it (object-inspect, strings quoted, nested objects indented). */
const render = (args: unknown[]) =>
  args.map((a) => inspect(a, { maxStringLength: MAX_LOG_LINE_LENGTH, indent: 2, customInspect: true }));

function emit(execution: Execution, level: LogLevel, messages: string[]) {
  const line = makeLogLine(level, messages);
  execution.entries.push(line);
  execution.owner?.onLine?.(line);
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
      else original(...args);
    };
  }
  const originalTrace = c.trace.bind(console);
  c.trace = (...args: unknown[]) => {
    const e = current.getStore();
    if (e) {
      // The frames below this wrapper, under the message, as a browser prints them.
      const frames = (new Error().stack ?? "").split("\n").slice(2).join("\n");
      emit(e, "LOG", [...render(args), `\n${frames}`]);
    } else originalTrace(...args);
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

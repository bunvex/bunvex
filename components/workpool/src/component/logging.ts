// The pool's logger (STUDY-199 §1.13), as Convex's workpool logs: console lines filtered by the pool's `logLevel`
// (stored in `globals`, or passed to a scheduled function), and events as one JSON line
// `{component: "workpool", event, ...payload}`. The levels are ordered: a level logs itself and everything after it.
// At `REPORT` the only event written is `report`; at `INFO` and below, every event.
import { type Infer, v } from "@bunvex/values";

/** The pool's log levels, from the most verbose to the least. */
export const logLevel = v.union(
  v.literal("DEBUG"),
  v.literal("TRACE"),
  v.literal("INFO"),
  v.literal("REPORT"),
  v.literal("WARN"),
  v.literal("ERROR"),
);
/** How much the pool logs: a level logs itself and every level after it. */
export type LogLevel = Infer<typeof logLevel>;

export const DEFAULT_LOG_LEVEL: LogLevel = "REPORT";

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  event: (event: string, payload: Record<string, unknown>) => void;
};

const LEVELS: readonly LogLevel[] = logLevel.members.map((member) => member.value);
const rankOf = (level: LogLevel) => LEVELS.indexOf(level);

/** Whether a pool configured at `config` logs a line at `level`. */
export function shouldLog(config: LogLevel, level: LogLevel): boolean {
  return rankOf(config) <= rankOf(level);
}

/** A logger at `level` (`REPORT` when unset). An unknown level throws. */
export function createLogger(level?: LogLevel): Logger {
  const at = rankOf(level ?? DEFAULT_LOG_LEVEL);
  if (at < 0) throw new Error(`Invalid log level: ${level}`);
  const atMost = (limit: LogLevel) => at <= rankOf(limit);
  return {
    debug: (...args) => {
      if (atMost("DEBUG")) console.debug(...args);
    },
    info: (...args) => {
      if (atMost("INFO")) console.info(...args);
    },
    warn: (...args) => {
      if (atMost("WARN")) console.warn(...args);
    },
    error: (...args) => {
      if (atMost("ERROR")) console.error(...args);
    },
    time: (label) => {
      if (atMost("TRACE")) console.time(label);
    },
    timeEnd: (label) => {
      if (atMost("TRACE")) console.timeEnd(label);
    },
    event: (event, payload) => {
      if ((at === rankOf("REPORT") && event === "report") || atMost("INFO")) {
        console.info(JSON.stringify({ component: "workpool", event, ...payload }));
      }
    },
  };
}

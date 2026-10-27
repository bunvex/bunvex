// The batch worker's logger (STUDY-196 §1.6), as Convex's package logs: console lines filtered by the `LOG_LEVEL`
// the parent binds (`REPORT` by default), and events as one JSON line `{component: "worker", event, ...payload}`.
// The levels are ordered: a level logs itself and everything after it.
import { type Infer, v } from "@bunvex/values";

export const logLevel = v.union(
  v.literal("DEBUG"),
  v.literal("TRACE"),
  v.literal("INFO"),
  v.literal("REPORT"),
  v.literal("WARN"),
  v.literal("ERROR"),
);
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

const ORDER: readonly LogLevel[] = logLevel.members.map((member) => member.value);
const rank = (level: LogLevel) => ORDER.indexOf(level);

/** Whether a worker configured at `config` logs a line at `level`. */
export function shouldLog(config: LogLevel, level: LogLevel): boolean {
  return rank(config) <= rank(level);
}

/** A logger at `level` (`REPORT` when unset). An unknown level throws. */
export function createLogger(level?: LogLevel): Logger {
  const at = rank(level ?? DEFAULT_LOG_LEVEL);
  if (at < 0) throw new Error(`Invalid log level: ${level}`);
  const upTo = (limit: LogLevel) => at <= rank(limit);
  return {
    debug: (...args) => {
      if (upTo("DEBUG")) console.debug(...args);
    },
    info: (...args) => {
      if (upTo("INFO")) console.info(...args);
    },
    warn: (...args) => {
      if (upTo("WARN")) console.warn(...args);
    },
    error: (...args) => {
      if (upTo("ERROR")) console.error(...args);
    },
    time: (label) => {
      if (upTo("TRACE")) console.time(label);
    },
    timeEnd: (label) => {
      if (upTo("TRACE")) console.timeEnd(label);
    },
    event: (event, payload) => {
      // At REPORT only the `report` event is written; at INFO and below, every event.
      if ((at === rank("REPORT") && event === "report") || upTo("INFO")) {
        console.info(JSON.stringify({ component: "worker", event, ...payload }));
      }
    },
  };
}

/** A logger that keeps what it is given instead of writing it, for tests that check what was logged. */
export type MockLogger = Logger & {
  readonly logs: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[];
  readonly events: { event: string; payload: Record<string, unknown> }[];
};

export function createMockLogger(): MockLogger {
  const logs: MockLogger["logs"] = [];
  const events: MockLogger["events"] = [];
  const keep =
    (level: MockLogger["logs"][number]["level"]) =>
    (...args: unknown[]) => {
      logs.push({ level, args });
    };
  return {
    logs,
    events,
    debug: keep("debug"),
    info: keep("info"),
    warn: keep("warn"),
    error: keep("error"),
    time: () => {},
    timeEnd: () => {},
    event: (event, payload) => {
      events.push({ event, payload });
    },
  };
}

// The client's logger and how function results are reported, as Convex's `browser/logging.ts`: function log
// lines are printed as `[BUNVEX Q(path)] [LEVEL] …`, and a failed call's error reads
// `[BUNVEX M(path)] <server message>\n  Called by client` (STUDY-26 C2).
import { BunvexError, type Value } from "@bunvex/values";
import type { FunctionFailure } from "./function-result.ts";

const INFO_COLOR = "color:rgb(0, 145, 255)";

export type UdfType = "query" | "mutation" | "action" | "any";
const prefixFor = (source: UdfType) => ({ query: "Q", mutation: "M", action: "A", any: "?" })[source];

export type LogLevel = "debug" | "info" | "warn" | "error";
/** Where the client logs: `console` by default, nowhere with `logger: false`, or your own. */
export type Logger = {
  logVerbose(...args: unknown[]): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export class DefaultLogger implements Logger {
  private listeners = new Map<number, (level: LogLevel, ...args: unknown[]) => void>();
  private nextId = 0;
  constructor(private options: { verbose: boolean }) {}

  addLogLineListener(fn: (level: LogLevel, ...args: unknown[]) => void): () => void {
    const id = this.nextId++;
    this.listeners.set(id, fn);
    return () => this.listeners.delete(id);
  }
  private emit(level: LogLevel, args: unknown[]) {
    for (const fn of this.listeners.values()) fn(level, ...args);
  }
  logVerbose(...args: unknown[]) {
    if (this.options.verbose) this.emit("debug", [new Date().toISOString(), ...args]);
  }
  log(...args: unknown[]) {
    this.emit("info", args);
  }
  warn(...args: unknown[]) {
    this.emit("warn", args);
  }
  error(...args: unknown[]) {
    this.emit("error", args);
  }
}

export function instantiateDefaultLogger(options: { verbose: boolean }): Logger {
  const logger = new DefaultLogger(options);
  logger.addLogLineListener((level, ...args) => {
    if (level === "debug") console.debug(...args);
    else if (level === "warn") console.warn(...args);
    else if (level === "error") console.error(...args);
    else console.log(...args);
  });
  return logger;
}

export function instantiateNoopLogger(options: { verbose: boolean }): Logger {
  return new DefaultLogger(options);
}

/** Print one of a function's log lines (`[LEVEL] …`), or its error message. */
export function logForFunction(
  logger: Logger,
  type: "info" | "error",
  source: UdfType,
  udfPath: string,
  message: string | { errorData: Value },
) {
  const prefix = prefixFor(source);
  const text = typeof message === "object" ? `BunvexError ${JSON.stringify(message.errorData, null, 2)}` : message;
  if (type === "info") {
    const match = text.match(/^\[.*?\] /);
    if (match === null) {
      logger.error(`[BUNVEX ${prefix}(${udfPath})] Could not parse console.log`);
      return;
    }
    const level = text.slice(1, match[0].length - 2);
    logger.log(`%c[BUNVEX ${prefix}(${udfPath})] [${level}]`, INFO_COLOR, text.slice(match[0].length));
  } else {
    logger.error(`[BUNVEX ${prefix}(${udfPath})] ${text}`);
  }
}

export function logFatalError(logger: Logger, message: string): Error {
  const errorMessage = `[BUNVEX FATAL ERROR] ${message}`;
  logger.error(errorMessage);
  return new Error(errorMessage);
}

/** The message of the error a failed call throws on the client. */
export function createHybridErrorStacktrace(source: UdfType, udfPath: string, result: FunctionFailure): string {
  return `[BUNVEX ${prefixFor(source)}(${udfPath})] ${result.errorMessage}\n  Called by client`;
}

/** The error a failed call throws: a `BunvexError` carrying the server's `errorData`, or a plain `Error`. */
export function errorFor(source: UdfType, udfPath: string, result: FunctionFailure): Error {
  const message = createHybridErrorStacktrace(source, udfPath, result);
  if (result.errorData === undefined) return new Error(message);
  const e = new BunvexError(message);
  (e as BunvexError<Value>).data = result.errorData;
  return e;
}

// Which log lines a reader wants to see (STUDY-12 §7): filtered on the client over the loaded lines, as
// Convex does — by function, by type (an execution's outcome, or a line's level) and by text. On the Logs
// screen the view lives in the URL (`?function=a:b,c:d&type=failure,error&q=text`, so a link carries it)
// and in this browser per deployment (the screen opened without filters starts from the last view, as
// Convex's does); on the Functions screen, in this browser per function.
import type { LogEntry, LogLevel } from "../data-source.ts";

export type LogType = "success" | "failure" | LogLevel;
export const LOG_TYPES: readonly LogType[] = ["success", "failure", "debug", "info", "warn", "error"];

export type LogView = {
  /** Function paths, or every function. */
  functions: string[] | "all";
  types: LogType[] | "all";
  /** Matches a function path, a message or a request id, ignoring case. */
  text: string;
};

export const ALL_LOGS: LogView = { functions: "all", types: "all", text: "" };

/**
 * A line passes when its function is selected, when its level — or, on the line that ends an execution,
 * the execution's outcome — is a selected type, and when the text is in it.
 */
export function matchesLogView(e: LogEntry, v: LogView): boolean {
  if (v.functions !== "all" && !(e.function && v.functions.includes(e.function.path))) return false;
  if (
    v.types !== "all" &&
    !v.types.includes(e.level) &&
    !(e.execution !== undefined && v.types.includes(e.execution.status))
  )
    return false;
  const text = v.text.trim().toLowerCase();
  if (text === "") return true;
  return (
    e.message.toLowerCase().includes(text) ||
    (e.function?.path.toLowerCase().includes(text) ?? false) ||
    (e.requestId?.toLowerCase().includes(text) ?? false)
  );
}

export const isFiltered = (v: LogView) => v.functions !== "all" || v.types !== "all" || v.text.trim() !== "";

/**
 * The Logs screen's search params. Lists are comma-separated (function paths and types have no commas);
 * `none` is an empty choice (nothing shown), an absent param is every value.
 */
export type LogsSearch = { function?: string; type?: string; q?: string };

const NONE = "none";
const list = (s: string | undefined) => (s === undefined ? "all" : s === NONE ? [] : s.split(",").filter(Boolean));
const joined = (v: string[]) => (v.length === 0 ? NONE : v.join(","));
const nonEmpty = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Invalid values are dropped, not rejected: a hand-edited URL still opens the screen. Every key is returned,
 * `undefined` when invalid, because the router keeps a raw param the validator leaves out.
 */
export function validateLogsSearch(input: Record<string, unknown>): LogsSearch {
  const out: LogsSearch = { function: undefined, type: undefined, q: undefined };
  const fn = nonEmpty(input.function);
  const type = nonEmpty(input.type);
  const types =
    type === NONE
      ? NONE
      : type
          ?.split(",")
          .filter((t) => LOG_TYPES.includes(t as LogType))
          .join(",");
  const q = nonEmpty(input.q);
  if (fn) out.function = fn;
  if (types) out.type = types;
  if (q) out.q = q;
  return out;
}

/** The view a URL asks for, or null when it asks for none (then the saved view applies). */
export function viewFromSearch(s: LogsSearch): LogView | null {
  if (!s.function && !s.type && !s.q) return null;
  return {
    functions: list(s.function),
    types: list(s.type) as LogType[] | "all",
    text: s.q ?? "",
  };
}

export function searchFromView(v: LogView): LogsSearch {
  const out: LogsSearch = {};
  if (v.functions !== "all") out.function = joined(v.functions);
  if (v.types !== "all") out.type = joined(v.types);
  if (v.text.trim() !== "") out.q = v.text;
  return out;
}

/** A saved view, or the default when there is none or it cannot be read. */
export function readLogView(key: string): LogView {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<LogView> | null;
    if (!v || typeof v !== "object") return ALL_LOGS;
    const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
    return {
      functions: strings(v.functions) ? (v.functions as string[]) : "all",
      types: strings(v.types)
        ? (v.types as string[]).filter((t): t is LogType => LOG_TYPES.includes(t as LogType))
        : "all",
      text: typeof v.text === "string" ? v.text : "",
    };
  } catch {
    return ALL_LOGS;
  }
}

export function writeLogView(key: string, v: LogView) {
  try {
    if (isFiltered(v)) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch {
    // storage may be unavailable (private mode); the view still works for this visit
  }
}

// Which log lines a reader wants to see (STUDY-12 §7): filtered on the client over the loaded lines, as
// Convex does — by function, by type (an execution's outcome, or a line's level) and by text. Kept in this
// browser per deployment scope (and per function on the Functions screen).
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

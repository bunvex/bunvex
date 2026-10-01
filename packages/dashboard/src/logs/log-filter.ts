// Which log lines a reader wants to see (STUDY-12 §7): filtered on the client over the loaded lines, as
// Convex does — by function, by type (an execution's outcome, or a line's level), by function kind, by text,
// and by time (UI-01 §22.4): a preset range ("the last 15 minutes") or a window brushed on the histogram.
// The view lives in the URL (`?function=a:b&type=failure,error&kind=action&q=text&range=15m`, or
// `&from=…&to=…` for a brushed window), so a link carries it, and in this browser (per deployment on the
// Logs screen, per function on the Functions screen); the screen opened without filters starts from the
// last view, as Convex's does. A brushed window lives in the URL only.
import type { FunctionKind, LogEntry, LogLevel } from "../data-source.ts";

export type LogType = "success" | "failure" | LogLevel;
export const LOG_TYPES: readonly LogType[] = ["success", "failure", "debug", "info", "warn", "error"];

export const FUNCTION_KINDS: readonly FunctionKind[] = ["query", "mutation", "action"];

/** The time range presets, newest lines back to this long ago. */
export const RANGES = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 } as const;
export type RangePreset = keyof typeof RANGES;
export const RANGE_LABEL: Record<RangePreset | "all", string> = {
  all: "All time",
  "1m": "Last minute",
  "5m": "Last 5 minutes",
  "15m": "Last 15 minutes",
  "1h": "Last hour",
};

/** A brushed window: `[from, to]` in wall-clock ms. */
export type TimeWindow = { from: number; to: number };

export type LogView = {
  /** Function paths, or every function. */
  functions: string[] | "all";
  types: LogType[] | "all";
  kinds: FunctionKind[] | "all";
  /** Matches a function path, a message or a request id, ignoring case. */
  text: string;
  /** A preset range back from now; a brushed `window` overrides it. */
  range: RangePreset | "all";
  window?: TimeWindow;
};

export const ALL_LOGS: LogView = { functions: "all", types: "all", kinds: "all", text: "", range: "all" };

/** The time a view keeps, at `now`: its window, its preset back from now, or none. */
export function timeBounds(v: LogView, now: number): TimeWindow | null {
  if (v.window) return v.window;
  if (v.range !== "all") return { from: now - RANGES[v.range], to: now };
  return null;
}

/** In the view's time and text (the filters every count is taken under). */
function inTimeAndText(e: LogEntry, v: LogView, now: number): boolean {
  const t = timeBounds(v, now);
  if (t && (e.time < t.from || e.time > t.to)) return false;
  const text = v.text.trim().toLowerCase();
  if (text === "") return true;
  return (
    e.message.toLowerCase().includes(text) ||
    (e.function?.path.toLowerCase().includes(text) ?? false) ||
    (e.requestId?.toLowerCase().includes(text) ?? false)
  );
}

const typeMatches = (e: LogEntry, types: LogType[]) =>
  types.includes(e.level) || (e.execution !== undefined && types.includes(e.execution.status));

/**
 * A line passes when its function and its function's kind are selected, when its level — or, on the line
 * that ends an execution, the execution's outcome — is a selected type, when it is in the time range (or the
 * brushed window), and when the text is in it. `now` anchors a preset range.
 */
export function matchesLogView(e: LogEntry, v: LogView, now = Date.now()): boolean {
  if (v.functions !== "all" && !(e.function && v.functions.includes(e.function.path))) return false;
  if (v.kinds !== "all" && !(e.function && v.kinds.includes(e.function.kind))) return false;
  if (v.types !== "all" && !typeMatches(e, v.types)) return false;
  return inTimeAndText(e, v, now);
}

/**
 * How many loaded lines each choice would show, under the view's time and text (not under the other
 * choices: each section counts what it can still add) — the filter column's counts.
 */
export function facetCounts(lines: LogEntry[], v: LogView, now = Date.now()) {
  const functions = new Map<string, number>();
  const kinds = new Map<FunctionKind, number>();
  const types = new Map<LogType, number>();
  const add = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of lines) {
    if (!inTimeAndText(e, v, now)) continue;
    if (e.function) {
      add(functions, e.function.path);
      add(kinds, e.function.kind);
    }
    add(types, e.level);
    if (e.execution) add(types, e.execution.status);
  }
  return { functions, kinds, types };
}

export const isFiltered = (v: LogView) =>
  v.functions !== "all" ||
  v.types !== "all" ||
  v.kinds !== "all" ||
  v.text.trim() !== "" ||
  v.range !== "all" ||
  v.window !== undefined;

/**
 * The Logs screen's search params. Lists are comma-separated (function paths and types have no commas);
 * `none` is an empty choice (nothing shown), an absent param is every value.
 */
export type LogsSearch = {
  function?: string;
  type?: string;
  kind?: string;
  q?: string;
  range?: RangePreset;
  /** A brushed window, in wall-clock ms. */
  from?: number;
  to?: number;
};

const NONE = "none";
const list = (s: string | undefined) => (s === undefined ? "all" : s === NONE ? [] : s.split(",").filter(Boolean));
const joined = (v: string[]) => (v.length === 0 ? NONE : v.join(","));
const nonEmpty = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Invalid values are dropped, not rejected: a hand-edited URL still opens the screen. Every key is returned,
 * `undefined` when invalid, because the router keeps a raw param the validator leaves out.
 */
export function validateLogsSearch(input: Record<string, unknown>): LogsSearch {
  const out: LogsSearch = {
    function: undefined,
    type: undefined,
    kind: undefined,
    q: undefined,
    range: undefined,
    from: undefined,
    to: undefined,
  };
  const fn = nonEmpty(input.function);
  const type = nonEmpty(input.type);
  const types =
    type === NONE
      ? NONE
      : type
          ?.split(",")
          .filter((t) => LOG_TYPES.includes(t as LogType))
          .join(",");
  const kind = nonEmpty(input.kind);
  const kinds =
    kind === NONE
      ? NONE
      : kind
          ?.split(",")
          .filter((k) => FUNCTION_KINDS.includes(k as FunctionKind))
          .join(",");
  const q = nonEmpty(input.q);
  const range = typeof input.range === "string" && input.range in RANGES ? (input.range as RangePreset) : undefined;
  const ms = (x: unknown) => {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  };
  const from = ms(input.from);
  const to = ms(input.to);
  if (fn) out.function = fn;
  if (types) out.type = types;
  if (kinds) out.kind = kinds;
  if (q) out.q = q;
  if (range) out.range = range;
  // a window needs both ends, in order
  if (from !== undefined && to !== undefined && from < to) {
    out.from = from;
    out.to = to;
  }
  return out;
}

/** The view a URL asks for, or null when it asks for none (then the saved view applies). */
export function viewFromSearch(s: LogsSearch): LogView | null {
  if (!s.function && !s.type && !s.kind && !s.q && !s.range && s.from === undefined) return null;
  return {
    functions: list(s.function),
    types: list(s.type) as LogType[] | "all",
    kinds: list(s.kind) as FunctionKind[] | "all",
    text: s.q ?? "",
    range: s.range ?? "all",
    ...(s.from !== undefined && s.to !== undefined && { window: { from: s.from, to: s.to } }),
  };
}

export function searchFromView(v: LogView): LogsSearch {
  const out: LogsSearch = {};
  if (v.functions !== "all") out.function = joined(v.functions);
  if (v.types !== "all") out.type = joined(v.types);
  if (v.kinds !== "all") out.kind = joined(v.kinds);
  if (v.text.trim() !== "") out.q = v.text;
  if (v.range !== "all") out.range = v.range;
  if (v.window) {
    out.from = Math.round(v.window.from);
    out.to = Math.round(v.window.to);
  }
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
      kinds: strings(v.kinds)
        ? (v.kinds as string[]).filter((k): k is FunctionKind => FUNCTION_KINDS.includes(k as FunctionKind))
        : "all",
      text: typeof v.text === "string" ? v.text : "",
      range: typeof v.range === "string" && v.range in RANGES ? (v.range as RangePreset) : "all",
    };
  } catch {
    return ALL_LOGS;
  }
}

export function writeLogView(key: string, v: LogView) {
  try {
    // a brushed window is a moment's look: the URL keeps it, the browser does not
    const { window: _brushed, ...kept } = v;
    if (isFiltered(kept)) localStorage.setItem(key, JSON.stringify(kept));
    else localStorage.removeItem(key);
  } catch {
    // storage may be unavailable (private mode); the view still works for this visit
  }
}

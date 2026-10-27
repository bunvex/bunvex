// Log lines as a data grid (STUDY-12 §7): newest first, one row per line — in Convex's order
// (`LogListItem.tsx`): time, request, the execution's outcome on its last line, function, a log line's level,
// message. Arrows move between lines; Enter or a click opens a
// line's details, which then follow the current line.

import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { StatusBadge } from "@bunvex/ui/components/status-badge";
import { cn } from "@bunvex/ui/lib/utils";
import { type ReactNode, useEffect, useState } from "react";
import type { FunctionKind, LogEntry } from "../data-source.ts";
import type { LogRow } from "./events.ts";

const col = dataTableColumns<LogRow>();

// the shared time rule (UX2-20): milliseconds, and the date unless it is today
import { formatLogTime } from "../shell/time.tsx";

export { formatLogTime };

export const formatDuration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export const KIND_LETTER: Record<FunctionKind, string> = { query: "Q", mutation: "M", action: "A", httpAction: "H" };

/** A kind's name where a letter stands for it (Convex's log details say "HTTP Action"). */
export const KIND_TITLE: Record<FunctionKind, string> = {
  query: "query",
  mutation: "mutation",
  action: "action",
  httpAction: "HTTP action",
};

/** A line that went wrong: an error, or the end of a failed execution. */
export const isFailure = (e: LogEntry) => e.level === "error" || e.execution?.status === "failure";

const allColumns: DataTableColumn<LogRow>[] = [
  col.accessor((e) => e.time, {
    id: "time",
    header: "Time",
    cell: (c) => <span className="font-mono text-xs tabular-nums">{formatLogTime(c.getValue())}</span>,
  }),
  col.accessor((e) => e.requestId ?? "", {
    id: "request",
    header: "Request",
    cell: (c) => (
      <span className="font-mono text-xs text-muted-foreground" title={c.getValue()}>
        {c.getValue().slice(0, 4)}
      </span>
    ),
  }),
  col.accessor((e) => e.execution, {
    id: "outcome",
    header: "Outcome",
    cell: (c) => {
      const x = c.getValue() as LogEntry["execution"];
      if (!x) return null;
      // a cached result says so in place of its duration, as Convex's list does
      return (
        <StatusBadge status={x.status}>
          {x.cached ? <span className="text-success">(cached)</span> : formatDuration(x.durationMs)}
        </StatusBadge>
      );
    },
  }),
  col.accessor((e) => e.level, {
    id: "level",
    header: "Level",
    // a log line's level; an execution's outcome line has none, its outcome is the Outcome column (as Convex)
    cell: (c) =>
      c.row.original.event ? (
        <span className="font-mono text-xs text-info uppercase">event</span>
      ) : c.row.original.execution ? null : (
        <span
          className={cn(
            "font-mono text-xs uppercase",
            c.getValue() === "error"
              ? "text-destructive"
              : c.getValue() === "warn"
                ? "text-warning"
                : "text-muted-foreground",
          )}
        >
          {c.getValue()}
        </span>
      ),
  }),
  col.accessor((e) => e.function, {
    id: "function",
    header: "Function",
    cell: (c) => {
      // a deployment event: who did it, where a line has its function
      const event = c.row.original.event;
      if (event) return <span className="truncate text-xs text-muted-foreground">{event.author ?? "unknown"}</span>;
      const f = c.getValue() as LogEntry["function"];
      if (!f) return null;
      return (
        <span className="flex min-w-0 items-center gap-2">
          <abbr
            title={KIND_TITLE[f.kind]}
            className="shrink-0 border px-1 font-mono text-[10px] leading-4 text-muted-foreground no-underline"
          >
            {KIND_LETTER[f.kind]}
          </abbr>
          <span className="truncate font-mono text-xs">{f.path}</span>
        </span>
      );
    },
  }),
  col.accessor((e) => e.message, {
    id: "message",
    header: "Message",
    cell: (c) => (
      <span className={cn("font-mono text-xs", isFailure(c.row.original) && "text-destructive")}>{c.getValue()}</span>
    ),
  }),
];

const pick = (order: string[]) => order.map((id) => allColumns.find((c) => c.id === id)!);
/** Convex's order (`LogListItem.tsx`); the message last, in the width the others leave. */
const columns = pick(["time", "request", "outcome", "function", "level", "message"]);
/** On a phone the message comes right after the time: it is what a reader wants (UX-6). */
const PHONE = "(max-width: 639px)";
const phoneColumns = pick(["time", "message", "level", "function", "outcome", "request"]);
/** Beside a docked panel the list is narrow: the message right after the level, so it stays in view (UX2-10). */
const narrowColumns = pick(["time", "level", "message", "outcome", "function", "request"]);
const without = (cs: DataTableColumn<LogRow>[], id?: string) => (id ? cs.filter((c) => c.id !== id) : cs);

function useMatches(query: string) {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** The message's is the least it gets: it fills the rest of the row (`fillColumn`), mostly empty on outcome lines. */
const WIDTHS: Record<string, number> = { time: 176, request: 72, outcome: 144, function: 240, level: 72, message: 320 };

export function LogList(props: {
  label: string;
  /** Lines, and deployment events among them (STUDY-12 §10.4). */
  lines: LogRow[];
  /** Enter or a click on a row. */
  onOpen: (row: LogRow) => void;
  /** The current row moved while details are open: they follow it. */
  onMove?: (row: LogRow) => void;
  onEndReached?: () => void;
  empty: ReactNode;
  footer?: ReactNode;
  resetKey?: unknown;
  className?: string;
  /** Fills its container, edge to edge (UI-01 §22.4). */
  fill?: boolean;
  /** A details panel is open beside the list: the message moves up (UX2-10). */
  narrow?: boolean;
  /** One function's lines (Functions → Logs): no Function column, it is always that one (UX2-10). */
  hideFunction?: boolean;
}) {
  const phone = useMatches(PHONE);
  const shown = without(
    phone ? phoneColumns : props.narrow ? narrowColumns : columns,
    props.hideFunction ? "function" : undefined,
  );
  return (
    <DataTable
      label={props.label}
      className={props.className}
      fill={props.fill}
      columns={shown}
      // the time stays in view when a long message scrolls the list sideways (UX-5)
      stickyColumn="time"
      fillColumn="message"
      data={props.lines}
      getRowId={(e) => e.id}
      resetKey={props.resetKey}
      defaultColumnWidth={(id) => WIDTHS[id] ?? 160}
      onEndReached={props.onEndReached}
      grid={{
        activateOnClick: true,
        onCellActivate: (e) => props.onOpen(e),
        onCellFocus: props.onMove && ((e) => props.onMove?.(e)),
      }}
      empty={props.empty}
      footer={props.footer}
    />
  );
}

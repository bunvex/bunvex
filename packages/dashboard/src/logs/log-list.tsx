// Log lines as a data grid (STUDY-12 §7): newest first, one row per line — time, request, the execution's
// outcome on its last line, level, function, message. Arrows move between lines; Enter or a click opens a
// line's details, which then follow the current line.
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { cn } from "@bunvex/ui/lib/utils";
import type { ReactNode } from "react";
import type { FunctionKind, LogEntry } from "../data-source.ts";

const col = dataTableColumns<LogEntry>();
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "09-29 12:04:05.123" in the viewer's time zone. */
export function formatLogTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export const formatDuration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export const KIND_LETTER: Record<FunctionKind, string> = { query: "Q", mutation: "M", action: "A" };

/** A line that went wrong: an error, or the end of a failed execution. */
export const isFailure = (e: LogEntry) => e.level === "error" || e.execution?.status === "failure";

const columns: DataTableColumn<LogEntry>[] = [
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
      return (
        <span className={cn("text-xs", x.status === "failure" ? "text-destructive" : "text-muted-foreground")}>
          {x.status} <span className="tabular-nums">{formatDuration(x.durationMs)}</span>
        </span>
      );
    },
  }),
  col.accessor((e) => e.level, {
    id: "level",
    header: "Level",
    cell: (c) => (
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
      const f = c.getValue() as LogEntry["function"];
      if (!f) return null;
      return (
        <span className="flex min-w-0 items-center gap-2">
          <abbr
            title={f.kind}
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

const WIDTHS: Record<string, number> = { time: 176, request: 92, outcome: 124, level: 76, function: 200, message: 560 };

export function LogList(props: {
  label: string;
  lines: LogEntry[];
  /** Enter or a click on a line. */
  onOpen: (line: LogEntry) => void;
  /** The current line moved while details are open: they follow it. */
  onMove?: (line: LogEntry) => void;
  onEndReached?: () => void;
  empty: ReactNode;
  footer?: ReactNode;
  resetKey?: unknown;
  className?: string;
}) {
  return (
    <DataTable
      label={props.label}
      className={props.className}
      columns={columns}
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

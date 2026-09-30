// The Logs screen (STUDY-12 §7, UI-01 §12.5.7): every function's log lines, live, newest first, filtered on
// the client by function, type and text (kept in this browser per deployment), with a line's details beside
// the list.
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { functionsQuery } from "../data/queries.ts";
import { type LogEntry, toDataSourceError } from "../data-source.ts";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { LogDetails } from "./log-details.tsx";
import { isFiltered, type LogView, matchesLogView, readLogView, writeLogView } from "./log-filter.ts";
import { LogList } from "./log-list.tsx";
import { LogToolbar } from "./log-toolbar.tsx";
import { type LogLines, useLogLines } from "./use-logs.ts";

/** A view kept in this browser under `key`. */
export function useLogView(key: string): [LogView, (v: LogView) => void] {
  const [view, setView] = useState(() => readLogView(key));
  const update = useCallback(
    (v: LogView) => {
      setView(v);
      writeLogView(key, v);
    },
    [key],
  );
  return [view, update];
}

/** The toolbar, the list and the details: the Logs screen, and a function's logs on the Functions screen. */
export function LogsView(props: {
  label: string;
  logs: LogLines;
  view: LogView;
  onView: (v: LogView) => void;
  functions?: string[];
  /** Above the toolbar, e.g. the screen's heading. */
  header?: ReactNode;
}) {
  const { logs, view, onView } = props;
  const shown = useMemo(() => logs.lines.filter((e) => matchesLogView(e, view)), [logs.lines, view]);
  const [open, setOpen] = useState<LogEntry | null>(null);
  const filtered = isFiltered(view);
  const status = logs.loadingOlder
    ? "Loading older lines…"
    : filtered
      ? `${formatCount(shown.length)} of ${formatCount(logs.lines.length)} loaded lines match`
      : `${formatCount(logs.lines.length)} lines${logs.hasOlder ? " loaded" : ""}`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-6">
        {props.header}
        <LogToolbar view={view} onView={onView} functions={props.functions} logs={logs} />
        {logs.liveError && <ErrorState error={logs.liveError} />}
        {logs.error && logs.lines.length === 0 ? (
          <ErrorState error={toDataSourceError(logs.error)} />
        ) : (
          <LogList
            label={props.label}
            className="max-h-[calc(100svh-12rem)]"
            lines={shown}
            onOpen={setOpen}
            onMove={open ? setOpen : undefined}
            onEndReached={logs.loadOlder}
            empty={
              logs.pending
                ? "Loading…"
                : filtered && logs.lines.length > 0
                  ? "No loaded line matches these filters."
                  : logs.paused
                    ? "Paused. Resume to see new lines."
                    : "Waiting for new lines…"
            }
            footer={<span aria-live="polite">{status}</span>}
          />
        )}
      </div>
      {open && (
        <LogDetails
          line={open}
          lines={logs.lines}
          onFilterByRequest={(requestId) => onView({ ...view, text: requestId })}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function LogsScreen() {
  const scope = useQueryScope();
  const { data: functions = [] } = useQuery(functionsQuery(scope));
  const [view, setView] = useLogView(`bunvex:logs:${scope.scope}`);
  const logs = useLogLines();
  return (
    // full-bleed inside <main>: the details panel runs to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <LogsView
        header={<h1 className="text-xl font-semibold tracking-tight">Logs</h1>}
        label="Log lines"
        logs={logs}
        view={view}
        onView={setView}
        functions={functions.map((f) => f.path).sort()}
      />
    </div>
  );
}

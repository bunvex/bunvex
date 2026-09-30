// The Logs screen (STUDY-12 §7, UI-01 §12.5.7): every function's log lines, live, newest first, filtered on
// the client by function, type and text (in the URL, and kept in this browser per deployment), with a line's
// details beside the list.
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { functionsQuery } from "../data/queries.ts";
import { type AuditEvent, type LogEntry, toDataSourceError } from "../data-source.ts";
import { logsRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { interleave, useLogEvents } from "./events.ts";
import { LogDetails } from "./log-details.tsx";
import {
  isFiltered,
  type LogsSearch,
  type LogView,
  matchesLogView,
  readLogView,
  searchFromView,
  viewFromSearch,
  writeLogView,
} from "./log-filter.ts";
import { LogList } from "./log-list.tsx";
import { LogToolbar } from "./log-toolbar.tsx";
import { type LogLines, useLogLines } from "./use-logs.ts";

/**
 * A view in the URL and kept in this browser under `key` (STUDY-12 L7): the URL's view wins and is kept;
 * with none in the URL, the kept view applies and goes into the address. `navigate` writes the view's
 * search params, replacing the entry when only the text changed (typing), adding one otherwise.
 */
export function useLogViewInUrl(
  key: string,
  search: LogsSearch,
  navigate: (search: LogsSearch, replace: boolean) => void,
): [LogView, (v: LogView) => void] {
  const fromUrl = viewFromSearch(search);
  const [saved] = useState(() => readLogView(key));
  const view = fromUrl ?? saved;
  // on arrival only (a new key is a new screen: give it a React key); later changes go through setView
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once, when the view opens
  useEffect(() => {
    if (fromUrl) writeLogView(key, fromUrl);
    else if (isFiltered(saved)) navigate(searchFromView(saved), true);
  }, []);
  const setView = (v: LogView) => {
    writeLogView(key, v);
    // typing in the text box replaces the address; picking functions or types is a step Back undoes
    navigate(searchFromView(v), v.functions === view.functions && v.types === view.types);
  };
  return [view, setView];
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
  /** The deployment's events to place among the lines (STUDY-12 §10.4), and what Enter on one does. */
  events?: AuditEvent[];
  onOpenEvent?: (e: AuditEvent) => void;
}) {
  const { logs, view, onView } = props;
  const shown = useMemo(() => logs.lines.filter((e) => matchesLogView(e, view)), [logs.lines, view]);
  // events within the loaded lines' time, among them — not filtered: they are not log lines (as in Convex)
  const oldest = logs.lines.at(-1)?.time;
  const rows = useMemo(
    () =>
      interleave(
        shown,
        (props.events ?? []).filter((e) => oldest !== undefined && e.time >= oldest),
      ),
    [shown, props.events, oldest],
  );
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
            lines={rows}
            onOpen={(row) => (row.event ? props.onOpenEvent?.(row.event) : setOpen(row))}
            onMove={open ? (row) => row.event || setOpen(row) : undefined}
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
  const navigate = logsRoute.useNavigate();
  const [view, setView] = useLogViewInUrl(`bunvex:logs:${scope.scope}`, logsRoute.useSearch(), (search, replace) =>
    navigate({ search, replace }),
  );
  const logs = useLogLines();
  const events = useLogEvents(logs.lines.at(-1)?.time);
  return (
    // full-bleed inside <main>: the details panel runs to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <LogsView
        events={events}
        // an event's details are the History screen's
        onOpenEvent={(e) => void navigate({ to: "/history", search: { event: e.id } })}
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

// The Logs screen (STUDY-12 §7, UI-01 §22.4): every function's log lines, live, newest first, filtered on
// the client by time, function, type, kind and text (in the URL, and kept in this browser per deployment),
// with their volume over time above them and a line's details beside them.
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { functionsQuery } from "../data/queries.ts";
import { type AuditEvent, type LogEntry, toDataSourceError } from "../data-source.ts";
import { logsRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { ErrorState } from "../shell/error-state.tsx";
import { useSectionSheet } from "../shell/section-column.tsx";
import { interleave, useLogEvents } from "./events.ts";
import { exportName, saveText, toJsonLines } from "./export.ts";
import { FilterColumn, FilterSections } from "./filter-column.tsx";
import { LogHistogram } from "./histogram.tsx";
import { LogBar } from "./log-bar.tsx";
import { LogDetails } from "./log-details.tsx";
import {
  ALL_LOGS,
  facetCounts,
  isFiltered,
  type LogsSearch,
  type LogView,
  matchesLogView,
  readLogView,
  searchFromView,
  timeBounds,
  viewFromSearch,
  writeLogView,
} from "./log-filter.ts";
import { LogList } from "./log-list.tsx";
import { type LogLines, MAX_LOGS, useLogLines } from "./use-logs.ts";

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
    // typing in the text box replaces the address; any other choice is a step Back undoes
    const typing =
      v.functions === view.functions &&
      v.types === view.types &&
      v.kinds === view.kinds &&
      v.range === view.range &&
      v.window === view.window;
    navigate(searchFromView(v), typing);
  };
  return [view, setView];
}

/** `Date.now()`, again every `ms` while `on` (a preset range moves with the clock). */
function useNow(on: boolean, ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return on ? now : Date.now();
}

/**
 * The logs, laid out as the Database screen is (UI-01 §22.4): the filter column on the left; two bars across
 * the top — the text filter and the actions, then the histogram; the list filling the rest; a line's details
 * docked on the right while a line is selected. The Logs screen and a function's Logs tab both show it.
 */
export function LogsView(props: {
  label: string;
  logs: LogLines;
  view: LogView;
  onView: (v: LogView) => void;
  /** The functions to filter by (the Logs screen); without them the column has no Functions or kinds. */
  functions?: string[];
  /** In the first bar, before the search: the screen's heading. */
  heading?: ReactNode;
  /** Where the filter column's width is kept. */
  widthKey: string;
  /** On top of the section column; "Logs" by default. */
  columnTitle?: string;
  /** The exported file's name starts with this. */
  exportPrefix: string;
  /** The deployment's events to place among the lines (STUDY-12 §10.4), and what Enter on one does. */
  events?: AuditEvent[];
  onOpenEvent?: (e: AuditEvent) => void;
}) {
  const { logs, view, onView } = props;
  const now = useNow(view.range !== "all");
  const shown = useMemo(() => logs.lines.filter((e) => matchesLogView(e, view, now)), [logs.lines, view, now]);
  // the histogram counts what every filter but time keeps: the time is what it picks
  const timeless = useMemo(() => ({ ...view, range: "all" as const, window: undefined }), [view]);
  const charted = useMemo(() => logs.lines.filter((e) => matchesLogView(e, timeless)), [logs.lines, timeless]);
  const counts = useMemo(() => facetCounts(logs.lines, view, now), [logs.lines, view, now]);
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
  // a time range older than the loaded lines loads older pages, up to the buffer's size (STUDY-12 L2, L4)
  const bounds = timeBounds(view, now);
  const { hasOlder, loadingOlder, loadOlder } = logs;
  const needOlder =
    bounds !== null && oldest !== undefined && oldest > bounds.from && hasOlder && logs.lines.length < MAX_LOGS;
  useEffect(() => {
    if (needOlder && !loadingOlder) loadOlder();
  }, [needOlder, loadingOlder, loadOlder]);

  const [open, setOpen] = useState<LogEntry | null>(null);
  const filtered = isFiltered(view);
  const n = logs.lines.length;
  const count = filtered
    ? `${formatCount(shown.length)} of ${formatCount(n)} line${n === 1 ? "" : "s"}`
    : `${formatCount(n)} line${n === 1 ? "" : "s"}`;
  const sections = {
    view,
    onView,
    counts,
    functions: props.functions,
    kinds: props.functions !== undefined,
  };
  const reset = filtered ? () => onView({ ...ALL_LOGS }) : undefined;
  const filtersSheet = useSectionSheet({
    kind: "logs-filters",
    onReset: reset,
    children: <FilterSections {...sections} />,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <FilterColumn {...sections} title={props.columnTitle ?? "Logs"} widthKey={props.widthKey} onReset={reset} />
      <div className="@container/logs flex min-h-0 min-w-0 flex-1 flex-col">
        <LogBar
          heading={props.heading}
          view={view}
          onView={onView}
          logs={logs}
          count={count}
          canExport={shown.length > 0}
          onExport={() => saveText(exportName(props.exportPrefix, Date.now()), toJsonLines(shown))}
          filtersButton={filtersSheet.button}
        />
        <LogHistogram
          lines={charted}
          now={now}
          range={view.range}
          window={view.window}
          onWindow={(window) => onView({ ...view, window })}
        />
        {logs.liveError && <ErrorState error={logs.liveError} />}
        {logs.error && logs.lines.length === 0 ? (
          <ErrorState error={toDataSourceError(logs.error)} />
        ) : (
          <LogList
            label={props.label}
            fill
            lines={rows}
            onOpen={(row) => (row.event ? props.onOpenEvent?.(row.event) : setOpen(row))}
            onMove={open ? (row) => row.event || setOpen(row) : undefined}
            narrow={!!open}
            hideFunction={!props.functions}
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
          />
        )}
      </div>
      {filtersSheet.sheet}
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
    <div className="-m-4 flex h-[calc(100svh-3rem)] md:-m-6">
      <LogsView
        events={events}
        // an event's details are the History screen's
        onOpenEvent={(e) => void navigate({ to: "/history", search: { event: e.id } })}
        heading={<h1 className="mr-2 text-base font-semibold tracking-tight">Logs</h1>}
        widthKey="bunvex-dashboard:logs-filters-width"
        exportPrefix="logs"
        label="Log lines"
        logs={logs}
        view={view}
        onView={setView}
        functions={functions.map((f) => f.path).sort()}
      />
    </div>
  );
}

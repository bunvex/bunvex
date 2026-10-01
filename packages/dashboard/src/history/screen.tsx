// The History screen (UI-01 §14.5, §22.5, STUDY-12 §9): the deployment's audit log, newest first, between two
// days and for the actions asked (`?action=a,b`), filtered by the source; a filter column with the days and
// the actions, each action with how many loaded events it has; an event's details docked beside the list,
// following the current row. Live: new events come in as recorded.

import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { infiniteQueryOptions, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import { type AuditEvent, type AuditEventQuery, toDataSourceError } from "../data-source.ts";
import { formatLiteral } from "../database/literal.ts";
import { formatTime } from "../database/values.ts";
import { type HistorySearch, historyRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { BAR_TITLE, BAR1, SCREEN } from "../shell/bars.ts";
import { DayInput, dayBound } from "../shell/day-input.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { FacetColumn, FacetGroup, FacetRadios, FacetSection, useFiltersSheet } from "../shell/facet-column.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { Panel } from "../shell/panel.tsx";
import { ACTION_LABELS, describeEvent } from "./describe.ts";

const PAGE = 50;
const col = dataTableColumns<AuditEvent>();

type Filter = Omit<AuditEventQuery, "numItems" | "cursor">;
const historyKey = (scope: string) => [...dashboardKeys.all(scope), "history"] as const;

const eventsQuery = ({ source, scope }: QueryScope, f: Filter) =>
  infiniteQueryOptions({
    queryKey: [...historyKey(scope), f.from ?? null, f.to ?? null, f.actions ?? null] as const,
    queryFn: ({ pageParam, signal }) =>
      source.listAuditEvents!({ ...f, numItems: PAGE, cursor: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.isDone ? undefined : last.continueCursor),
  });

export function HistoryScreen() {
  const { source } = useQueryScope();
  if (typeof source.listAuditEvents !== "function") return <NotOffered title="History" what="an audit log" />;
  return <History />;
}

const DAY_PRESETS = [
  { value: "all", label: "Any day" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;
type DayPreset = (typeof DAY_PRESETS)[number]["value"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A preset's `from` day, counted back from today (in the viewer's zone); none for "Any day". */
function presetFrom(p: DayPreset, today = new Date()): string | undefined {
  if (p === "all") return undefined;
  const back = p === "today" ? 0 : p === "7d" ? 6 : 29;
  return isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
}
/** Which preset a day range is, if one. */
function presetOf(from?: string, to?: string): DayPreset | undefined {
  if (to) return undefined;
  return DAY_PRESETS.find((p) => presetFrom(p.value) === from)?.value;
}

function History() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const search = historyRoute.useSearch();
  const navigate = historyRoute.useNavigate();
  const setSearch = (patch: Partial<HistorySearch>, replace = false) =>
    navigate({ search: (s: HistorySearch): HistorySearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed = caps?.operations.includes("viewAuditLog") ?? true;
  const actions = search.action?.split(",");
  const days: Filter = { from: dayBound(search.from, false), to: dayBound(search.to, true) };
  const filter: Filter = { ...days, actions };
  const list = useInfiniteQuery({ ...eventsQuery(scope, filter), enabled: allowed });
  // the column's counts: the loaded events of these days, every action (the same query when none is picked)
  const unfiltered = useInfiniteQuery({ ...eventsQuery(scope, days), enabled: allowed });
  const liveError = useWatch<void>(
    (onChange, onError) => scope.source.watchAuditEvents?.(onChange, onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: historyKey(scope.scope) }),
    [scope.source, scope.scope],
  );
  const events = list.data?.pages.flatMap((p) => p.page) ?? [];
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of unfiltered.data?.pages ?? []) for (const e of p.page) m.set(e.action, (m.get(e.action) ?? 0) + 1);
    return m;
  }, [unfiltered.data]);
  const open = search.event === undefined ? undefined : (events.find((e) => e.id === search.event) ?? null);
  // every known action, then any other the loaded events have
  const options = [...new Set([...Object.keys(ACTION_LABELS), ...counts.keys()])];
  const filtered = search.action !== undefined || search.from !== undefined || search.to !== undefined;
  const reset = filtered
    ? () => setSearch({ action: undefined, from: undefined, to: undefined, event: undefined })
    : undefined;
  const preset = presetOf(search.from, search.to);

  const sections = (
    <>
      <FacetRadios<DayPreset>
        title="Days"
        options={DAY_PRESETS}
        value={preset}
        onChange={(p) => setSearch({ from: presetFrom(p), to: undefined, event: undefined })}
      />
      <FacetSection title="Day range">
        <div className="flex flex-col gap-2 px-3 py-1">
          <DayInput label="From" value={search.from} onChange={(v) => setSearch({ from: v }, true)} />
          <DayInput label="Until" value={search.to} onChange={(v) => setSearch({ to: v }, true)} />
        </div>
      </FacetSection>
      <FacetGroup
        title="Action"
        options={options}
        value={actions ?? "all"}
        counts={counts}
        label={(a) => ACTION_LABELS[a] ?? a}
        onChange={(v) =>
          setSearch({ action: v === "all" ? undefined : v.length ? v.join(",") : "none", event: undefined })
        }
      />
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Counts are of the {formatCount(counts.size ? [...counts.values()].reduce((a, b) => a + b, 0) : 0)} loaded events
        {unfiltered.hasNextPage ? "; scroll for more" : ""}.
      </p>
    </>
  );
  const sheet = useFiltersSheet({ kind: "history-filters", onReset: reset, children: sections });

  const columns: DataTableColumn<AuditEvent>[] = [
    col.accessor((e) => e.time, {
      id: "time",
      header: "Time",
      cell: (c) => <span className="font-mono text-xs tabular-nums">{formatTime(c.getValue())}</span>,
    }),
    col.accessor((e) => describeEvent(e), {
      id: "what",
      header: "What happened",
      cell: (c) => <span className="text-sm">{c.getValue()}</span>,
    }),
    col.accessor((e) => e.author ?? "unknown", {
      id: "author",
      header: "By",
      cell: (c) => <span className="text-xs text-muted-foreground">{c.getValue()}</span>,
    }),
  ];

  return (
    // full-bleed (UI-01 §22.5): the filter column, Bar 1, the grid to the bottom, the details docked
    <div className={SCREEN}>
      {allowed && (
        <FacetColumn label="History filters" widthKey="bunvex-dashboard:history-filters-width" onReset={reset}>
          {sections}
        </FacetColumn>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* the count next to the title, as every list screen has it (UX-14) */}
        <div className={BAR1}>
          <h1 className={BAR_TITLE}>History</h1>
          {allowed && sheet.button}
          {allowed && !list.isPending && (
            <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {`${formatCount(events.length)}${list.hasNextPage ? "+" : ""} ${events.length === 1 && !list.hasNextPage ? "event" : "events"}`}
            </span>
          )}
        </div>
        {!allowed ? (
          <p className="p-4 text-sm text-muted-foreground md:p-6">This credential cannot view the audit log.</p>
        ) : (
          <>
            {liveError && <ErrorState error={liveError} />}
            {list.error ? (
              <ErrorState error={toDataSourceError(list.error)} />
            ) : (
              <DataTable
                label="Audit log"
                fill
                columns={columns}
                data={events}
                getRowId={(e) => e.id}
                defaultColumnWidth={(id) => ({ time: 190, what: 420, author: 140 })[id] ?? 160}
                onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
                grid={{
                  activateOnClick: true,
                  onCellActivate: (e) => setSearch({ event: e.id }),
                  // open details follow the current row, as on Database and Logs
                  onCellFocus: (e) =>
                    search.event !== undefined && e.id !== search.event && setSearch({ event: e.id }, true),
                }}
                empty={
                  list.isPending
                    ? "Loading…"
                    : filtered
                      ? "Nothing matches these filters."
                      : "Nothing has been recorded yet. Changes made from the dashboard and deploys appear here."
                }
                footer={list.hasNextPage ? <span>{`${events.length} loaded`}</span> : undefined}
              />
            )}
          </>
        )}
      </div>
      {sheet.sheet}
      {open !== undefined && (
        <Panel kind="history-details" title="Event" focusOnOpen={false} onClose={() => setSearch({ event: undefined })}>
          {open === null ? (
            <p className="text-sm text-muted-foreground">This event is not in the loaded list.</p>
          ) : (
            <div className="flex flex-col gap-4 text-sm">
              <p className="font-medium">{describeEvent(open)}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt className="text-muted-foreground">Time</dt>
                <dd>
                  <time dateTime={new Date(open.time).toISOString()}>{formatTime(open.time)}</time>
                </dd>
                <dt className="text-muted-foreground">Action</dt>
                <dd className="font-mono text-xs">{open.action}</dd>
                <dt className="text-muted-foreground">By</dt>
                <dd>{open.author ?? "unknown"}</dd>
              </dl>
              <section aria-label="Details">
                <h3 className="mb-1 font-medium">Details</h3>
                <pre className="overflow-x-auto border bg-muted/40 p-2 font-mono text-xs">
                  {formatLiteral(open.metadata, "  ")}
                </pre>
              </section>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

// The History screen (UI-01 §14.5, STUDY-12 §8): the deployment's audit log, newest first, between two days
// and for one action if asked; an event's details beside the list. Live: new events come in as recorded.
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { infiniteQueryOptions, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useQueryScope } from "../context.tsx";
import { useWatch } from "../data/live.ts";
import { capabilitiesQuery, dashboardKeys, type QueryScope } from "../data/queries.ts";
import { type AuditEvent, type AuditEventQuery, toDataSourceError } from "../data-source.ts";
import { formatLiteral } from "../database/literal.ts";
import { formatTime } from "../database/values.ts";
import { type HistorySearch, historyRoute } from "../router.tsx";
import { DayInput, dayBound } from "../shell/day-input.tsx";
import { ErrorState } from "../shell/error-state.tsx";
import { NotOffered } from "../shell/not-offered.tsx";
import { Panel } from "../shell/panel.tsx";
import { ACTION_LABELS, describeEvent } from "./describe.ts";

const PAGE = 50;
const ALL = "*";
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

function History() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const search = historyRoute.useSearch();
  const navigate = historyRoute.useNavigate();
  const setSearch = (patch: Partial<HistorySearch>, replace = false) =>
    navigate({ search: (s: HistorySearch): HistorySearch => ({ ...s, ...patch }), replace });
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const allowed = caps?.operations.includes("viewAuditLog") ?? true;
  const filter: Filter = {
    from: dayBound(search.from, false),
    to: dayBound(search.to, true),
    actions: search.action ? [search.action] : undefined,
  };
  const list = useInfiniteQuery({ ...eventsQuery(scope, filter), enabled: allowed });
  const liveError = useWatch<void>(
    (onChange, onError) => scope.source.watchAuditEvents?.(onChange, onError) ?? (() => {}),
    () => void queryClient.invalidateQueries({ queryKey: historyKey(scope.scope) }),
    [scope.source, scope.scope],
  );
  const events = list.data?.pages.flatMap((p) => p.page) ?? [];
  const open = search.event === undefined ? undefined : (events.find((e) => e.id === search.event) ?? null);
  const actionId = useId();

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
    // full-bleed inside <main>: the details panel runs to its edges
    <div className="-m-4 flex min-h-[calc(100svh-3rem)] md:-m-6">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-6">
        <h1 className="text-xl font-semibold tracking-tight">History</h1>
        {!allowed ? (
          <p className="text-sm text-muted-foreground">This credential cannot view the audit log.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span id={actionId} className="text-sm text-muted-foreground">
                  Action
                </span>
                <Select
                  items={[
                    { value: ALL, label: "All actions" },
                    ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
                  ]}
                  value={search.action ?? ALL}
                  onValueChange={(v) => setSearch({ action: v === ALL ? undefined : (v as string), event: undefined })}
                >
                  <SelectTrigger aria-labelledby={actionId} className="h-8 min-w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All actions</SelectItem>
                    {Object.entries(ACTION_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DayInput label="From" value={search.from} onChange={(v) => setSearch({ from: v }, true)} />
              <DayInput label="Until" value={search.to} onChange={(v) => setSearch({ to: v }, true)} />
            </div>
            {liveError && <ErrorState error={liveError} />}
            {list.error ? (
              <ErrorState error={toDataSourceError(list.error)} />
            ) : (
              <DataTable
                label="Audit log"
                className="max-h-[calc(100svh-14rem)]"
                columns={columns}
                data={events}
                getRowId={(e) => e.id}
                defaultColumnWidth={(id) => ({ time: 190, what: 420, author: 140 })[id] ?? 160}
                onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
                grid={{ activateOnClick: true, onCellActivate: (e) => setSearch({ event: e.id }) }}
                empty={
                  list.isPending
                    ? "Loading…"
                    : search.action || search.from || search.to
                      ? "Nothing matches these filters."
                      : "Nothing has been recorded yet. Changes made from the dashboard and deploys appear here."
                }
                footer={<span aria-live="polite">{`${events.length}${list.hasNextPage ? "+" : ""} events`}</span>}
              />
            )}
          </>
        )}
      </div>
      {open !== undefined && (
        <Panel title="Event" onClose={() => setSearch({ event: undefined })}>
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

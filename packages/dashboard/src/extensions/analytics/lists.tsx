// Analytics → Events, Sessions, Profiles (UI-01 §26.2): full-bleed grids (newest first, paged as they scroll),
// a search in Bar 2, and the docked panel with the selected row's details and its raw form (a literal).
// Events can be narrowed to one event name from the section column.
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { clientLine } from "../../clients/words.tsx";
import { useQueryScope } from "../../context.tsx";
import { toDataSourceError, type Value } from "../../data-source.ts";
import { LiteralView } from "../../database/literal-view.tsx";
import { formatTime } from "../../database/values.ts";
import { formatCount } from "../../screens/stats.ts";
import { BAR1, BAR2 } from "../../shell/bars.ts";
import { ErrorState } from "../../shell/error-state.tsx";
import { Panel } from "../../shell/panel.tsx";
import type { AnalyticsEvent, AnalyticsProfile, AnalyticsSession } from "./data-source.ts";
import { type AnalyticsList, analyticsListQuery } from "./queries.ts";

const mono = (v: string | number) => <span className="font-mono text-xs tabular-nums">{v}</span>;
const time = (t: number) => mono(formatTime(t));

const ev = dataTableColumns<AnalyticsEvent>();
const EVENT_COLUMNS: DataTableColumn<AnalyticsEvent>[] = [
  ev.accessor((e) => e.time, { id: "time", header: "Time", cell: (c) => time(c.getValue()) }),
  ev.accessor((e) => e.name, { id: "name", header: "Event", cell: (c) => mono(c.getValue()) }),
  ev.accessor((e) => e.path, { id: "path", header: "Path", cell: (c) => mono(c.getValue()) }),
  ev.accessor((e) => [e.city, e.country].filter(Boolean).join(", "), { id: "place", header: "Place" }),
  ev.accessor((e) => `${e.browser}, ${e.device}`, { id: "device", header: "Device" }),
  ev.accessor((e) => e.referrer ?? "(direct)", { id: "referrer", header: "Referrer" }),
];

const se = dataTableColumns<AnalyticsSession>();
const SESSION_COLUMNS: DataTableColumn<AnalyticsSession>[] = [
  se.accessor((s) => s.lastSeen, { id: "lastSeen", header: "Last seen", cell: (c) => time(c.getValue()) }),
  se.accessor((s) => s.live, {
    id: "live",
    header: "Live",
    cell: (c) => (c.getValue() ? <span className="text-xs text-success">● live</span> : null),
  }),
  se.accessor((s) => [s.city, s.country].filter(Boolean).join(", "), { id: "place", header: "Place" }),
  // what the client said, when it did (UI-01 §33): "iPhone 16 · iOS 19.1 · com.acme.shop 2.3.1"
  se.accessor((s) => (s.client ? clientLine(s.client) : `${s.browser} on ${s.os}`), { id: "device", header: "Device" }),
  se.accessor((s) => s.pageViews, { id: "views", header: "Page views", cell: (c) => mono(c.getValue()) }),
  se.accessor((s) => s.entryPath, { id: "entry", header: "Entry", cell: (c) => mono(c.getValue()) }),
  se.accessor((s) => s.referrer ?? "(direct)", { id: "referrer", header: "Referrer" }),
];

const pr = dataTableColumns<AnalyticsProfile>();
const PROFILE_COLUMNS: DataTableColumn<AnalyticsProfile>[] = [
  pr.accessor((p) => p.name ?? "Anonymous", { id: "name", header: "Profile" }),
  pr.accessor((p) => p.email ?? "", { id: "email", header: "Email", cell: (c) => mono(c.getValue()) }),
  pr.accessor((p) => p.lastSeen, { id: "lastSeen", header: "Last seen", cell: (c) => time(c.getValue()) }),
  pr.accessor((p) => p.sessions, { id: "sessions", header: "Sessions", cell: (c) => mono(c.getValue()) }),
  pr.accessor((p) => p.events, { id: "events", header: "Events", cell: (c) => mono(c.getValue()) }),
  pr.accessor((p) => p.country, { id: "country", header: "Country" }),
];

const TITLES: Record<AnalyticsList, { noun: string; plural: string }> = {
  events: { noun: "event", plural: "events" },
  sessions: { noun: "session", plural: "sessions" },
  profiles: { noun: "profile", plural: "profiles" },
};

type Row = AnalyticsEvent | AnalyticsSession | AnalyticsProfile;

function Details({ row, list }: { row: Row; list: AnalyticsList }) {
  const fields: [string, ReactNode][] =
    list === "events"
      ? [
          ["Time", formatTime((row as AnalyticsEvent).time)],
          ["Event", (row as AnalyticsEvent).name],
          ["Session", (row as AnalyticsEvent).sessionId],
          ["Profile", (row as AnalyticsEvent).profileId ?? "Anonymous"],
        ]
      : list === "sessions"
        ? [
            ["Started", formatTime((row as AnalyticsSession).startedAt)],
            ["Last seen", formatTime((row as AnalyticsSession).lastSeen)],
            ["Events", formatCount((row as AnalyticsSession).events)],
            ["Exit", (row as AnalyticsSession).exitPath],
          ]
        : [
            ["First seen", formatTime((row as AnalyticsProfile).firstSeen)],
            ["Last seen", formatTime((row as AnalyticsProfile).lastSeen)],
            ["Sessions", formatCount((row as AnalyticsProfile).sessions)],
            ["Events", formatCount((row as AnalyticsProfile).events)],
          ];
  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {fields.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="truncate font-mono text-xs leading-5">{v}</dd>
          </div>
        ))}
      </dl>
      <section aria-label="Raw">
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Raw</h3>
        <LiteralView value={row as unknown as Value} label={`The ${TITLES[list].noun}, as stored`} />
      </section>
    </div>
  );
}

export function ListPage(props: { list: AnalyticsList; heading: ReactNode; name?: string }) {
  const scope = useQueryScope();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Row | null>(null);
  const query = useInfiniteQuery(analyticsListQuery(scope, props.list, q.trim(), props.name));
  const rows = (query.data?.pages.flatMap((p) => p.page) ?? []) as Row[];
  const t = TITLES[props.list];
  const columns = (
    props.list === "events" ? EVENT_COLUMNS : props.list === "sessions" ? SESSION_COLUMNS : PROFILE_COLUMNS
  ) as DataTableColumn<Row>[];
  const idOf = (r: Row) => ("id" in r ? r.id : "");
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={BAR1}>
          {props.heading}
          {query.data && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatCount(rows.length)} {rows.length === 1 ? t.noun : t.plural}
              {query.hasNextPage ? " loaded" : ""}
            </span>
          )}
        </div>
        <div className={BAR2}>
          <Input
            aria-label={`Search ${t.plural}`}
            type="search"
            placeholder={props.list === "profiles" ? "Search by name or email…" : "Search by path, place or name…"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 w-72 max-w-full"
          />
        </div>
        {query.error ? (
          <ErrorState error={toDataSourceError(query.error)} />
        ) : (
          <DataTable
            label={`Analytics ${t.plural}`}
            fill
            columns={columns}
            data={rows}
            getRowId={idOf}
            grid={{
              activateOnClick: true,
              onCellActivate: (row) => setOpen(row),
              // the panel follows the current row (arrows, clicks) once it is open, as Database's does
              onCellFocus: (row) => setOpen((was) => (was ? row : was)),
            }}
            onEndReached={() => query.hasNextPage && !query.isFetchingNextPage && void query.fetchNextPage()}
            defaultColumnWidth={(id) =>
              ({ time: 170, lastSeen: 170, name: 180, path: 220, entry: 200, email: 240 })[id] ?? 150
            }
            empty={query.isPending ? "Loading…" : q ? `No ${t.noun} matches “${q}”.` : `No ${t.plural} yet.`}
          />
        )}
      </div>
      {open && (
        <Panel
          kind={`analytics-${props.list}`}
          title={<span className="font-mono text-sm">{idOf(open)}</span>}
          onClose={() => setOpen(null)}
        >
          <Details row={open} list={props.list} />
        </Panel>
      )}
    </div>
  );
}

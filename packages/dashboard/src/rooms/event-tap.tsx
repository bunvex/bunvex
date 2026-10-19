// A room's event tap (AD-43 step 5, STUDY-166): the events that pass through the room from the moment the panel
// opens, as a new member would see them, followed with `watchRoomEvents` while the panel is open and stopped when
// it closes. Laid out as the Logs screen's lines — newest first, time with milliseconds, a bar with Live / Resume
// (with how many wait), a filter and Clear — with seq, event, sender, size and data, a notice row where events
// were dropped or missed, and the chosen event's data in full below. `onError` is terminal (said, with the tap
// over); `onClosed` is the room closing (the list is asked at once, so the panel says so).
import { Button } from "@bunvex/ui/components/button";
import { DataTable, type DataTableColumn, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { cn } from "@bunvex/ui/lib/utils";
import { Eraser, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryScope } from "../context.tsx";
import type { DataSourceError, RoomInfo } from "../data-source.ts";
import { LiteralView } from "../database/literal-view.tsx";
import { formatBytes, formatCount } from "../screens/stats.ts";
import { formatLogTime } from "../shell/time.tsx";
import {
  emptyTap,
  noticeText,
  OMITTED,
  type Tap,
  type TapRow,
  tapBatch,
  tapCleared,
  tapFiltered,
  tapPaused,
  tapWaiting,
} from "./tap.ts";
import { shortValue } from "./words.ts";

type TapState = { state: "live" } | { state: "closed" } | { state: "error"; error: DataSourceError };

const col = dataTableColumns<TapRow>();
const notice = (r: TapRow) => r.kind !== "event";

const columns: DataTableColumn<TapRow>[] = [
  col.accessor((r) => (r.kind === "event" ? r.event.seq : null), {
    id: "seq",
    header: "Seq",
    cell: (c) => <span className="block text-right font-mono text-xs tabular-nums">{c.getValue() ?? "—"}</span>,
  }),
  col.accessor((r) => (r.kind === "event" ? r.event.at : r.at), {
    id: "time",
    header: "Time",
    cell: (c) => <span className="font-mono text-xs tabular-nums">{formatLogTime(c.getValue())}</span>,
  }),
  col.accessor((r) => (r.kind === "event" ? r.event.event : r.kind === "gap" ? "gap" : "dropped"), {
    id: "event",
    header: "Event",
    cell: (c) => (
      <span className={cn("font-mono text-xs", notice(c.row.original) && "text-warning uppercase")}>
        {c.getValue()}
      </span>
    ),
  }),
  col.accessor((r) => (r.kind === "event" ? r.event.from : undefined), {
    id: "from",
    header: "From",
    cell: (c) => {
      const from = c.getValue();
      if (from === undefined) return null;
      return from === null ? (
        <span className="text-xs text-muted-foreground">server</span>
      ) : (
        <span className="font-mono text-xs" title={from}>
          {from}
        </span>
      );
    },
  }),
  col.accessor((r) => (r.kind === "event" ? r.event.size : null), {
    id: "size",
    header: "Size",
    cell: (c) => {
      const size = c.getValue();
      return size === null ? null : (
        <span className="block text-right text-xs tabular-nums" title={`${formatCount(size)} bytes`}>
          {formatBytes(size)}
        </span>
      );
    },
  }),
  col.accessor((r) => r, {
    id: "data",
    header: "Data",
    cell: (c) => {
      const r = c.getValue();
      if (r.kind !== "event") return <span className="text-xs text-warning">{noticeText(r)}</span>;
      if (r.event.dataOmitted) return <span className="text-xs text-muted-foreground italic">{OMITTED}</span>;
      return <span className="font-mono text-xs text-muted-foreground">{shortValue(r.event.data, 120)}</span>;
    },
  }),
];

const WIDTHS: Record<string, number> = { seq: 56, time: 112, event: 96, from: 96, size: 72, data: 360 };

/** Follows a room's events while mounted; `closed`: the list says the room closed, so nothing is followed. */
export function EventTap({ room, closed, onClosed }: { room: RoomInfo; closed: boolean; onClosed: () => void }) {
  const { source, scope } = useQueryScope();
  const [tap, setTap] = useState<Tap>(emptyTap);
  const [status, setStatus] = useState<TapState>({ state: "live" });
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<number>();
  // the callback the room closing calls, current without following again
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `scope` names the deployment the source talks to
  useEffect(() => {
    if (closed || typeof source.watchRoomEvents !== "function") return;
    setStatus({ state: "live" });
    let live = true;
    const off = source.watchRoomEvents(
      { key: room.key },
      (events, info) => live && setTap((t) => tapBatch(t, events, info, Date.now())),
      (error) => {
        if (!live) return;
        live = false;
        setStatus({ state: "error", error });
      },
      () => {
        if (!live) return;
        live = false;
        setStatus({ state: "closed" });
        closedRef.current();
      },
    );
    return () => {
      live = false;
      off();
    };
  }, [source, scope, room.key, closed]);

  if (typeof source.watchRoomEvents !== "function") return null;
  const rows = tapFiltered(tap.rows, filter);
  const events = tap.rows.filter((r) => r.kind === "event").length;
  const shownEvents = rows.filter((r) => r.kind === "event").length;
  const waiting = tapWaiting(tap);
  const over = closed || status.state !== "live";
  const picked = tap.rows.find((r) => r.id === chosen);
  const count =
    filter.trim() === ""
      ? `${formatCount(events)} ${events === 1 ? "event" : "events"}`
      : `${formatCount(shownEvents)} of ${formatCount(events)} events`;

  return (
    <section aria-label="Events" className="flex flex-col gap-2">
      <h3 className="font-medium">Events</h3>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Input
          type="search"
          aria-label="Filter events by name"
          placeholder="Filter by event…"
          className="h-7 w-36 min-w-0 flex-1"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums" aria-live="polite">
          {count}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!over && (
            <Button
              variant="outline"
              size="sm"
              title={tap.paused ? "Show new events as they arrive" : "Stop new events from arriving"}
              onClick={() => setTap((t) => tapPaused(t, !t.paused))}
            >
              {tap.paused ? (
                <Play aria-hidden="true" />
              ) : (
                <span aria-hidden="true" className="relative mx-0.5 flex size-2">
                  <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-2 rounded-full bg-success" />
                </span>
              )}
              {tap.paused ? (waiting > 0 ? `Resume (${waiting} new)` : "Resume") : "Live"}
              {!tap.paused && (
                <>
                  <span className="sr-only">: pause</span>
                  <Pause aria-hidden="true" className="text-muted-foreground" />
                </>
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={tap.rows.length === 0}
            onClick={() => {
              setTap(tapCleared);
              setChosen(undefined);
            }}
            title="Hide the events shown so far"
          >
            <Eraser aria-hidden="true" />
            Clear
          </Button>
        </span>
      </div>
      <TapStatus status={status} closed={closed} paused={tap.paused} />
      <DataTable
        label="Room events"
        className="max-h-80"
        columns={columns}
        data={rows}
        getRowId={(r) => String(r.id)}
        initialHeight={320}
        stickyColumn="time"
        defaultColumnWidth={(id) => WIDTHS[id] ?? 100}
        grid={{
          activateOnClick: true,
          onCellActivate: (r) => r.kind === "event" && setChosen(r.id),
        }}
        empty={
          tap.rows.length > 0
            ? `No event named like "${filter.trim()}".`
            : over
              ? "No event passed through it while the tap was on."
              : "Waiting for events. Only events sent from now on are shown, as a new member would see them."
        }
      />
      {picked?.kind === "event" && (
        <article aria-label={`Event ${picked.event.seq}`} className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{picked.event.event}</span> #{picked.event.seq} from{" "}
            {picked.event.from === null ? "the server" : <span className="font-mono">{picked.event.from}</span>} ·{" "}
            {formatCount(picked.event.size)} bytes
          </p>
          {picked.event.dataOmitted ? (
            <p className="border bg-muted/40 p-2 text-xs text-muted-foreground">
              The data was not kept: its {formatCount(picked.event.size)} bytes of JSON are over the tap's 16 KiB. The
              members received it.
            </p>
          ) : (
            <LiteralView value={picked.event.data} label={`Data of event ${picked.event.seq}`} />
          )}
        </article>
      )}
    </section>
  );
}

function TapStatus({ status, closed, paused }: { status: TapState; closed: boolean; paused: boolean }) {
  if (status.state === "error")
    return (
      <p role="alert" className="text-xs text-destructive">
        The tap stopped: {status.error.message}
      </p>
    );
  if (closed || status.state === "closed")
    return <p className="text-xs text-muted-foreground">The room closed: the tap ended.</p>;
  if (paused) return <p className="text-xs text-muted-foreground">Paused. Resume to see new events.</p>;
  return null;
}

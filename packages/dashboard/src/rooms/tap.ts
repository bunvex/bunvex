// The event tap's rows (AD-43 step 5, STUDY-166): what `watchRoomEvents` delivers, kept newest first as the Logs
// screen keeps its lines, with a notice in the stream where events were dropped (the tap's buffer overflowed) or
// the source lost track (a gap: seq starts again, so rows are told apart by an id of their own, never by seq).
// Paused, new rows wait and are counted; resuming shows them; clearing hides what is shown. Pure, so it is tested
// without a DOM.
import type { RoomEvent, RoomEventsInfo } from "../data-source.ts";

/** The most rows kept: the oldest go first beyond it. */
export const TAP_ROWS_MAX = 1_000;
/** The server's tap omits an event's data above this (`RoomEvent.dataOmitted`). */
export const TAP_DATA_MAX_BYTES = 16 * 1024;
/** The server's tap buffer (events between two polls), for the dropped notice's words. */
export const TAP_BUFFER_EVENTS = 200;

export type TapRow =
  | { id: number; kind: "event"; event: RoomEvent }
  | { id: number; kind: "dropped"; count: number; at: number }
  | { id: number; kind: "gap"; at: number };

export type Tap = {
  /** Shown, newest first. */
  rows: TapRow[];
  /** Arrived while paused, newest first. */
  held: TapRow[];
  paused: boolean;
  nextId: number;
};

export const emptyTap: Tap = { rows: [], held: [], paused: false, nextId: 1 };

const cap = (rows: TapRow[]) => (rows.length > TAP_ROWS_MAX ? rows.slice(0, TAP_ROWS_MAX) : rows);

/**
 * A batch in: its notices first (what was dropped or missed came before these events), then its events in seq
 * order, all put on top (newest first). `now` stamps a notice.
 */
export function tapBatch(tap: Tap, events: readonly RoomEvent[], info: RoomEventsInfo, now: number): Tap {
  let id = tap.nextId;
  const added: TapRow[] = [];
  if (info.gap) added.push({ id: id++, kind: "gap", at: now });
  if (info.dropped > 0) added.push({ id: id++, kind: "dropped", count: info.dropped, at: now });
  for (const event of events) added.push({ id: id++, kind: "event", event });
  if (added.length === 0) return tap;
  added.reverse();
  return tap.paused
    ? { ...tap, held: cap([...added, ...tap.held]), nextId: id }
    : { ...tap, rows: cap([...added, ...tap.rows]), nextId: id };
}

/** Pause (new rows wait) or resume (they are shown). */
export function tapPaused(tap: Tap, paused: boolean): Tap {
  if (paused) return { ...tap, paused };
  return { ...tap, paused, rows: cap([...tap.held, ...tap.rows]), held: [] };
}

/** Hides what is shown; what waits while paused stays waiting. */
export const tapCleared = (tap: Tap): Tap => ({ ...tap, rows: [] });

/** How many events wait while paused (notices are not counted). */
export const tapWaiting = (tap: Tap) => tap.held.filter((r) => r.kind === "event").length;

/** The rows whose event name holds `text` (case-insensitive); notices always stay, they say what is missing. */
export function tapFiltered(rows: readonly TapRow[], text: string): TapRow[] {
  const t = text.trim().toLowerCase();
  if (t === "") return [...rows];
  return rows.filter((r) => r.kind !== "event" || r.event.event.toLowerCase().includes(t));
}

/** A notice in words. */
export function noticeText(row: Exclude<TapRow, { kind: "event" }>): string {
  return row.kind === "dropped"
    ? `Dropped ${row.count} ${row.count === 1 ? "event" : "events"}: more than ${TAP_BUFFER_EVENTS} arrived between two reads.`
    : "Gap: the tap lost track (it expired, the server restarted, or the connection failed). Events may be missing here, and seq starts again.";
}

/** What an event's data cell says when the data was omitted. */
export const OMITTED = "Omitted: over 16 KiB";

// The rooms and presence scopes in the dashboard contract (AD-43, STUDY-165) — a bunvex addition: Convex has no
// rooms. What the hub keeps in memory (STUDY-164 §3.5), read once per call and polled by the Rooms screen. Every
// method is optional — a source offers the screen by having them (detected with `typeof`) — and needs the
// `viewMetrics` operation. Re-exported by `data-source.ts`.
import type {
  CallOptions,
  DataSourceError,
  Page,
  PageRequest,
  Unsubscribe,
  ValidatorJson,
  Value,
} from "./data-source.ts";

/** `room`: a room a client joins by its function and arguments; `presence`: the scope of a signed-in user's state. */
export type RoomKind = "room" | "presence";

/**
 * An open room or presence scope. A room missing from the next `listRooms` has closed (the last member left): the
 * screen shows "closed", not an error.
 */
export type RoomInfo = {
  /** Stable while the room is open; what `listRoomMembers` takes. */
  key: string;
  kind: RoomKind;
  /** The room function's path, e.g. `rooms:doc`. */
  name: string;
  /** The arguments the room was joined with: one room per distinct arguments. */
  args: Value;
  members: number;
  /** Connections of those members, the ones in their reconnect grace included. */
  connections: number;
  /** Wall-clock ms the room opened (its first member joined). */
  openedAt: number;
};

/** The room a members page is asked for: a `RoomInfo.key`. */
export type RoomRef = { key: string };

export type RoomMember = {
  memberId: string;
  /** The signed-in user; `null` for an anonymous member of a room (a scope has none). */
  userId: string | null;
  /** The member's presence as it last said; `null` before it said any. */
  presence: Value | null;
  /** Scopes only: the user marked themself idle. */
  idle?: boolean;
  canPublish: boolean;
  /** Every connection of the member dropped and the member is held for its reconnect grace. */
  graced: boolean;
  connections: number;
  /** Wall-clock ms. */
  joinedAt: number;
  lastActivityAt: number;
};

/** A room or scope the deployment defines, with its validators in Convex's JSON form. */
export type RoomDefinition = {
  kind: RoomKind;
  name: string;
  module: string;
  /** `null`: the room takes no arguments. */
  args: ValidatorJson | null;
  /** Rooms: each member's presence. */
  presence?: ValidatorJson | null;
  /** Scopes: a user's state. */
  state?: ValidatorJson | null;
  events: { name: string; payload: ValidatorJson | null }[];
};

/**
 * The rooms' counters. `rooms`, `members` and `connections` are gauges (now); every other field is a monotonic
 * counter since the server started: diff two samples for a rate.
 */
export type RoomStats = {
  rooms: number;
  members: number;
  connections: number;
  joins: number;
  joinsRefusedByGate: number;
  joinsRefusedByLimit: number;
  leaves: number;
  graceExpiries: number;
  presenceAccepted: number;
  presenceDropped: number;
  eventsAccepted: number;
  eventsDropped: number;
  resyncs: number;
  roomLeft: number;
};

/**
 * One event that passed through a room, as the event tap saw it: sent by a member, or by the server
 * (`ctx.rooms.broadcast`). Presence changes are not events (the members list shows them).
 */
export type RoomEvent = {
  /**
   * Per tap, increasing by one. A tap starts again at 0 whenever it is created: its first poll, after it expired
   * (30 s without a poll), after the server restarted. Each tap also has an epoch (an id made with it) in every
   * answer, so a tap made again is told apart even when its seq has passed the follower's cursor. The source turns
   * any such restart into `gap: true`, so the screen never compares seqs across a gap.
   */
  seq: number;
  /** Wall-clock ms the server saw it. */
  at: number;
  event: string;
  /** The sender's memberId; `null` for the server. */
  from: string | null;
  /** Bytes of the data's JSON (the real size, also when the data is omitted). */
  size: number;
  /** The data in the wire's form; `null` when omitted. */
  data: Value;
  /** The data was over the tap's cap (16 KiB of JSON): `data` is `null`, `size` is the real one. */
  dataOmitted?: true;
};

/**
 * What `watchRoomEvents` says beside a batch. `dropped`: events lost since the batch before, because the tap's buffer
 * (200 events) overflowed between two polls (0 otherwise). `gap`: the source lost track and cannot count what was
 * missed — the tap expired or the server restarted (its seq started again at 0, or its epoch changed), or a transient
 * error was retried.
 */
export type RoomEventsInfo = { dropped: number; gap: boolean };

/**
 * A source offers the Rooms screen by having `listRooms`. A deployment without rooms rejects all three methods with
 * a `DataSourceError` of code `not_found` ("This deployment does not run rooms."): the screen shows an empty state,
 * not an error. A malformed `RoomRef.key` is `invalid_request`.
 */
export interface RoomsFeatures {
  /** The open rooms and scopes, by name, then key. Rejects `not_found` on a deployment without rooms. */
  listRooms?(opts?: CallOptions): Promise<RoomInfo[]>;
  /**
   * One page of a room's members by `memberId`; `numItems` is capped at 100. A room that is not open (closed since
   * the list) is an empty, done page. The cursor is the last member returned, `""` when done. A `numItems` that is
   * not a number asks for the default (100). Rejects `not_found` on a deployment without rooms.
   */
  listRoomMembers?(room: RoomRef, page: PageRequest, opts?: CallOptions): Promise<Page<RoomMember>>;
  /** The rooms and scopes the deployed code defines, by name. Rejects `not_found` on a deployment without rooms. */
  listRoomDefinitions?(opts?: CallOptions): Promise<RoomDefinition[]>;
  /**
   * Live tail of a room's events from now on (none from before the call), in seq order. Never synchronously. The tap
   * starts when the source's first request reaches the deployment: an event sent while that request is on its way may
   * be missed.
   *
   * - `onEvents(events, info)`: a batch; `info.dropped` counts events lost to the tap's 200-event buffer since the
   *   batch before, `info.gap` says the source lost track (`RoomEventsInfo`). A batch may be empty when it only
   *   carries a gap. `RoomEvent.seq` is per tap and starts again at 0 after a gap.
   * - Transient failures (the network, a 5xx, a server restart) are retried on their own, with a backoff: after
   *   recovering, the tap starts again (none of what passed meanwhile), and the first batch carries `gap: true`.
   * - `onError` only for a terminal error — `not_found` on a deployment without rooms, `unauthorized`, or
   *   `invalid_request` for a malformed key — and then no more calls.
   * - `onClosed` when the room is not open (the last member left), and then no more calls. Just after a recovery, a
   *   room found closed is asked again (every second) for 10 s from the first answer that found it so: a server that
   *   restarted has it again only once its members have reconnected.
   * - An exception thrown by `onEvents` or `onClosed` is the consumer's: it ends the tap and surfaces, it is not
   *   retried as a failure.
   *
   * The returned function stops it: no calls after it.
   */
  watchRoomEvents?(
    room: RoomRef,
    onEvents: (events: RoomEvent[], info: RoomEventsInfo) => void,
    onError: (error: DataSourceError) => void,
    onClosed?: () => void,
  ): Unsubscribe;
}

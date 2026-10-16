// The rooms and presence scopes in the dashboard contract (AD-43, STUDY-165) — a bunvex addition: Convex has no
// rooms. What the hub keeps in memory (STUDY-164 §3.5), read once per call and polled by the Rooms screen. Every
// method is optional — a source offers the screen by having them (detected with `typeof`) — and needs the
// `viewMetrics` operation. Re-exported by `data-source.ts`.
import type { CallOptions, Page, PageRequest, ValidatorJson, Value } from "./data-source.ts";

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

export interface RoomsFeatures {
  /** The open rooms and scopes, by name, then key. */
  listRooms?(opts?: CallOptions): Promise<RoomInfo[]>;
  /**
   * One page of a room's members by `memberId`; `numItems` is capped at 100. A room that is not open (closed since
   * the list) is an empty, done page. The cursor is the last member returned, `""` when done.
   */
  listRoomMembers?(room: RoomRef, page: PageRequest, opts?: CallOptions): Promise<Page<RoomMember>>;
  /** The rooms and scopes the deployed code defines, by name. */
  listRoomDefinitions?(opts?: CallOptions): Promise<RoomDefinition[]>;
}

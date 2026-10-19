// What the Rooms screen (AD-43, STUDY-165 §5.1) derives from the rooms it is given: the order, the filter by
// definition, a room's args on one line, the summary over the list, and whether the room a panel shows has closed.
// Pure, so it is tested without a DOM.

import type { RoomInfo, RoomKind, Value } from "../data-source.ts";
import { formatLiteral } from "../database/literal.ts";
import { formatCount } from "../screens/stats.ts";

/** How often the rooms, a room's members and their counters are asked again while shown (STUDY-165 D5). */
export const ROOMS_POLL_MS = 1_000;

/** How long a room's args stay on one line before they are shortened. */
export const ARGS_CHARS = 80;

export const KIND_LABEL: Record<RoomKind, string> = { room: "Room", presence: "Presence scope" };

/** A value as the dashboard writes it (`{ id: "a" }`), on one line, shortened past `max` characters. */
export function shortValue(v: Value, max = ARGS_CHARS): string {
  const text = formatLiteral(v);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The definitions' names the list holds, each once, in its order (by name). */
export const roomNames = (rooms: readonly RoomInfo[]) => [...new Set(rooms.map((r) => r.name))];

/**
 * The rooms one definition holds (all of them without `name`), by name then args (the order the source lists them
 * in, by name then key, whose last part is the args), or by members (the most first, then by name and args).
 */
export function shownRooms(rooms: readonly RoomInfo[], name: string | undefined, by: "name" | "members"): RoomInfo[] {
  const kept = name === undefined ? [...rooms] : rooms.filter((r) => r.name === name);
  return by === "members" ? kept.sort((a, b) => b.members - a.members) : kept;
}

/** "2 open (1 room, 1 presence scope) · 8 members · 9 connections". */
export function roomsSummary(rooms: readonly RoomInfo[]): string {
  const rooms_ = rooms.filter((r) => r.kind === "room").length;
  const scopes = rooms.length - rooms_;
  const members = rooms.reduce((n, r) => n + r.members, 0);
  const connections = rooms.reduce((n, r) => n + r.connections, 0);
  const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;
  return `${formatCount(rooms.length)} open (${plural(rooms_, "room")}, ${plural(scopes, "presence scope")}) · ${plural(members, "member")} · ${plural(connections, "connection")}`;
}

/**
 * The room a panel shows, from the latest list: `open` while it is in it, `closed` once a list that came after
 * it was seen no longer holds it (its last member left — never an error), `unknown` when it was never seen (a
 * link to a room that closed before the screen opened). `seen` is the room as last listed, kept by the screen.
 */
export type OpenedRoom =
  | { state: "open"; room: RoomInfo }
  | { state: "closed"; room: RoomInfo }
  | { state: "unknown"; key: string };

export function openedRoom(key: string, list: readonly RoomInfo[], seen: RoomInfo | undefined): OpenedRoom {
  const room = list.find((r) => r.key === key);
  if (room) return { state: "open", room };
  return seen?.key === key ? { state: "closed", room: seen } : { state: "unknown", key };
}

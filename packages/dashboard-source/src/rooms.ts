// The rooms and presence scopes (AD-43, STUDY-165) over the server's admin routes, with the admin key
// (ViewMetrics): `GET /api/debug/rooms`, `/api/debug/rooms/members` (a page at a time, the key and the cursor passed
// through) and `/api/debug/rooms/definitions`, read once per call; the Rooms screen polls them. The server's JSON
// carries values (a room's arguments, a member's presence) in the wire's form, which is the contract's `Value`
// (`$integer` and `$bytes` for what JSON cannot carry), so they pass as they are. A server without rooms answers 404:
// the methods say so with `not_found`, which the screen shows as "this deployment does not run rooms".
import {
  type CallOptions,
  DataSourceError,
  type Page,
  type PageRequest,
  type RoomDefinition,
  type RoomInfo,
  type RoomMember,
  type RoomRef,
  type RoomStats,
} from "@bunvex/dashboard/data-source";
import { type AdminHttp, ResponseError } from "./admin-http.ts";

/** The most members one request asks for: the server's page cap. */
export const ROOM_MEMBERS_PAGE_MAX = 100;

/** The counters in `/stats`' `rooms`, as the contract's: the same fields, copied. */
export function roomStatsOf(s: RoomStats): RoomStats {
  return {
    rooms: s.rooms,
    members: s.members,
    connections: s.connections,
    joins: s.joins,
    joinsRefusedByGate: s.joinsRefusedByGate,
    joinsRefusedByLimit: s.joinsRefusedByLimit,
    leaves: s.leaves,
    graceExpiries: s.graceExpiries,
    presenceAccepted: s.presenceAccepted,
    presenceDropped: s.presenceDropped,
    eventsAccepted: s.eventsAccepted,
    eventsDropped: s.eventsDropped,
    resyncs: s.resyncs,
    roomLeft: s.roomLeft,
  };
}

/** A server that has no rooms routes answers 404 to them. */
async function orNoRooms<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (e) {
    if (e instanceof ResponseError && e.status === 404)
      throw new DataSourceError("not_found", "This deployment does not run rooms.");
    throw e;
  }
}

export function roomsReads(http: AdminHttp) {
  return {
    async listRooms(o?: CallOptions): Promise<RoomInfo[]> {
      const { rooms } = await orNoRooms(http.json<{ rooms: RoomInfo[] }>("/api/debug/rooms", { signal: o?.signal }));
      return rooms.map((r) => ({
        key: r.key,
        kind: r.kind,
        name: r.name,
        args: r.args,
        members: r.members,
        connections: r.connections,
        openedAt: r.openedAt,
      }));
    },
    async listRoomMembers(room: RoomRef, page: PageRequest, o?: CallOptions): Promise<Page<RoomMember>> {
      const q = new URLSearchParams({
        key: room.key,
        numItems: String(
          Number.isFinite(page.numItems)
            ? Math.max(1, Math.min(Math.floor(page.numItems), ROOM_MEMBERS_PAGE_MAX))
            : ROOM_MEMBERS_PAGE_MAX,
        ),
      });
      if (page.cursor) q.set("cursor", page.cursor);
      const res = await orNoRooms(http.json<Page<RoomMember>>(`/api/debug/rooms/members?${q}`, { signal: o?.signal }));
      return {
        page: res.page.map((m) => ({
          memberId: m.memberId,
          userId: m.userId,
          presence: m.presence,
          ...(m.idle !== undefined && { idle: m.idle }),
          canPublish: m.canPublish,
          graced: m.graced,
          connections: m.connections,
          joinedAt: m.joinedAt,
          lastActivityAt: m.lastActivityAt,
        })),
        isDone: res.isDone,
        continueCursor: res.continueCursor,
      };
    },
    async listRoomDefinitions(o?: CallOptions): Promise<RoomDefinition[]> {
      const { definitions } = await orNoRooms(
        http.json<{ definitions: RoomDefinition[] }>("/api/debug/rooms/definitions", { signal: o?.signal }),
      );
      return definitions;
    },
  };
}

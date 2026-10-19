// The rooms and presence scopes (AD-43, STUDY-165) over the server's admin routes, with the admin key
// (ViewMetrics): `GET /api/debug/rooms`, `/api/debug/rooms/members` (a page at a time, the key and the cursor passed
// through) and `/api/debug/rooms/definitions`, read once per call; the Rooms screen polls them. The server's JSON
// carries values (a room's arguments, a member's presence) in the wire's form, which is the contract's `Value`
// (`$integer` and `$bytes` for what JSON cannot carry), so they pass as they are. A server without rooms answers 404:
// the methods say so with `not_found`, which the screen shows as "this deployment does not run rooms".
//
// The actions (STUDY-165 §3.4) POST to `/api/debug/rooms/broadcast`, `/remove` and `/close` with the admin key; the
// server refuses a key that may not write (403, `unauthorized` here), and answers 404 `RoomNotOpen` to a broadcast
// to a room that is not open, which is `not_found` with its words (an older server's 404 is still "no rooms").
//
// The event tap, `/api/debug/rooms/events`, is followed as the inspector follows the invalidations (inspector.ts): a
// first request without a cursor starts the tap, then a long poll from each answer's `newCursor`. A transient failure
// (the network, a 5xx, a disconnection) is retried with a backoff and starts the tap again, the next batch saying
// `gap`; the server's `reset` (its tap expired, or it restarted) is a gap too. A terminal error ends it.
import {
  type CallOptions,
  type ConnectionStatus,
  DataSourceError,
  type Page,
  type PageRequest,
  type RoomClosed,
  type RoomDefinition,
  type RoomEvent,
  type RoomEventsInfo,
  type RoomInfo,
  type RoomMember,
  type RoomMemberRemoved,
  type RoomRef,
  type RoomStats,
  type Unsubscribe,
  type Value,
} from "@bunvex/dashboard/data-source";
import { type AdminHttp, ResponseError } from "./admin-http.ts";
import { type After, FOLLOW_MS } from "./inspector.ts";
import { backoffWithJitter } from "./logs.ts";

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

/** A server that has no rooms routes answers 404 to them (a room not open is a 404 of its own, kept as it is). */
async function orNoRooms<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (e) {
    if (e instanceof ResponseError && e.status === 404 && e.serverCode !== "RoomNotOpen")
      throw new DataSourceError("not_found", "This deployment does not run rooms.");
    throw e;
  }
}

export type RoomsOptions = {
  /** The deployment's connection status (the source's `watchConnection`); none: always connected. */
  connection?: (onStatus: (s: ConnectionStatus) => void) => Unsubscribe;
  /** For tests: the backoff between failures. Default: `backoffWithJitter`. */
  backoff?: (failures: number) => number;
  /** For tests: the loop's timers (its first tick and its back-offs). Default: `setTimeout`. */
  after?: After;
  /** How long one follow request may wait on the server, in ms. Default: the server's longest, 60 000. */
  followTimeoutMs?: number;
  /** For tests: the clock of `ROOM_CLOSED_RETRY_MS`. Default: `Date.now`. */
  now?: () => number;
};

/**
 * After a failure, how long a room found closed is asked again before `onClosed`: a server that restarted has the
 * room again only once its members have reconnected (within their reconnect grace).
 */
export const ROOM_CLOSED_RETRY_MS = 10_000;
/** The wait between two asks of a room found closed in that window. */
export const ROOM_CLOSED_RETRY_DELAY_MS = 1000;

/** The tap's answer, as the server sends it. */
type TapJson = {
  events: RoomEvent[];
  newCursor: number;
  epoch?: string;
  dropped?: number;
  reset?: true;
  closed?: true;
};

const afterTimeout: After = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const eventOf = (e: RoomEvent): RoomEvent => ({
  seq: e.seq,
  at: e.at,
  event: e.event,
  from: e.from,
  size: e.size,
  data: e.data,
  ...(e.dataOmitted === true && { dataOmitted: true }),
});

export function roomsReads(http: AdminHttp, opts: RoomsOptions = {}) {
  /** The taps running, each its stop. */
  const loops = new Set<() => void>();

  function watchRoomEvents(
    room: RoomRef,
    onEvents: (events: RoomEvent[], info: RoomEventsInfo) => void,
    onError: (error: DataSourceError) => void,
    onClosed?: () => void,
  ): Unsubscribe {
    const after = opts.after ?? afterTimeout;
    const stop = new AbortController();
    // the request in flight, aborted on a disconnection as well as by the stop
    let request: AbortController | null = null;
    // the request in flight was aborted by a disconnection: its failure is not one
    let cut = false;
    let connected = true;
    // ends the wait in progress (a back-off, or the wait for the connection) when the connection comes back
    let wake: (() => void) | null = null;
    const offConnection = opts.connection?.((s) => {
      connected = s !== "disconnected";
      if (!connected && request) {
        cut = true;
        request.abort();
      } else if (connected) wake?.();
    });
    /** Waits `ms` (forever when undefined), or until the connection comes back or the tap stops. */
    const wait = (ms?: number) =>
      new Promise<void>((resolve) => {
        const cancel = ms === undefined ? undefined : after(done, ms);
        function done() {
          cancel?.();
          wake = null;
          stop.signal.removeEventListener("abort", done);
          resolve();
        }
        wake = done;
        stop.signal.addEventListener("abort", done, { once: true });
      });
    const ask = async (cursor: number | null): Promise<TapJson> => {
      request = new AbortController();
      cut = false;
      const q = new URLSearchParams({ key: room.key });
      if (cursor !== null) {
        q.set("cursor", String(cursor));
        q.set("timeoutMs", String(opts.followTimeoutMs ?? FOLLOW_MS));
      }
      try {
        return await orNoRooms(
          http.json<TapJson>(`/api/debug/rooms/events?${q}`, {
            signal: AbortSignal.any([stop.signal, request.signal]),
          }),
        );
      } finally {
        request = null;
      }
    };
    const end = () => {
      loops.delete(off);
      stop.abort();
      offConnection?.();
    };

    const loop = async () => {
      // the last seq seen of the current tap, and that tap's epoch; null until it is started (again)
      let cursor: number | null = null;
      let epoch: string | null = null;
      // the source lost track since the last batch: the next one says so
      let gap = false;
      let failures = 0;
      // lost track (a failure or a disconnection) and not yet found the room open again
      let recovering = false;
      // the first answer after that which found the room closed: the window of `ROOM_CLOSED_RETRY_MS` starts there
      let closedSince: number | null = null;
      const now = opts.now ?? Date.now;
      const lost = () => {
        cursor = null;
        gap = true;
        recovering = true;
        // A failure inside the closed window starts it again from the next closed answer.
        closedSince = null;
      };
      while (!stop.signal.aborted) {
        if (!connected) {
          await wait();
          lost();
          continue;
        }
        let a: TapJson;
        try {
          a = await ask(cursor);
        } catch (e) {
          if (stop.signal.aborted) return;
          // aborted by a disconnection: the loop's top waits for the connection, then starts the tap again
          if (!connected || cut) {
            lost();
            continue;
          }
          const error = e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e));
          // what will not change by asking again ends the tap: no rooms, a refused key, a malformed room key
          if (error.code !== "unavailable") {
            end();
            onError(error);
            return;
          }
          failures++;
          lost();
          await wait((opts.backoff ?? backoffWithJitter)(failures));
          continue;
        }
        // the callbacks run outside the request's try: a consumer's exception is its own, not a failure to retry
        if (stop.signal.aborted) return;
        if (a.closed) {
          // just after a recovery the room may only be waiting for its members to reconnect: asked again a while,
          // from the first answer that found it closed, at a short fixed pace
          if (recovering) {
            closedSince ??= now();
            if (now() - closedSince < ROOM_CLOSED_RETRY_MS) {
              await wait(ROOM_CLOSED_RETRY_DELAY_MS);
              continue;
            }
          }
          end();
          onClosed?.();
          return;
        }
        failures = 0;
        recovering = false;
        closedSince = null;
        const started = cursor === null;
        // another tap than the cursor's (it expired and was made again since): what passed between is unknown
        if (!started && a.epoch !== undefined && epoch !== null && a.epoch !== epoch) gap = true;
        if (a.epoch !== undefined) epoch = a.epoch;
        cursor = a.newCursor;
        const events = a.events.map(eventOf);
        const dropped = a.dropped ?? 0;
        if (a.reset) gap = true;
        // a fresh tap holds nothing from before it: its first answer only carries a gap, if there is one
        if (events.length > 0 || dropped > 0 || gap) {
          const info = { dropped, gap };
          gap = false;
          try {
            onEvents(events, info);
          } catch (e) {
            // the consumer's bug ends the tap and surfaces (an unhandled rejection), rather than being retried
            end();
            throw e;
          }
        } else if (started) continue;
      }
    };
    // never synchronously: the first request goes out on a later tick
    const cancelFirst = after(() => void loop(), 0);
    const off = () => {
      cancelFirst();
      end();
    };
    loops.add(off);
    return off;
  }

  return {
    watchRoomEvents,
    /** Stops every tap. */
    close() {
      for (const off of [...loops]) off();
    },
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
    async broadcastRoomEvent(room: RoomRef, event: string, data: Value, o?: CallOptions): Promise<void> {
      await orNoRooms(
        http.request("/api/debug/rooms/broadcast", { body: { key: room.key, event, data }, signal: o?.signal }),
      );
    },
    async removeRoomMember(room: RoomRef, memberId: string, o?: CallOptions): Promise<RoomMemberRemoved | null> {
      const { removed } = await orNoRooms(
        http.json<{ removed: RoomMemberRemoved | null }>("/api/debug/rooms/remove", {
          body: { key: room.key, memberId },
          signal: o?.signal,
        }),
      );
      return removed === null ? null : { connections: removed.connections };
    },
    async closeRoom(room: RoomRef, o?: CallOptions): Promise<RoomClosed | null> {
      const { closed } = await orNoRooms(
        http.json<{ closed: RoomClosed | null }>("/api/debug/rooms/close", {
          body: { key: room.key },
          signal: o?.signal,
        }),
      );
      return closed === null ? null : { members: closed.members, connections: closed.connections };
    },
    async listRoomDefinitions(o?: CallOptions): Promise<RoomDefinition[]> {
      const { definitions } = await orNoRooms(
        http.json<{ definitions: RoomDefinition[] }>("/api/debug/rooms/definitions", { signal: o?.signal }),
      );
      return definitions;
    },
  };
}

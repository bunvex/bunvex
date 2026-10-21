// The rooms' members, in memory (AD-42, STUDY-164 §3.5): who is in which room, their presence, the reconnect
// grace, the per-member rate buckets and the member cap. Presence is coalesced: each tick sends one RoomMembers
// frame per member with the latest of every change since the last. Membership frames are never dropped; a
// connection too far behind is closed instead, and rejoins on reconnect.
import { randomUUID } from "node:crypto";
import { clearLongTimer, type LongTimer, longTimeout } from "@bunvex/core";
import type { v1 } from "@bunvex/protocol";
import type { RoomLimits } from "./limits.ts";

type JSONValue = v1.JSONValue;

export type Timers = {
  now(): number;
  /** Wall-clock ms (`Date.now()`), for what the dashboard shows; absent: the real one. */
  wall?(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimers: Timers = {
  now: () => performance.now(),
  set: (fn, ms) => {
    const h = longTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearLongTimer(h as LongTimer),
};
export interface RoomSink {
  /** The protocol session (Connect), or a random id before it. */
  readonly sessionId: string;
  send(frame: v1.ServerMessage): void;
  /** Bytes queued to this connection. */
  behind(): number;
  /** Close the connection: the client reconnects and rejoins. */
  resync(): void;
  /**
   * The dashboard removed this connection's membership `roomId` (AD-43): send RoomLeft and forget the room (the hub
   * has already let it go). Absent: the hub sends the RoomLeft frame itself.
   */
  evict?(roomId: number, code: "removed", message: string): void;
}
/** The RoomLeft message of a dashboard's removal. */
export const REMOVED_MESSAGE = "Removed from the dashboard.";
/** One open room or scope, as the dashboard lists it (AD-43). */
export type RoomSummary = {
  /** The hub's room key (`roomKeyString`): stable across polls. */
  key: string;
  kind: v1.RoomKind;
  name: string;
  /** The wire args the room key was made from. */
  args: JSONValue;
  members: number;
  /** Attachments, the ones in their grace included. */
  connections: number;
  openedAt: number;
};
export type RoomMemberInfo = {
  memberId: string;
  userId: string | null;
  presence: JSONValue | null;
  /** Scopes only. */
  idle?: boolean;
  canPublish: boolean;
  /** Every attachment of the member is in its grace. */
  graced: boolean;
  connections: number;
  joinedAt: number;
  lastActivityAt: number;
};
/**
 * `rooms`, `members` and `connections` are gauges; every other field is a counter, monotonic since the hub was
 * made. `joins` counts every successful join, a re-join within the grace included. `leaves` counts members that
 * left, grace expiries included (`graceExpiries` counts those again); an identity change or a re-join of the same
 * roomId on a live connection counts a leave and a join, a reconnect within the grace a join only.
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
/** The most members one `membersPage` returns. */
export const MEMBERS_PAGE_MAX = 100;

/** The most events one tap holds; older ones are dropped (AD-43, STUDY-165 §3.3). */
export const TAP_EVENTS_MAX = 200;
/** A tap ends this long after its last poll (a poll still waiting keeps it). */
export const TAP_IDLE_MS = 30_000;
/** An event's data above this many bytes of JSON is recorded as `null`, with `dataOmitted` and its real size. */
export const TAP_DATA_MAX_BYTES = 16 * 1024;
/** One event a tap saw: from a member (its memberId) or from the server (`from: null`). */
export type TappedEvent = {
  /** Per tap, from 1; a new tap starts again at 0. */
  seq: number;
  /** Wall-clock ms. */
  at: number;
  event: string;
  from: string | null;
  /** Bytes of the data's JSON. */
  size: number;
  /** The wire JSON, or `null` with `dataOmitted` above `TAP_DATA_MAX_BYTES`. */
  data: JSONValue;
  dataOmitted?: true;
};
/**
 * A tap poll's answer. `epoch`: the tap's id, made with it (absent when `closed`): a follower that sees it change
 * is following another tap than its cursor's, even when the cursor is behind the new tap's seq. `dropped`: events
 * lost between the cursor and the oldest held (the buffer overflowed); `reset`: the cursor names a tap that is gone
 * (expired, or another server's), and the tap starts again at `newCursor`; `closed`: the room is not open, and no tap
 * is kept.
 */
export type TapAnswer = {
  events: TappedEvent[];
  newCursor: number;
  epoch?: string;
  dropped?: number;
  reset?: true;
  closed?: true;
};
type Tap = { epoch: string; events: TappedEvent[]; seq: number; expiry: unknown; waiters: Set<() => void> };

export type RoomKey = { kind: v1.RoomKind; name: string; argsJson: string };
export const roomKeyString = (k: RoomKey) => `${k.kind}|${k.name}|${k.argsJson}`;

/** A token bucket: `perSecond` tokens, refilled continuously. */
class Bucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly perSecond: number,
    now: number,
  ) {
    this.tokens = perSecond;
    this.at = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.perSecond, this.tokens + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
type Member = {
  memberId: string;
  /** Its key in the room: the user in a scope; the session and the user in a room (`memberKeyOf`). */
  memberKey: string;
  userId: string | null;
  presence: JSONValue | null;
  attachments: Set<Attachment>;
  joinedAt: number;
  lastActivityAt: number;
};
type Attachment = {
  sink: RoomSink;
  roomId: number;
  room: Room;
  member: Member;
  canPublish: boolean;
  idle: boolean;
  presenceBucket: Bucket;
  eventBucket: Bucket;
  grace: unknown | null;
};
type Room = {
  key: RoomKey;
  openedAt: number;
  members: Map<string, Member>;
  changed: Set<Member>;
  left: string[];
  /** Its event tap while there is one (the same as in `taps`), found without building the key. */
  tap: Tap | null;
};

/**
 * A member's key: a scope's member is its user; a room's is the session's connection as one user, so two live
 * sockets of one session signed in as two users are two members.
 */
const memberKeyOf = (kind: v1.RoomKind, sessionId: string, userId: string | null) =>
  kind === "presence" ? userId! : `${sessionId}|${userId ?? ""}`;

/** A scope member's idle: every attachment idle (a member with none is not idle). */
const idleOf = (m: Member) => m.attachments.size > 0 && [...m.attachments].every((x) => x.idle);

export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private readonly bySink = new Map<RoomSink, Map<number, Attachment>>();
  /** Attachments in their grace, by `${sessionId}|${room key}`, then by member key. */
  private readonly graced = new Map<string, Map<string, Attachment>>();
  /**
   * Members the dashboard removed while in their grace, by `${sessionId}|${room key}\0${member key}`, each with the
   * timer that forgets it once the grace would have ended: that session's reconnect within it is refused as removed.
   */
  private readonly removedInGrace = new Map<string, unknown>();
  private tick: unknown | null = null;
  /** The event taps (AD-43), by room key: only rooms someone polled in the last `TAP_IDLE_MS`. */
  private readonly taps = new Map<string, Tap>();
  private readonly counters = {
    joins: 0,
    joinsRefusedByGate: 0,
    joinsRefusedByLimit: 0,
    leaves: 0,
    graceExpiries: 0,
    presenceAccepted: 0,
    presenceDropped: 0,
    eventsAccepted: 0,
    eventsDropped: 0,
    resyncs: 0,
    roomLeft: 0,
  };

  constructor(
    readonly limits: RoomLimits,
    private readonly timers: Timers = realTimers,
  ) {}

  get size() {
    let members = 0;
    for (const r of this.rooms.values()) members += r.members.size;
    return { rooms: this.rooms.size, members };
  }

  private wall() {
    return this.timers.wall?.() ?? Date.now();
  }

  /** A join a gate (or an anonymous scope join) refused, counted for `stats` (the session runs the gates). */
  countGateRefusal() {
    this.counters.joinsRefusedByGate++;
  }

  /** A RoomLeft frame sent (the session ends a membership the server ended on its own). */
  countRoomLeft() {
    this.counters.roomLeft++;
  }

  /** The gauges now and the counters since the hub was made; a few integers, nothing per viewer. */
  stats(): RoomStats {
    let rooms = 0;
    let members = 0;
    let connections = 0;
    for (const r of this.rooms.values()) {
      if (r.members.size === 0) continue;
      rooms++;
      members += r.members.size;
      for (const m of r.members.values()) connections += m.attachments.size;
    }
    return { rooms, members, connections, ...this.counters };
  }

  /** Every open room and scope, by name, then args: a snapshot built per call. */
  list(): RoomSummary[] {
    const out: RoomSummary[] = [];
    for (const [key, r] of this.rooms) {
      if (r.members.size === 0) continue;
      let connections = 0;
      for (const m of r.members.values()) connections += m.attachments.size;
      out.push({
        key,
        kind: r.key.kind,
        name: r.key.name,
        args: JSON.parse(r.key.argsJson) as JSONValue,
        members: r.members.size,
        connections,
        openedAt: r.openedAt,
      });
    }
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return out.sort((a, b) => byText(a.name, b.name) || byText(a.key, b.key));
  }

  /** One page of a room's members by memberId: the cursor is the last memberId returned, "" when done. */
  membersPage(
    key: RoomKey,
    cursor: string | null,
    numItems: number,
  ): { page: RoomMemberInfo[]; isDone: boolean; continueCursor: string } {
    const room = this.rooms.get(roomKeyString(key));
    if (!room) return { page: [], isDone: true, continueCursor: "" };
    const size = Math.max(1, Math.min(Math.floor(numItems), MEMBERS_PAGE_MAX));
    const sorted = [...room.members.values()]
      .filter((m) => cursor === null || cursor === "" || m.memberId > cursor)
      .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
    const page = sorted.slice(0, size).map((m): RoomMemberInfo => {
      const atts = [...m.attachments];
      const info: RoomMemberInfo = {
        memberId: m.memberId,
        userId: m.userId,
        presence: m.presence,
        canPublish: atts.some((x) => x.canPublish),
        graced: atts.length > 0 && atts.every((x) => x.grace !== null),
        connections: atts.length,
        joinedAt: m.joinedAt,
        lastActivityAt: m.lastActivityAt,
      };
      if (room.key.kind === "presence") info.idle = idleOf(m);
      return info;
    });
    const isDone = sorted.length <= size;
    return { page, isDone, continueCursor: isDone ? "" : page[page.length - 1]!.memberId };
  }

  /** Taps kept now (for tests and the measurement). */
  get tapped(): number {
    return this.taps.size;
  }

  /**
   * A dashboard's poll of a room's events (AD-43, STUDY-165 §3.3). No cursor starts the tap (if no one did) and
   * answers its seq at once: no past events, as a new member sees none. A cursor answers the events after it, or
   * waits up to `timeoutMs` for one (on a promise, never holding the hub). Each poll keeps the tap for
   * `TAP_IDLE_MS` more.
   */
  async tapEvents(key: RoomKey, cursor: number | null, timeoutMs: number, signal?: AbortSignal): Promise<TapAnswer> {
    const ks = roomKeyString(key);
    if (!this.isOpen(ks)) {
      this.endTap(ks);
      return { events: [], newCursor: cursor ?? 0, closed: true };
    }
    let tap = this.taps.get(ks);
    const fresh = !tap;
    if (!tap) {
      tap = { epoch: randomUUID(), events: [], seq: 0, expiry: null, waiters: new Set() };
      this.taps.set(ks, tap);
      this.rooms.get(ks)!.tap = tap;
    }
    this.keepTap(ks, tap);
    const { epoch } = tap;
    if (cursor === null) return { events: [], newCursor: tap.seq, epoch };
    // a cursor of a tap that is gone (expired, or before a restart): this one starts over, and says so
    if (fresh || cursor > tap.seq) return { events: [], newCursor: tap.seq, epoch, reset: true };
    if (tap.seq === cursor && timeoutMs > 0 && !signal?.aborted) {
      const waiting = tap;
      await new Promise<void>((resolve) => {
        const done = () => {
          this.timers.clear(timer);
          waiting.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          // the poll answers now: the tap is kept from here (not from when it waited)
          if (this.taps.get(ks) === waiting) this.keepTap(ks, waiting);
          resolve();
        };
        const timer = this.timers.set(done, timeoutMs);
        waiting.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      if (this.taps.get(ks) !== waiting) {
        if (!this.isOpen(ks)) return { events: [], newCursor: cursor, closed: true };
        // expired while the answer was on its way: a new tap, said so
        return { ...(await this.tapEvents(key, null, 0)), reset: true };
      }
    }
    const events = tap.events.filter((e) => e.seq > cursor);
    const answer: TapAnswer = { events, newCursor: events.at(-1)?.seq ?? cursor, epoch };
    const lost = (events[0]?.seq ?? cursor + 1) - cursor - 1;
    if (lost > 0) answer.dropped = lost;
    return answer;
  }

  /** Whether the room with this key (`roomKeyString`) has a member. */
  isOpen(ks: string) {
    return (this.rooms.get(ks)?.members.size ?? 0) > 0;
  }

  /** The tap's expiry moved to `TAP_IDLE_MS` from now; a poll still waiting then keeps it again. */
  private keepTap(ks: string, tap: Tap) {
    this.timers.clear(tap.expiry);
    tap.expiry = this.timers.set(() => {
      if (this.taps.get(ks) !== tap) return;
      if (tap.waiters.size > 0) this.keepTap(ks, tap);
      else this.dropTap(ks);
    }, TAP_IDLE_MS);
  }

  /** The room closed (or was found closed): its tap ends, and a poll waiting on it answers. */
  private endTap(ks: string) {
    const tap = this.taps.get(ks);
    if (!tap) return;
    this.dropTap(ks);
    this.timers.clear(tap.expiry);
    for (const w of [...tap.waiters]) w();
  }

  private dropTap(ks: string) {
    this.taps.delete(ks);
    const room = this.rooms.get(ks);
    if (room) room.tap = null;
  }

  private record(tap: Tap, from: string | null, event: string, data: JSONValue) {
    const json = JSON.stringify(data);
    const size = json.length === 0 ? 0 : Buffer.byteLength(json);
    const e: TappedEvent = { seq: ++tap.seq, at: this.wall(), event, from, size, data };
    if (size > TAP_DATA_MAX_BYTES) {
      e.data = null;
      e.dataOmitted = true;
    }
    tap.events.push(e);
    if (tap.events.length > TAP_EVENTS_MAX) tap.events.shift();
    if (tap.waiters.size > 0) for (const w of [...tap.waiters]) w();
  }

  join(
    sink: RoomSink,
    roomId: number,
    key: RoomKey,
    who: { userId: string | null; canPublish: boolean },
  ): "ok" | "limit" | "removed" {
    const ks = roomKeyString(key);
    const mine = this.bySink.get(sink) ?? new Map<number, Attachment>();
    // One attachment per (sink, roomId) and per (sink, room key): a join that reuses either first ends the old one.
    for (const [id, old] of [...mine]) {
      if (id === roomId || roomKeyString(old.room.key) === ks) {
        mine.delete(id);
        this.detachOne(old);
      }
    }
    if (mine.size >= this.limits.roomsPerConnection) {
      this.counters.joinsRefusedByLimit++;
      return "limit";
    }
    const memberKey = memberKeyOf(key.kind, sink.sessionId, who.userId);
    const gk = `${sink.sessionId}|${ks}`;
    const inGrace = this.graced.get(gk);
    const kept = inGrace?.get(memberKey);
    // removed by the dashboard in its grace: the reconnect is told of the removal, not given the member back (once)
    const removedKey = `${gk}\u0000${memberKey}`;
    if (!kept && this.removedInGrace.has(removedKey)) {
      this.timers.clear(this.removedInGrace.get(removedKey));
      this.removedInGrace.delete(removedKey);
      return "removed";
    }
    // A rejoin within the grace as another user: the old member ends at once, and this is a fresh join.
    for (const [k, other] of inGrace ?? [])
      if (k !== memberKey) {
        this.timers.clear(other.grace);
        this.ungrace(gk, k);
        this.detachOne(other);
      }
    if (kept) {
      // A reconnect within the grace: the same member, moved to the new socket; the others see nothing.
      this.timers.clear(kept.grace);
      this.ungrace(gk, memberKey);
      kept.grace = null;
      kept.sink = sink;
      kept.roomId = roomId;
      kept.canPublish = who.canPublish;
      mine.set(roomId, kept);
      this.bySink.set(sink, mine);
      this.sendSync(kept);
      this.counters.joins++;
      return "ok";
    }
    let room = this.rooms.get(ks);
    const existing = room?.members.get(memberKey);
    if (!existing && (room?.members.size ?? 0) >= this.limits.memberCap) {
      this.counters.joinsRefusedByLimit++;
      return "limit";
    }
    if (!room) {
      room = { key, openedAt: this.wall(), members: new Map(), changed: new Set(), left: [], tap: null };
      this.rooms.set(ks, room);
    }
    const member: Member = existing ?? {
      memberId: key.kind === "presence" ? who.userId! : randomUUID(),
      memberKey,
      userId: who.userId,
      presence: null,
      attachments: new Set(),
      joinedAt: this.wall(),
      lastActivityAt: this.wall(),
    };
    const now = this.timers.now();
    const a: Attachment = {
      sink,
      roomId,
      room,
      member,
      canPublish: who.canPublish,
      idle: false,
      grace: null,
      presenceBucket: new Bucket(this.limits.presencePerSecond, now),
      eventBucket: new Bucket(this.limits.eventsPerSecond, now),
    };
    const idleBefore = existing ? idleOf(member) : false;
    member.attachments.add(a);
    mine.set(roomId, a);
    this.bySink.set(sink, mine);
    if (!existing) {
      room.left = room.left.filter((id) => id !== member.memberId); // left and back in one tick: one `set` only
      room.members.set(memberKey, member);
      room.changed.add(member);
      this.scheduleTick();
    } else if (idleBefore !== idleOf(member)) {
      room.changed.add(member);
      this.scheduleTick();
    } // only a visible change
    this.sendSync(a);
    this.counters.joins++;
    return "ok";
  }

  leave(sink: RoomSink, roomId: number) {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a) return;
    this.bySink.get(sink)!.delete(roomId);
    this.detachOne(a);
  }

  /** The connection closed: each of its memberships is kept for the grace, then leaves. */
  detach(sink: RoomSink) {
    const mine = this.bySink.get(sink);
    if (!mine) return;
    this.bySink.delete(sink);
    for (const a of mine.values()) {
      const gk = `${sink.sessionId}|${roomKeyString(a.room.key)}`;
      const mk = a.member.memberKey;
      let inGrace = this.graced.get(gk);
      if (!inGrace) {
        inGrace = new Map();
        this.graced.set(gk, inGrace);
      }
      // Two sockets of one session in one room as one member (the older half-open when the client reconnected):
      // the one in its grace already is ended now, or its timer, finding the newer in its place, would never end it.
      const displaced = inGrace.get(mk);
      if (displaced) {
        this.timers.clear(displaced.grace);
        this.detachOne(displaced);
      }
      inGrace.set(mk, a);
      a.grace = this.timers.set(() => {
        if (this.graced.get(gk)?.get(mk) !== a) return;
        this.ungrace(gk, mk);
        if (this.detachOne(a)) this.counters.graceExpiries++;
      }, this.limits.graceMs);
    }
  }

  setPresence(
    sink: RoomSink,
    roomId: number,
    presence: JSONValue,
    idle?: boolean,
  ): "ok" | "forbidden" | "rate_limited" {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || !a.canPublish) return "forbidden";
    if (!a.presenceBucket.take(this.timers.now())) {
      this.counters.presenceDropped++;
      return "rate_limited";
    }
    this.counters.presenceAccepted++;
    a.member.lastActivityAt = this.wall();
    a.member.presence = presence;
    if (idle !== undefined) a.idle = idle;
    a.room.changed.add(a.member);
    this.scheduleTick();
    return "ok";
  }

  event(sink: RoomSink, roomId: number, event: string, data: JSONValue): "ok" | "forbidden" | "rate_limited" {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || !a.canPublish || a.room.key.kind !== "room") return "forbidden";
    if (!a.eventBucket.take(this.timers.now())) {
      this.counters.eventsDropped++;
      return "rate_limited";
    }
    this.counters.eventsAccepted++;
    a.member.lastActivityAt = this.wall();
    this.fanOutEvent(a.room, a.member.memberId, event, data, a);
    return "ok";
  }

  broadcast(key: RoomKey, event: string, data: JSONValue) {
    const room = this.rooms.get(roomKeyString(key));
    if (room && room.key.kind === "room") this.fanOutEvent(room, null, event, data, null);
  }

  /**
   * The dashboard removes a member (AD-43): every attachment ends at once, no grace. A live one is evicted (its
   * client is sent RoomLeft `removed`, which it does not retry); one in its grace just leaves. The others see the
   * member leave on the next tick. A scope member is a user: every tab, on every connection. Null when the room is
   * not open or has no such member. An eviction, not a ban: the client may join again.
   */
  removeMember(key: RoomKey, memberId: string): { connections: number } | null {
    const ks = roomKeyString(key);
    const room = this.rooms.get(ks);
    if (!room) return null;
    let member: Member | undefined;
    for (const m of room.members.values()) if (m.memberId === memberId) member = m;
    if (!member) return null;
    const atts = [...member.attachments];
    for (const a of atts) {
      if (a.grace !== null) {
        this.timers.clear(a.grace);
        const gk = `${a.sink.sessionId}|${ks}`;
        if (this.graced.get(gk)?.get(member.memberKey) === a) this.ungrace(gk, member.memberKey);
        const removedKey = `${gk}\u0000${member.memberKey}`;
        this.timers.clear(this.removedInGrace.get(removedKey));
        this.removedInGrace.set(
          removedKey,
          this.timers.set(() => this.removedInGrace.delete(removedKey), this.limits.graceMs),
        );
      } else {
        const mine = this.bySink.get(a.sink);
        mine?.delete(a.roomId);
        if (mine?.size === 0) this.bySink.delete(a.sink);
        if (a.sink.evict) a.sink.evict(a.roomId, "removed", REMOVED_MESSAGE);
        else {
          this.counters.roomLeft++;
          this.deliver(a.sink, { type: "RoomLeft", roomId: a.roomId, code: "removed", message: REMOVED_MESSAGE });
        }
      }
      this.detachOne(a);
    }
    // the last member gone: a tap ends now, not on the next tick
    if (room.members.size === 0) this.endTap(ks);
    return { connections: atts.length };
  }

  /** The dashboard closes a room (AD-43): every member removed (`removeMember`). Null when it is not open. */
  closeRoom(key: RoomKey): { members: number; connections: number } | null {
    const room = this.rooms.get(roomKeyString(key));
    if (!room || room.members.size === 0) return null;
    const ids = [...room.members.values()].map((m) => m.memberId);
    let connections = 0;
    for (const id of ids) connections += this.removeMember(key, id)?.connections ?? 0;
    return { members: ids.length, connections };
  }

  members(key: RoomKey): v1.RoomMember[] {
    const room = this.rooms.get(roomKeyString(key));
    return room ? [...room.members.values()].map((m) => this.view(room, m)) : [];
  }

  roomsOf(sink: RoomSink) {
    return [...(this.bySink.get(sink)?.values() ?? [])].map((a) => ({ roomId: a.roomId, key: a.room.key }));
  }

  /** A change is sent as a fresh RoomSync (a client takes each as a snapshot); no change sends nothing. */
  setCanPublish(sink: RoomSink, roomId: number, canPublish: boolean) {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || a.canPublish === canPublish) return;
    a.canPublish = canPublish;
    this.sendSync(a);
  }

  private ungrace(gk: string, memberKey: string) {
    const inGrace = this.graced.get(gk);
    if (!inGrace) return;
    inGrace.delete(memberKey);
    if (inGrace.size === 0) this.graced.delete(gk);
  }

  /** End an attachment; true when that ended its member (the last attachment). */
  private detachOne(a: Attachment): boolean {
    const { room, member } = a;
    const idleBefore = idleOf(member);
    member.attachments.delete(a);
    if (member.attachments.size > 0) {
      // A scope's other tab remains: the others hear of it only when the user's visible idle changes.
      if (room.key.kind === "presence" && idleBefore !== idleOf(member)) {
        room.changed.add(member);
        this.scheduleTick();
      }
      return false;
    }
    this.counters.leaves++;
    room.members.delete(member.memberKey);
    room.changed.delete(member);
    room.left.push(member.memberId);
    this.scheduleTick();
    return true;
  }

  private view(room: Room, m: Member): v1.RoomMember {
    if (room.key.kind === "room") return { memberId: m.memberId, userId: m.userId, presence: m.presence };
    return { memberId: m.memberId, userId: m.userId, presence: m.presence, idle: idleOf(m) };
  }

  private sendSync(a: Attachment) {
    const others = [...a.room.members.values()].filter((m) => m !== a.member).map((m) => this.view(a.room, m));
    this.deliver(a.sink, {
      type: "RoomSync",
      roomId: a.roomId,
      self: a.member.memberId,
      canPublish: a.canPublish,
      members: others,
    });
  }

  private fanOutEvent(room: Room, from: string | null, event: string, data: JSONValue, sender: Attachment | null) {
    // a room no one taps costs one field check
    if (room.tap !== null) this.record(room.tap, from, event, data);
    for (const m of room.members.values())
      for (const x of m.attachments)
        if (x !== sender && x.grace === null && !(sender && x.member === sender.member))
          this.deliver(x.sink, { type: "RoomEvent", roomId: x.roomId, from, event, data });
  }

  private scheduleTick() {
    if (this.tick !== null) return;
    this.tick = this.timers.set(() => {
      this.tick = null;
      this.flush();
    }, this.limits.tickMs);
  }

  /** One coalesced RoomMembers frame per attached member of every changed room. */
  private flush() {
    for (const [ks, room] of this.rooms) {
      if (room.changed.size === 0 && room.left.length === 0) {
        if (room.members.size === 0) this.forgetRoom(ks);
        continue;
      }
      const changed = [...room.changed];
      const left = room.left;
      room.changed = new Set();
      room.left = [];
      for (const m of room.members.values())
        for (const x of m.attachments) {
          if (x.grace !== null) continue;
          const set = changed.filter((c) => c !== m).map((c) => this.view(room, c));
          if (set.length || left.length) this.deliver(x.sink, { type: "RoomMembers", roomId: x.roomId, set, left });
        }
      if (room.members.size === 0) this.forgetRoom(ks);
    }
  }

  private forgetRoom(ks: string) {
    this.rooms.delete(ks);
    this.endTap(ks);
  }

  /** Membership frames are never dropped: a connection too far behind is closed, and re-syncs on reconnect. */
  private deliver(sink: RoomSink, frame: v1.ServerMessage) {
    if (sink.behind() > this.limits.maxBufferedBytes) {
      this.counters.resyncs++;
      sink.resync();
      return;
    }
    sink.send(frame);
  }
}

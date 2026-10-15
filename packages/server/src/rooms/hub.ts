// The rooms' members, in memory (AD-42, STUDY-164 §3.5): who is in which room, their presence, the reconnect
// grace, the per-member rate buckets and the member cap. Presence is coalesced: each tick sends one RoomMembers
// frame per member with the latest of every change since the last. Membership frames are never dropped; a
// connection too far behind is closed instead, and rejoins on reconnect.
import { randomUUID } from "node:crypto";
import type { v1 } from "@bunvex/protocol";
import type { RoomLimits } from "./limits.ts";

type JSONValue = v1.JSONValue;

export type Timers = { now(): number; set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = {
  now: () => performance.now(),
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
export interface RoomSink {
  /** The protocol session (Connect), or a random id before it. */
  readonly sessionId: string;
  send(frame: v1.ServerMessage): void;
  /** Bytes queued to this connection. */
  behind(): number;
  /** Close the connection: the client reconnects and rejoins. */
  resync(): void;
}
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
type Member = { memberId: string; userId: string | null; presence: JSONValue | null; attachments: Set<Attachment> };
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
type Room = { key: RoomKey; members: Map<string, Member>; changed: Set<Member>; left: string[] };

/** A scope member's idle: every attachment idle (a member with none is not idle). */
const idleOf = (m: Member) => m.attachments.size > 0 && [...m.attachments].every((x) => x.idle);

export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private readonly bySink = new Map<RoomSink, Map<number, Attachment>>();
  private readonly graced = new Map<string, Attachment>();
  private tick: unknown | null = null;

  constructor(
    private readonly limits: RoomLimits,
    private readonly timers: Timers = realTimers,
  ) {}

  get size() {
    let members = 0;
    for (const r of this.rooms.values()) members += r.members.size;
    return { rooms: this.rooms.size, members };
  }

  join(
    sink: RoomSink,
    roomId: number,
    key: RoomKey,
    who: { userId: string | null; canPublish: boolean },
  ): "ok" | "limit" {
    const ks = roomKeyString(key);
    const mine = this.bySink.get(sink) ?? new Map<number, Attachment>();
    // One attachment per (sink, roomId) and per (sink, room key): a join that reuses either first ends the old one.
    for (const [id, old] of [...mine]) {
      if (id === roomId || roomKeyString(old.room.key) === ks) {
        mine.delete(id);
        this.detachOne(old);
      }
    }
    if (mine.size >= this.limits.roomsPerConnection) return "limit";
    const kept = this.graced.get(`${sink.sessionId}|${ks}`);
    if (kept && kept.member.userId !== who.userId) {
      // A rejoin within the grace as another user: the old member ends at once, and this is a fresh join.
      this.timers.clear(kept.grace);
      this.graced.delete(`${sink.sessionId}|${ks}`);
      this.detachOne(kept);
    } else if (kept) {
      // A reconnect within the grace: the same member, moved to the new socket; the others see nothing.
      this.timers.clear(kept.grace);
      this.graced.delete(`${sink.sessionId}|${ks}`);
      kept.grace = null;
      kept.sink = sink;
      kept.roomId = roomId;
      kept.canPublish = who.canPublish;
      mine.set(roomId, kept);
      this.bySink.set(sink, mine);
      this.sendSync(kept);
      return "ok";
    }
    let room = this.rooms.get(ks);
    const memberKey = key.kind === "presence" ? who.userId! : sink.sessionId;
    const existing = room?.members.get(memberKey);
    if (!existing && (room?.members.size ?? 0) >= this.limits.memberCap) return "limit";
    if (!room) {
      room = { key, members: new Map(), changed: new Set(), left: [] };
      this.rooms.set(ks, room);
    }
    const member: Member = existing ?? {
      memberId: key.kind === "presence" ? who.userId! : randomUUID(),
      userId: who.userId,
      presence: null,
      attachments: new Set(),
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
      // Two sockets of one session in one room (the older half-open when the client reconnected): the one in
      // its grace already is ended now, or its timer, finding the newer in its place, would never end it.
      const displaced = this.graced.get(gk);
      if (displaced) {
        this.timers.clear(displaced.grace);
        this.detachOne(displaced);
      }
      this.graced.set(gk, a);
      a.grace = this.timers.set(() => {
        if (this.graced.get(gk) !== a) return;
        this.graced.delete(gk);
        this.detachOne(a);
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
    if (!a.presenceBucket.take(this.timers.now())) return "rate_limited";
    a.member.presence = presence;
    if (idle !== undefined) a.idle = idle;
    a.room.changed.add(a.member);
    this.scheduleTick();
    return "ok";
  }

  event(sink: RoomSink, roomId: number, event: string, data: JSONValue): "ok" | "forbidden" | "rate_limited" {
    const a = this.bySink.get(sink)?.get(roomId);
    if (!a || !a.canPublish || a.room.key.kind !== "room") return "forbidden";
    if (!a.eventBucket.take(this.timers.now())) return "rate_limited";
    this.fanOutEvent(a.room, a.member.memberId, event, data, a);
    return "ok";
  }

  broadcast(key: RoomKey, event: string, data: JSONValue) {
    const room = this.rooms.get(roomKeyString(key));
    if (room && room.key.kind === "room") this.fanOutEvent(room, null, event, data, null);
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

  private detachOne(a: Attachment) {
    const { room, member } = a;
    const idleBefore = idleOf(member);
    member.attachments.delete(a);
    if (member.attachments.size > 0) {
      // A scope's other tab remains: the others hear of it only when the user's visible idle changes.
      if (room.key.kind === "presence" && idleBefore !== idleOf(member)) {
        room.changed.add(member);
        this.scheduleTick();
      }
      return;
    }
    const memberKey = room.key.kind === "presence" ? member.userId! : a.sink.sessionId;
    room.members.delete(memberKey);
    room.changed.delete(member);
    room.left.push(member.memberId);
    this.scheduleTick();
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
        if (room.members.size === 0) this.rooms.delete(ks);
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
      if (room.members.size === 0) this.rooms.delete(ks);
    }
  }

  /** Membership frames are never dropped: a connection too far behind is closed, and re-syncs on reconnect. */
  private deliver(sink: RoomSink, frame: v1.ServerMessage) {
    if (sink.behind() > this.limits.maxBufferedBytes) {
      sink.resync();
      return;
    }
    sink.send(frame);
  }
}

// The mock's rooms (AD-43, STUDY-165): a `rooms:doc` room with five members whose cursors move with the mock
// clock, and a `presence:online` scope with three users (one on two tabs, one idle), with the definitions that
// describe them and counters that keep growing. A member's cursor is a function of the clock and the member, not
// of a timer, so a screenshot or a test at a given clock sees the same picture. The event tap: while tapped, the
// document room sends a `wave` from one of its members at every multiple of the interval on the mock clock (a wave is
// a function of the seed and its time, so the same at the same mock time), and a test pushes its own (`emit`). The
// dashboard's actions (send a test event, remove a member, close a room) act on these rooms, refusing what the
// server refuses (DV-479): each member has a simulated client that records what it received and how it was ended
// (`client`). Not part of the contract: the source wraps it.

import { DataSourceError, type Page, type PageRequest, type Value } from "../data-source.ts";
import type {
  RoomClosed,
  RoomDefinition,
  RoomEvent,
  RoomEventsInfo,
  RoomInfo,
  RoomMember,
  RoomMemberRemoved,
  RoomRef,
  RoomStats,
} from "../data-source-rooms.ts";
import { validateValue } from "../validators.ts";
import { createRandom, type Random } from "./random.ts";

/** The most members one page holds, as the server's. */
const MEMBERS_PAGE_MAX = 100;
const HOUR = 3_600_000;
/** The server's refusal of a malformed key (400 BadRequest). */
const BAD_KEY = "`key` is not a room key from the list.";

/** An event's data above this many bytes of JSON is omitted, as the server's tap does. */
const TAP_DATA_MAX_BYTES = 16 * 1024;
const NO_LOSS: RoomEventsInfo = { dropped: 0, gap: false };
/** How often a tapped document room looks at the mock clock for a wave due. */
const WAVE_CHECK_MS = 50;
/** The most waves sent at once when the mock clock jumped. */
const WAVES_MAX_AT_ONCE = 20;

type Seat = { member: RoomMember; phase: number };
/** A member's simulated client: what it received, and the RoomLeft that ended it. */
type MockClient = {
  received: { event: string; from: string | null; data: Value }[];
  ended: { code: string; message: string } | null;
};
/** The client events' size limit, as the server's default (`BUNVEX_ROOM_PAYLOAD_BYTES`). */
const EVENT_MAX_BYTES = 4096;
const REMOVED = { code: "removed", message: "Removed from the dashboard." };
type MockTap = {
  key: string;
  /** The mock time it started: a wave due before it is not its. */
  since: number;
  seq: number;
  pending: RoomEvent[];
  flushing: boolean;
  onEvents: (events: RoomEvent[], info: RoomEventsInfo) => void;
  onClosed: () => void;
};
type OpenRoom = { info: RoomInfo; seats: Seat[] };

const field = (fieldType: RoomDefinition["args"] & object) => ({ fieldType, optional: false });
const obj = (value: Record<string, ReturnType<typeof field>>) => ({ type: "object" as const, value });
const text = { type: "string" as const };
const num = { type: "number" as const };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A room key's function name and args' JSON text (`kind|name|args`), as the server's audit events name a room. */
export function roomKeyParts(key: string): { room: string; args: string } {
  const i = key.indexOf("|");
  const j = key.indexOf("|", i + 1);
  return { room: key.slice(i + 1, j), args: key.slice(j + 1) };
}

/** As the server refuses a key that is not `kind|name|args` of a room or a scope. */
function checkKey(key: string) {
  const i = key.indexOf("|");
  const j = key.indexOf("|", i + 1);
  if (i < 0 || j < 0 || !["room", "presence"].includes(key.slice(0, i)))
    throw new DataSourceError("invalid_request", BAD_KEY);
}

export class MockRooms {
  private open: OpenRoom[];
  private readonly rnd: Random;
  private counters: Omit<RoomStats, "rooms" | "members" | "connections">;
  private readonly taps = new Set<MockTap>();
  /** Checks the mock clock for waves due while the document room is tapped. */
  private waveTimer: ReturnType<typeof setInterval> | null = null;
  /** The last wave sent (its index: its mock time over the interval). */
  private lastWave = 0;
  /** Each member's simulated client, by `${room key}\u0000${memberId}`. */
  private readonly clients = new Map<string, MockClient>();

  constructor(
    private readonly seed: number,
    private readonly now: () => number,
    start: number,
    private readonly waveEveryMs = 3000,
  ) {
    // its own stream: the mock's other data stays what it was
    this.rnd = createRandom(seed ^ 0x400d);
    const ids = Array.from({ length: 8 }, () => this.rnd.id()).sort(byText);
    const people = [
      ["user_ana", "Ana"],
      ["user_bruno", "Bruno"],
      ["user_carla", "Carla"],
      ["user_davi", "Davi"],
    ] as const;
    const seat = (i: number, userId: string | null, over: Partial<RoomMember> = {}): Seat => ({
      phase: i * 1.3 + 0.4,
      member: {
        memberId: ids[i]!,
        userId,
        presence: null,
        canPublish: true,
        graced: false,
        connections: 1,
        joinedAt: 0,
        lastActivityAt: 0,
        ...over,
      },
    });
    const openedDoc = start - 3 * HOUR;
    const doc: OpenRoom = {
      info: {
        key: `room|rooms:doc|{"id":"design-review"}`,
        kind: "room",
        name: "rooms:doc",
        args: { id: "design-review" },
        members: 5,
        connections: 5,
        openedAt: openedDoc,
      },
      // the fifth is a signed-out viewer: it follows but cannot publish
      seats: [
        ...people.map(([id], i) => seat(i, id, { joinedAt: openedDoc + i * 7 * 60_000 })),
        seat(4, null, { canPublish: false, joinedAt: openedDoc + 40 * 60_000 }),
      ],
    };
    const openedScope = start - 26 * HOUR;
    const scope: OpenRoom = {
      info: {
        key: `presence|presence:online|{"team":"acme"}`,
        kind: "presence",
        name: "presence:online",
        args: { team: "acme" },
        members: 3,
        connections: 4,
        openedAt: openedScope,
      },
      seats: [
        seat(5, "user_ana", { connections: 2, idle: false, joinedAt: openedScope }),
        seat(6, "user_bruno", { idle: false, joinedAt: openedScope + 5 * HOUR }),
        seat(7, "user_carla", { idle: true, joinedAt: openedScope + 9 * HOUR }),
      ],
    };
    // by name, then key, as the server lists them
    this.open = [doc, scope].sort((a, b) => byText(a.info.name, b.info.name) || byText(a.info.key, b.info.key));
    this.counters = {
      joins: 412,
      joinsRefusedByGate: 3,
      joinsRefusedByLimit: 0,
      leaves: 404,
      graceExpiries: 9,
      presenceAccepted: 88_400,
      presenceDropped: 1_250,
      eventsAccepted: 5_300,
      eventsDropped: 14,
      resyncs: 2,
      roomLeft: 1,
    };
  }

  /** A member as of the clock now: the cursor of a room's member wanders, the activity follows. */
  private view(room: OpenRoom, s: Seat, i: number): RoomMember {
    const t = this.now();
    const m = { ...s.member };
    if (room.info.kind === "room") {
      const x = 50 + 40 * Math.sin(t / 1500 + s.phase);
      const y = 50 + 30 * Math.cos(t / 1100 + 2 * s.phase);
      m.presence = {
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        name: m.userId ? m.userId.slice(5) : "guest",
      };
    } else {
      m.presence = { status: m.idle ? "away" : "online", page: ["/board", "/inbox", "/settings"][i % 3]! };
    }
    m.lastActivityAt = m.idle ? t - 20 * 60_000 : t - ((Math.floor(t / 1000) + i * 7) % 30) * 1000;
    if (m.lastActivityAt < m.joinedAt) m.lastActivityAt = m.joinedAt;
    return m;
  }

  list(): RoomInfo[] {
    return this.open.map((r) => ({ ...r.info, args: structuredClone(r.info.args) }));
  }

  members(room: RoomRef, page: PageRequest): Page<RoomMember> {
    checkKey(room.key);
    const r = this.open.find((o) => o.info.key === room.key);
    if (!r) return { page: [], isDone: true, continueCursor: "" };
    const size = Number.isFinite(page.numItems)
      ? Math.max(1, Math.min(Math.floor(page.numItems), MEMBERS_PAGE_MAX))
      : MEMBERS_PAGE_MAX;
    const sorted = r.seats
      .map((s, i) => this.view(r, s, i))
      .filter((m) => !page.cursor || m.memberId > page.cursor)
      .sort((a, b) => byText(a.memberId, b.memberId));
    const out = sorted.slice(0, size);
    const isDone = sorted.length <= size;
    return { page: out, isDone, continueCursor: isDone ? "" : out[out.length - 1]!.memberId };
  }

  definitions(): RoomDefinition[] {
    return [
      {
        kind: "presence",
        name: "presence:online",
        module: "presence.js",
        args: obj({ team: field(text) }),
        state: obj({ status: field(text), page: field(text) }),
        events: [],
      },
      {
        kind: "room",
        name: "rooms:doc",
        module: "rooms.js",
        args: obj({ id: field(text) }),
        presence: obj({ x: field(num), y: field(num), name: field(text) }),
        events: [
          { name: "ping", payload: obj({ at: field(num) }) },
          { name: "reaction", payload: obj({ emoji: field(text) }) },
          { name: "wave", payload: obj({ x: field(num), y: field(num) }) },
        ],
      },
    ];
  }

  stats(): RoomStats {
    const members = this.open.reduce((n, r) => n + r.info.members, 0);
    const connections = this.open.reduce((n, r) => n + r.info.connections, 0);
    return { rooms: this.open.length, members, connections, ...this.counters };
  }

  /**
   * Close a room, as the last member leaving would: gone from `list`, its members counted as leaves. For tests of
   * the "closed" state; not part of the contract. False when no open room has that key.
   */
  close(key: string): boolean {
    const r = this.open.find((o) => o.info.key === key);
    if (!r) return false;
    this.open = this.open.filter((o) => o !== r);
    this.counters = { ...this.counters, leaves: this.counters.leaves + r.info.members };
    // its taps end, after what they had not delivered yet
    for (const t of [...this.taps]) if (t.key === key) this.endTap(t);
    return true;
  }

  /** A member's simulated client (made on first ask), or null when the room never had that member. */
  client(key: string, memberId: string): MockClient | null {
    const id = `${key}\u0000${memberId}`;
    const known = this.clients.get(id);
    if (known) return known;
    const r = this.open.find((o) => o.info.key === key);
    if (!r?.seats.some((s) => s.member.memberId === memberId)) return null;
    const made: MockClient = { received: [], ended: null };
    this.clients.set(id, made);
    return made;
  }

  /**
   * The dashboard's test event, checked as the server checks it (the room declares it, its validator, the size
   * limit), then sent from the server to every member's client and every tap.
   */
  broadcast(key: string, event: string, data: Value) {
    checkKey(key);
    const name = roomKeyParts(key).room;
    const def = this.definitions().find((d) => d.name === name && d.kind === "room");
    if (!def) throw new DataSourceError("invalid_request", `No room named "${name}".`);
    const declared = def.events.find((e) => e.name === event);
    if (!declared) throw new DataSourceError("invalid_request", `This room has no event "${event}".`);
    const issue = declared.payload ? validateValue(declared.payload, data)[0] : undefined;
    if (issue) throw new DataSourceError("invalid_request", `ArgumentValidationError: ${issue.message}`);
    const size = new TextEncoder().encode(JSON.stringify(data)).length;
    if (size > EVENT_MAX_BYTES)
      throw new DataSourceError("invalid_request", `The event is ${size} bytes (limit ${EVENT_MAX_BYTES}).`);
    const r = this.open.find((o) => o.info.key === key);
    if (!r) throw new DataSourceError("not_found", "The room is not open.");
    for (const s of r.seats)
      if (!s.member.graced)
        this.client(key, s.member.memberId)!.received.push({ event, from: null, data: structuredClone(data) });
    this.emit(key, event, data, null);
  }

  /** The dashboard removes a member: its client is ended (RoomLeft `removed`); the last one out closes the room. */
  removeMember(key: string, memberId: string): RoomMemberRemoved | null {
    checkKey(key);
    const r = this.open.find((o) => o.info.key === key);
    const seat = r?.seats.find((s) => s.member.memberId === memberId);
    if (!r || !seat) return null;
    const { connections } = seat.member;
    if (!seat.member.graced) this.client(key, memberId)!.ended = { ...REMOVED };
    r.seats = r.seats.filter((s) => s !== seat);
    r.info = { ...r.info, members: r.info.members - 1, connections: r.info.connections - connections };
    const c = this.counters;
    this.counters = {
      ...c,
      leaves: c.leaves + 1,
      roomLeft: c.roomLeft + (seat.member.graced ? 0 : connections),
    };
    if (r.seats.length === 0) {
      this.open = this.open.filter((o) => o !== r);
      for (const t of [...this.taps]) if (t.key === key) this.endTap(t);
    }
    return { connections };
  }

  /** The dashboard closes a room: every member removed. */
  closeRoom(key: string): RoomClosed | null {
    checkKey(key);
    const r = this.open.find((o) => o.info.key === key);
    if (!r) return null;
    const ids = r.seats.map((s) => s.member.memberId);
    let connections = 0;
    for (const id of ids) connections += this.removeMember(key, id)?.connections ?? 0;
    return { members: ids.length, connections };
  }

  /**
   * Tap a room's events from now on: delivered on a later tick, in seq order from 1; `onClosed` (on a later tick)
   * when the room is not open or closes. Throws `invalid_request` for a malformed key. Returns the stop.
   */
  tap(key: string, onEvents: MockTap["onEvents"], onClosed: () => void): () => void {
    checkKey(key);
    const t: MockTap = { key, since: this.now(), seq: 0, pending: [], flushing: false, onEvents, onClosed };
    this.taps.add(t);
    if (!this.open.some((o) => o.info.key === key)) this.endTap(t);
    else this.wavesOn();
    return () => {
      this.taps.delete(t);
      this.wavesOn();
    };
  }

  /**
   * An event in an open room, as a member (`from`, its memberId) or the server (`from: null`) would send it: every
   * tap on the room sees it. For tests; not part of the contract. False when no open room has that key.
   */
  emit(key: string, event: string, data: Value, from: string | null = null): boolean {
    return this.emitAt(key, event, data, from, this.now());
  }

  private emitAt(key: string, event: string, data: Value, from: string | null, at: number): boolean {
    if (!this.open.some((o) => o.info.key === key)) return false;
    const json = JSON.stringify(data);
    const size = new TextEncoder().encode(json).length;
    for (const t of this.taps) {
      if (t.key !== key || at < t.since) continue;
      const e: RoomEvent = { seq: ++t.seq, at, event, from, size, data: structuredClone(data) };
      if (size > TAP_DATA_MAX_BYTES) {
        e.data = null;
        e.dataOmitted = true;
      }
      t.pending.push(e);
      this.flushLater(t);
    }
    return true;
  }

  private flushLater(t: MockTap, then?: () => void) {
    if (t.flushing && !then) return;
    t.flushing = true;
    setTimeout(() => {
      t.flushing = false;
      if (!this.taps.has(t) && !then) return;
      const events = t.pending.splice(0);
      if (events.length > 0) t.onEvents(events, NO_LOSS);
      then?.();
    }, 0);
  }

  private endTap(t: MockTap) {
    this.taps.delete(t);
    this.wavesOn();
    this.flushLater(t, () => t.onClosed());
  }

  /** The document room's waves run while it is tapped: a check of the mock clock, every `WAVE_CHECK_MS`. */
  private wavesOn() {
    const tapped = [...this.taps].some((t) => t.key === this.docRoom()?.info.key);
    if (tapped && this.waveTimer === null) {
      this.lastWave = Math.floor(this.now() / this.waveEveryMs);
      this.waveTimer = setInterval(() => this.waveDue(), WAVE_CHECK_MS);
    } else if (!tapped && this.waveTimer !== null) {
      clearInterval(this.waveTimer);
      this.waveTimer = null;
    }
  }

  private docRoom() {
    return this.open.find((o) => o.info.name === "rooms:doc");
  }

  /** The waves the mock clock has passed since the last (the latest few, after a jump). */
  private waveDue() {
    const doc = this.docRoom();
    if (!doc) return;
    const due = Math.floor(this.now() / this.waveEveryMs);
    for (let k = Math.max(this.lastWave + 1, due - WAVES_MAX_AT_ONCE + 1); k <= due; k++) {
      // a function of the seed and the wave's time: the same wave at the same mock time
      const r = createRandom((this.seed ^ 0x3a7e) + k * 0x9e3779b1);
      const publishers = doc.seats.filter((s) => s.member.canPublish);
      const pick = r.int(0, Math.max(0, publishers.length - 1));
      const from = publishers[pick]?.member.memberId ?? null;
      this.emitAt(doc.info.key, "wave", { x: r.int(0, 100), y: r.int(0, 100) }, from, k * this.waveEveryMs);
    }
    this.lastWave = Math.max(this.lastWave, due);
  }

  /** The counters on, as a busy deployment would between two samples. */
  step() {
    const c = this.counters;
    const presence = this.rnd.int(40, 200);
    const events = this.rnd.int(0, 30);
    this.counters = {
      ...c,
      joins: c.joins + this.rnd.int(0, 2),
      leaves: c.leaves + this.rnd.int(0, 2),
      presenceAccepted: c.presenceAccepted + presence,
      presenceDropped: c.presenceDropped + (this.rnd.chance(0.3) ? this.rnd.int(1, 5) : 0),
      eventsAccepted: c.eventsAccepted + events,
      eventsDropped: c.eventsDropped + (this.rnd.chance(0.05) ? 1 : 0),
    };
  }
}

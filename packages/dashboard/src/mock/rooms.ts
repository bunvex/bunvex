// The mock's rooms (AD-43, STUDY-165): a `rooms:doc` room with five members whose cursors move with the mock
// clock, and a `presence:online` scope with three users (one on two tabs, one idle), with the definitions that
// describe them and counters that keep growing. A member's cursor is a function of the clock and the member, not
// of a timer, so a screenshot or a test at a given clock sees the same picture. Not part of the contract: the
// source wraps it.

import type { Page, PageRequest } from "../data-source.ts";
import type { RoomDefinition, RoomInfo, RoomMember, RoomRef, RoomStats } from "../data-source-rooms.ts";
import { createRandom, type Random } from "./random.ts";

/** The most members one page holds, as the server's. */
const MEMBERS_PAGE_MAX = 100;
const HOUR = 3_600_000;

type Seat = { member: RoomMember; phase: number };
type OpenRoom = { info: RoomInfo; seats: Seat[] };

const field = (fieldType: RoomDefinition["args"] & object) => ({ fieldType, optional: false });
const obj = (value: Record<string, ReturnType<typeof field>>) => ({ type: "object" as const, value });
const text = { type: "string" as const };
const num = { type: "number" as const };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class MockRooms {
  private readonly open: OpenRoom[];
  private readonly rnd: Random;
  private counters: Omit<RoomStats, "rooms" | "members" | "connections">;

  constructor(
    seed: number,
    private readonly now: () => number,
    start: number,
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
    const r = this.open.find((o) => o.info.key === room.key);
    if (!r) return { page: [], isDone: true, continueCursor: "" };
    const size = Math.max(1, Math.min(Math.floor(page.numItems), MEMBERS_PAGE_MAX));
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
        ],
      },
    ];
  }

  stats(): RoomStats {
    const members = this.open.reduce((n, r) => n + r.info.members, 0);
    const connections = this.open.reduce((n, r) => n + r.info.connections, 0);
    return { rooms: this.open.length, members, connections, ...this.counters };
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

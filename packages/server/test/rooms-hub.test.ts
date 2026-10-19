import { describe, expect, test } from "bun:test";
import type { v1 } from "@bunvex/protocol";
import {
  RoomHub,
  type RoomKey,
  type RoomSink,
  roomKeyString,
  TAP_DATA_MAX_BYTES,
  TAP_EVENTS_MAX,
  TAP_IDLE_MS,
  type Timers,
} from "../src/rooms/hub.ts";
import type { RoomLimits } from "../src/rooms/limits.ts";

const LIMITS: RoomLimits = {
  payloadBytes: 4096,
  argsBytes: 4096,
  roomsPerConnection: 64,
  presencePerSecond: 40,
  eventsPerSecond: 10,
  memberCap: 500,
  graceMs: 5000,
  tickMs: 30,
  maxBufferedBytes: 1 << 20,
};
/** A clock the test advances; due timers run in order. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(h: unknown): boolean } {
  let now = 0;
  let seq = 0;
  const EPOCH = 1_700_000_000_000;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    wall: () => EPOCH + now,
    set: (fn, ms) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void due.delete(h as number),
    pending: (h) => due.has(h as number),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}
function sink(sessionId: string): RoomSink & { frames: v1.ServerMessage[]; resyncs: number; queued: number } {
  const s = {
    sessionId,
    frames: [] as v1.ServerMessage[],
    resyncs: 0,
    queued: 0,
    send: (f: v1.ServerMessage) => void s.frames.push(f),
    behind: () => s.queued,
    resync: () => void s.resyncs++,
  };
  return s;
}
const DOC: RoomKey = { kind: "room", name: "rooms:doc", argsJson: '{"id":"a"}' };
const ONLINE: RoomKey = { kind: "presence", name: "rooms:online", argsJson: "{}" };
const last = (s: { frames: v1.ServerMessage[] }) => s.frames.at(-1);

describe("rooms", () => {
  test("a joiner gets everyone else; the others see it on the next tick", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.setPresence(a, 1, { x: 1 });
    t.advance(30);
    hub.join(b, 7, DOC, { userId: "u2", canPublish: true });
    const sync = last(b) as v1.RoomSync;
    expect(sync).toMatchObject({ type: "RoomSync", roomId: 7, canPublish: true });
    expect(sync.members).toEqual([{ memberId: expect.any(String), userId: "u1", presence: { x: 1 } }]);
    t.advance(30);
    expect(last(a)).toMatchObject({
      type: "RoomMembers",
      roomId: 1,
      set: [{ userId: "u2", presence: null }],
      left: [],
    });
  });
  test("1,000 presence updates in a tick reach a member as one frame with the latest", () => {
    const t = fakeTimers();
    const hub = new RoomHub({ ...LIMITS, presencePerSecond: 10_000 }, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    t.advance(30);
    b.frames.length = 0;
    for (let i = 0; i < 1000; i++) hub.setPresence(a, 1, { i });
    t.advance(30);
    expect(b.frames).toHaveLength(1);
    expect((b.frames[0] as v1.RoomMembers).set).toEqual([expect.objectContaining({ presence: { i: 999 } })]);
  });
  test("an event reaches the others at once, not its sender, and no late joiner", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B"),
      c = sink("C");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    expect(hub.event(a, 1, "wave", { e: 1 })).toBe("ok");
    expect(last(b)).toMatchObject({ type: "RoomEvent", event: "wave", data: { e: 1 } });
    expect(a.frames.some((f) => f.type === "RoomEvent")).toBe(false);
    hub.join(c, 1, DOC, { userId: null, canPublish: true });
    expect(c.frames.some((f) => f.type === "RoomEvent")).toBe(false);
  });
  test("a spectator can neither set presence nor send events", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A");
    hub.join(a, 1, DOC, { userId: null, canPublish: false });
    expect(hub.setPresence(a, 1, { x: 1 })).toBe("forbidden");
    expect(hub.event(a, 1, "wave", {})).toBe("forbidden");
  });
  test("over the rate, updates are dropped and reported once a second", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    const r = Array.from({ length: 15 }, () => hub.event(a, 1, "wave", {}));
    expect(r.filter((x) => x === "ok")).toHaveLength(10);
    expect(r.filter((x) => x === "rate_limited")).toHaveLength(5);
    t.advance(1000);
    expect(hub.event(a, 1, "wave", {})).toBe("ok");
  });
  test("the member cap refuses the next joiner", () => {
    const hub = new RoomHub({ ...LIMITS, memberCap: 2 }, fakeTimers());
    expect(hub.join(sink("A"), 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(sink("B"), 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(sink("C"), 1, DOC, { userId: null, canPublish: true })).toBe("limit");
  });
  test("rooms per connection are capped", () => {
    const hub = new RoomHub({ ...LIMITS, roomsPerConnection: 1 }, fakeTimers());
    const a = sink("A");
    expect(hub.join(a, 1, DOC, { userId: null, canPublish: true })).toBe("ok");
    expect(hub.join(a, 2, { ...DOC, argsJson: '{"id":"b"}' }, { userId: null, canPublish: true })).toBe("limit");
  });
});

describe("the reconnect grace", () => {
  test("a reconnect within it keeps the member: no leave, no join, the same memberId and presence", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.setPresence(a, 1, { x: 1 });
    hub.join(b, 1, DOC, { userId: "u2", canPublish: true });
    t.advance(30);
    const memberId = (b.frames.find((f) => f.type === "RoomSync") as v1.RoomSync).members[0]!.memberId;
    b.frames.length = 0;
    hub.detach(a);
    t.advance(4000);
    const a2 = sink("A"); // the same protocol session on a new socket
    hub.join(a2, 1, DOC, { userId: "u1", canPublish: true });
    t.advance(2000);
    expect(b.frames).toEqual([]);
    expect((last(a2) as v1.RoomSync).self).toBe(memberId);
    expect(hub.members(DOC).find((m) => m.memberId === memberId)?.presence).toEqual({ x: 1 });
  });
  test("a rejoined member is the same attachment: leaving after it leaves at once, not after the old grace", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    t.advance(30);
    hub.detach(a);
    const a2 = sink("A");
    hub.join(a2, 1, DOC, { userId: null, canPublish: true });
    b.frames.length = 0;
    hub.leave(a2, 1);
    t.advance(30);
    expect(last(b)).toMatchObject({ type: "RoomMembers", left: [expect.any(String)] });
  });
  test("a half-open socket's attachment does not outlive it: the member leaves once, after the last grace", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a1 = sink("A"),
      b = sink("B");
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    const baseline = hub.size;
    hub.join(a1, 1, DOC, { userId: null, canPublish: true });
    t.advance(30);
    b.frames.length = 0;
    // The old socket is half-open: the client reconnects with the same session, and joins the same member.
    const a2 = sink("A");
    hub.join(a2, 1, DOC, { userId: null, canPublish: true });
    t.advance(1000);
    hub.detach(a1); // the old socket dies at last
    t.advance(1000);
    hub.detach(a2); // and the new one closes within the old one's grace
    t.advance(LIMITS.graceMs * 3);
    expect(hub.size).toEqual(baseline);
    expect(hub.members(DOC)).toHaveLength(1); // B alone
    const leaves = b.frames.flatMap((f) => (f.type === "RoomMembers" ? f.left : []));
    expect(leaves).toHaveLength(1);
    expect(b.frames.filter((f) => f.type === "RoomMembers" && f.set.length > 0)).toEqual([]);
  });
  test("past it the member leaves", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    hub.join(b, 1, DOC, { userId: null, canPublish: true });
    t.advance(30);
    b.frames.length = 0;
    hub.detach(a);
    t.advance(5000 + 30);
    expect(last(b)).toMatchObject({ type: "RoomMembers", left: [expect.any(String)] });
    expect(hub.size).toEqual({ rooms: 1, members: 1 });
  });
  test("a room with no member left is gone: memory returns to its baseline", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    for (let i = 0; i < 100; i++) {
      const s = sink(`S${i}`);
      hub.join(s, 1, { ...DOC, argsJson: `{"i":${i}}` }, { userId: null, canPublish: true });
      hub.leave(s, 1);
    }
    t.advance(30);
    expect(hub.size).toEqual({ rooms: 0, members: 0 });
  });
});

describe("presence scopes", () => {
  test("three tabs of one user are one member, who leaves only after the last tab's grace", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const tabs = [sink("T1"), sink("T2"), sink("T3")],
      other = sink("O");
    for (const s of tabs) hub.join(s, 1, ONLINE, { userId: "u1", canPublish: true });
    hub.join(other, 1, ONLINE, { userId: "u2", canPublish: true });
    expect((last(other) as v1.RoomSync).members).toEqual([
      { memberId: "u1", userId: "u1", presence: null, idle: false },
    ]);
    t.advance(30);
    other.frames.length = 0;
    hub.detach(tabs[0]!);
    hub.leave(tabs[1]!, 1);
    t.advance(6000);
    expect(other.frames).toEqual([]);
    hub.detach(tabs[2]!);
    t.advance(5000 + 30);
    expect(last(other)).toMatchObject({ type: "RoomMembers", left: ["u1"] });
  });
  test("the last write from any tab is the user's state; idle only when every tab is idle", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const t1 = sink("T1"),
      t2 = sink("T2"),
      other = sink("O");
    hub.join(t1, 1, ONLINE, { userId: "u1", canPublish: true });
    hub.join(t2, 1, ONLINE, { userId: "u1", canPublish: true });
    hub.join(other, 1, ONLINE, { userId: "u2", canPublish: true });
    hub.setPresence(t1, 1, { name: "A" }, true);
    hub.setPresence(t2, 1, { name: "B" }, false);
    t.advance(30);
    expect(hub.members(ONLINE).find((m) => m.userId === "u1")).toEqual({
      memberId: "u1",
      userId: "u1",
      presence: { name: "B" },
      idle: false,
    });
    hub.setPresence(t2, 1, { name: "B" }, true);
    t.advance(30);
    expect(hub.members(ONLINE).find((m) => m.userId === "u1")?.idle).toBe(true);
  });
});

describe("no ghost members", () => {
  const who = (userId: string | null) => ({ userId, canPublish: true });
  test("a rejoin within the grace as another user ends the old member at once", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(b, 1, DOC, who("ub"));
    hub.join(a, 1, DOC, who("u1"));
    hub.detach(a);
    const a2 = sink("A");
    hub.join(a2, 1, DOC, who("u2"));
    expect(
      hub
        .members(DOC)
        .map((m) => m.userId)
        .sort(),
    ).toEqual(["u2", "ub"]);
    hub.detach(a2);
    t.advance(5000 + 30);
    expect(hub.members(DOC).map((m) => m.userId)).toEqual(["ub"]);
    expect(hub.size).toEqual({ rooms: 1, members: 1 });
  });
  test("two live sockets of one session as two users are two members; each leaves cleanly", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const b = sink("B");
    hub.join(b, 1, DOC, who("ub"));
    const baseline = hub.size;
    // The old socket is half-open; the client reconnected with the same session and another user.
    const old = sink("S"),
      fresh = sink("S");
    hub.join(old, 1, DOC, who("alice"));
    hub.join(fresh, 1, DOC, who("bob"));
    const alice = (old.frames.find((f) => f.type === "RoomSync") as v1.RoomSync).self;
    const bob = (fresh.frames.find((f) => f.type === "RoomSync") as v1.RoomSync).self;
    expect(bob).not.toBe(alice);
    expect(
      hub
        .members(DOC)
        .map((m) => m.userId)
        .sort(),
    ).toEqual(["alice", "bob", "ub"]);
    hub.leave(old, 1);
    expect(
      hub
        .members(DOC)
        .map((m) => m.userId)
        .sort(),
    ).toEqual(["bob", "ub"]);
    hub.detach(fresh);
    t.advance(LIMITS.graceMs + 30);
    expect(hub.members(DOC).map((m) => m.userId)).toEqual(["ub"]);
    expect(hub.size).toEqual(baseline);
  });
  test("the same roomId joined twice on one sink is one attachment: events arrive once, the member leaves", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(b, 1, DOC, who(null));
    hub.join(a, 1, DOC, who(null));
    hub.join(a, 1, DOC, who(null));
    hub.event(b, 1, "wave", {});
    expect(a.frames.filter((f) => f.type === "RoomEvent")).toHaveLength(1);
    hub.leave(a, 1);
    t.advance(30);
    expect(hub.size).toEqual({ rooms: 1, members: 1 });
  });
  test("a roomId reused for another room leaves the old room", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, who(null));
    hub.join(a, 1, { ...DOC, argsJson: '{"id":"b"}' }, who(null));
    t.advance(30);
    expect(hub.members(DOC)).toEqual([]);
    expect(hub.size).toEqual({ rooms: 1, members: 1 });
  });
  test("two roomIds for the same room key on one sink do not leak at detach", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, who(null));
    hub.join(a, 2, DOC, who(null));
    expect(hub.roomsOf(a)).toHaveLength(1);
    hub.detach(a);
    t.advance(5000 + 30);
    expect(hub.size).toEqual({ rooms: 0, members: 0 });
  });
  test("a scope member who leaves and rejoins in one tick is one set, never a left", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const tab = sink("T"),
      other = sink("O");
    hub.join(tab, 1, ONLINE, who("u1"));
    hub.join(other, 1, ONLINE, who("u2"));
    t.advance(30);
    other.frames.length = 0;
    hub.leave(tab, 1);
    hub.join(tab, 2, ONLINE, who("u1"));
    t.advance(30);
    expect(other.frames).toHaveLength(1);
    expect(last(other)).toMatchObject({ type: "RoomMembers", set: [{ userId: "u1" }], left: [] });
  });
});

describe("backpressure", () => {
  test("a client too far behind is closed for a resync, never sent a partial membership", () => {
    const t = fakeTimers();
    const hub = new RoomHub({ ...LIMITS, maxBufferedBytes: 100 }, t);
    const a = sink("A"),
      slow = sink("S");
    hub.join(slow, 1, DOC, { userId: null, canPublish: true });
    slow.queued = 1000;
    slow.frames.length = 0;
    hub.join(a, 1, DOC, { userId: null, canPublish: true });
    t.advance(30);
    expect(slow.resyncs).toBe(1);
    expect(slow.frames).toEqual([]);
  });
});

const EPOCH = 1_700_000_000_000;
const NOARGS = (name: string): RoomKey => ({ kind: "room", name, argsJson: "{}" });
const who = (userId: string | null = null, canPublish = true) => ({ userId, canPublish });

describe("rooms: the debug snapshot (AD-43)", () => {
  test("list is empty with no rooms", () => {
    expect(new RoomHub(LIMITS, fakeTimers()).list()).toEqual([]);
  });
  test("list: sorted by name then args, with counts, the args parsed, openedAt and a stable key", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const [a, b, c, d] = [sink("A"), sink("B"), sink("C"), sink("D")];
    const docB = { ...DOC, argsJson: '{"id":"b"}' };
    hub.join(a, 1, docB, who("u1"));
    t.advance(100);
    hub.join(b, 1, DOC, who("u2"));
    hub.join(c, 1, DOC, who("u3"));
    // A scope user with two tabs: one member, two connections.
    hub.join(c, 2, ONLINE, who("u3"));
    hub.join(d, 1, ONLINE, who("u3"));
    expect(hub.list()).toEqual([
      {
        key: roomKeyString(DOC),
        kind: "room",
        name: "rooms:doc",
        args: { id: "a" },
        members: 2,
        connections: 2,
        openedAt: EPOCH + 100,
      },
      {
        key: roomKeyString(docB),
        kind: "room",
        name: "rooms:doc",
        args: { id: "b" },
        members: 1,
        connections: 1,
        openedAt: EPOCH,
      },
      {
        key: roomKeyString(ONLINE),
        kind: "presence",
        name: "rooms:online",
        args: {},
        members: 1,
        connections: 2,
        openedAt: EPOCH + 100,
      },
    ]);
  });
  test("list counts graced connections; a room whose last member left is gone", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, who());
    hub.detach(a);
    expect(hub.list()[0]).toMatchObject({ members: 1, connections: 1 });
    t.advance(LIMITS.graceMs + 1);
    expect(hub.list()).toEqual([]);
  });
  test("membersPage: 250 members in pages of 100 by memberId, with the cursor", () => {
    const hub = new RoomHub({ ...LIMITS, memberCap: 1000 }, fakeTimers());
    for (let i = 0; i < 250; i++) hub.join(sink(`s${i}`), 1, DOC, who(`u${i}`));
    const all: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (;;) {
      const r = hub.membersPage(DOC, cursor, 1000);
      sizes.push(r.page.length);
      all.push(...r.page.map((m) => m.memberId));
      if (r.isDone) {
        expect(r.continueCursor).toBe("");
        break;
      }
      expect(r.continueCursor).toBe(r.page.at(-1)!.memberId);
      cursor = r.continueCursor;
    }
    expect(sizes).toEqual([100, 100, 50]);
    expect(new Set(all).size).toBe(250);
    expect(all).toEqual([...all].sort());
    expect(hub.membersPage(DOC, null, 10).page).toHaveLength(10);
  });
  test("membersPage: graced, canPublish, connections, presence, idle, joinedAt and lastActivityAt", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, who("u1", true));
    hub.join(b, 1, DOC, who("u2", false));
    t.advance(500);
    hub.setPresence(a, 1, { x: 1 });
    hub.detach(b);
    const page = hub.membersPage(DOC, null, 100).page;
    const mA = page.find((m) => m.userId === "u1")!;
    const mB = page.find((m) => m.userId === "u2")!;
    expect(mA).toMatchObject({
      presence: { x: 1 },
      canPublish: true,
      graced: false,
      connections: 1,
      joinedAt: EPOCH,
      lastActivityAt: EPOCH + 500,
    });
    expect("idle" in mA).toBe(false);
    expect(mB).toMatchObject({
      presence: null,
      canPublish: false,
      graced: true,
      connections: 1,
      joinedAt: EPOCH,
      lastActivityAt: EPOCH,
    });
    hub.join(sink("C"), 1, ONLINE, who("u9"));
    const scope = hub.membersPage(ONLINE, null, 100).page[0]!;
    expect(scope.idle).toBe(false);
    expect(scope.memberId).toBe("u9");
  });
  test("membersPage: joinedAt is kept across a reconnect within the grace; a closed room is an empty done page", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, who("u1"));
    hub.detach(a);
    t.advance(1000);
    const a2 = sink("A");
    hub.join(a2, 1, DOC, who("u1"));
    expect(hub.membersPage(DOC, null, 100).page[0]).toMatchObject({ joinedAt: EPOCH, graced: false });
    expect(hub.membersPage(NOARGS("rooms:none"), null, 100)).toEqual({ page: [], isDone: true, continueCursor: "" });
  });
});

describe("rooms: the counters (AD-43)", () => {
  const zero = {
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
  const moved = (hub: RoomHub, only: Partial<typeof zero>) => {
    const { rooms: _r, members: _m, connections: _c, ...counters } = hub.stats();
    expect(counters).toEqual({ ...zero, ...only });
  };
  test("a fresh hub reads zero", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    expect(hub.stats()).toEqual({ rooms: 0, members: 0, connections: 0, ...zero });
  });
  test("joins, and the gauges", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    hub.join(sink("A"), 1, DOC, who());
    hub.join(sink("B"), 1, DOC, who());
    moved(hub, { joins: 2 });
    expect(hub.stats()).toMatchObject({ rooms: 1, members: 2, connections: 2 });
  });
  test("a rejoin within the grace counts as a join", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A");
    hub.join(a, 1, DOC, who());
    hub.detach(a);
    hub.join(sink("A"), 1, DOC, who());
    moved(hub, { joins: 2 });
  });
  test("a refusal by the limit", () => {
    const hub = new RoomHub({ ...LIMITS, memberCap: 1 }, fakeTimers());
    hub.join(sink("A"), 1, DOC, who());
    hub.join(sink("B"), 1, DOC, who());
    moved(hub, { joins: 1, joinsRefusedByLimit: 1 });
  });
  test("a refusal by a gate is counted by countGateRefusal", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    hub.countGateRefusal();
    moved(hub, { joinsRefusedByGate: 1 });
  });
  test("a member leaving; a scope tab that leaves while another stays does not", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, ONLINE, who("u1"));
    hub.join(b, 1, ONLINE, who("u1"));
    hub.leave(a, 1);
    moved(hub, { joins: 2 });
    hub.leave(b, 1);
    moved(hub, { joins: 2, leaves: 1 });
  });
  test("a grace expiry ends a membership (and is a leave)", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A");
    hub.join(a, 1, DOC, who());
    hub.detach(a);
    moved(hub, { joins: 1 });
    t.advance(LIMITS.graceMs + 1);
    moved(hub, { joins: 1, leaves: 1, graceExpiries: 1 });
  });
  test("presence and events, accepted and dropped", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A");
    hub.join(a, 1, DOC, who());
    for (let i = 0; i < 41; i++) hub.setPresence(a, 1, { i });
    for (let i = 0; i < 11; i++) hub.event(a, 1, "wave", {});
    moved(hub, { joins: 1, presenceAccepted: 40, presenceDropped: 1, eventsAccepted: 10, eventsDropped: 1 });
  });
  test("a forbidden publish counts as neither", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A");
    hub.join(a, 1, DOC, who(null, false));
    hub.setPresence(a, 1, {});
    hub.event(a, 1, "wave", {});
    moved(hub, { joins: 1 });
  });
  test("a resync", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, who());
    b.queued = LIMITS.maxBufferedBytes + 1;
    hub.join(b, 1, DOC, who());
    moved(hub, { joins: 2, resyncs: 1 });
  });
  test("a RoomLeft sent is counted by countRoomLeft", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    hub.countRoomLeft();
    moved(hub, { roomLeft: 1 });
  });
});

describe("rooms: the event tap (AD-43)", () => {
  /** A hub with one room of two members (a sends, b listens), and its clock. */
  const tapped = () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = sink("A"),
      b = sink("B");
    hub.join(a, 1, DOC, who("u1"));
    hub.join(b, 1, DOC, who("u2"));
    return { t, hub, a, b };
  };
  /** Sends `n` events from `a`, spaced to the rate limit. */
  const send = (x: ReturnType<typeof tapped>, n: number, event = "wave") => {
    for (let i = 0; i < n; i++) {
      x.t.advance(100);
      expect(x.hub.event(x.a, 1, event, { i })).toBe("ok");
    }
  };

  test("no tap until the first poll: events before it are not recorded, and none is kept", async () => {
    const x = tapped();
    send(x, 2);
    expect(x.hub.tapped).toBe(0);
    expect(await x.hub.tapEvents(DOC, null, 0)).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
    expect(x.hub.tapped).toBe(1);
    expect(await x.hub.tapEvents(DOC, 0, 0)).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
  });

  test("a member's events and the server's broadcasts, in seq order, with time, sender and size", async () => {
    const x = tapped();
    const start = await x.hub.tapEvents(DOC, null, 0);
    send(x, 1);
    x.hub.broadcast(DOC, "notice", { text: "hé" });
    const memberId = (x.b.frames.find((f) => f.type === "RoomEvent") as v1.RoomServerEvent).from;
    const got = await x.hub.tapEvents(DOC, start.newCursor, 0);
    expect(got).toEqual({
      events: [
        { seq: 1, at: 1_700_000_000_100, event: "wave", from: memberId, size: 7, data: { i: 0 } },
        { seq: 2, at: 1_700_000_000_100, event: "notice", from: null, size: 14, data: { text: "hé" } },
      ],
      newCursor: 2,
      epoch: expect.any(String),
    });
    expect(memberId).toBeString();
    // from a cursor: only what came after it
    expect((await x.hub.tapEvents(DOC, 1, 0)).events.map((e) => e.seq)).toEqual([2]);
  });

  test("presence changes are not recorded", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    x.hub.setPresence(x.a, 1, { x: 1 });
    x.t.advance(100);
    x.hub.setPresence(x.b, 1, { x: 2 });
    x.t.advance(100);
    expect(await x.hub.tapEvents(DOC, 0, 0)).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
  });

  test("at most 200 events: the oldest dropped, and a cursor behind them told how many were lost", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    send(x, TAP_EVENTS_MAX + 5);
    const got = await x.hub.tapEvents(DOC, 0, 0);
    expect(got.events).toHaveLength(TAP_EVENTS_MAX);
    expect(got.events[0]!.seq).toBe(6);
    expect(got.dropped).toBe(5);
    expect(got.newCursor).toBe(TAP_EVENTS_MAX + 5);
    // a cursor inside the buffer lost nothing
    const inside = await x.hub.tapEvents(DOC, 100, 0);
    expect(inside.dropped).toBeUndefined();
    expect(inside.events[0]!.seq).toBe(101);
  });

  test("data over 16 KiB of JSON is omitted, with its real size", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    const big = "y".repeat(TAP_DATA_MAX_BYTES);
    x.hub.broadcast(DOC, "big", big);
    x.hub.broadcast(DOC, "fits", "y".repeat(TAP_DATA_MAX_BYTES - 2));
    const [b, f] = (await x.hub.tapEvents(DOC, 0, 0)).events;
    expect(b).toMatchObject({ event: "big", data: null, dataOmitted: true, size: TAP_DATA_MAX_BYTES + 2 });
    expect(f!.dataOmitted).toBeUndefined();
    expect(f!.size).toBe(TAP_DATA_MAX_BYTES);
  });

  test("a tap expires 30 s after its last poll; a poll keeps it; a later cursor is answered reset", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    x.t.advance(TAP_IDLE_MS - 1000);
    await x.hub.tapEvents(DOC, 0, 0);
    x.t.advance(TAP_IDLE_MS - 1000);
    expect(x.hub.tapped).toBe(1);
    x.t.advance(1000);
    expect(x.hub.tapped).toBe(0);
    // gone: its events are no longer recorded (the room costs nothing extra)
    send(x, 1);
    // the follower's cursor names a tap that is gone: a new one starts, at 0, and says so
    expect(await x.hub.tapEvents(DOC, 3, 0)).toEqual({
      events: [],
      newCursor: 0,
      reset: true,
      epoch: expect.any(String),
    });
    send(x, 1);
    expect((await x.hub.tapEvents(DOC, 0, 0)).events.map((e) => e.seq)).toEqual([1]);
  });

  test("a cursor ahead of the tap (a server that restarted) is answered reset, at the tap's seq", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    send(x, 2);
    expect(await x.hub.tapEvents(DOC, 9, 0)).toEqual({
      events: [],
      newCursor: 2,
      reset: true,
      epoch: expect.any(String),
    });
  });

  test("no timer is left when there are no taps", async () => {
    const t = fakeTimers();
    let live = 0;
    const counted: Timers = {
      ...t,
      set: (fn, ms) => {
        live++;
        return t.set(() => {
          live--;
          fn();
        }, ms);
      },
      clear: (h) => {
        if (h !== null && h !== undefined) live--;
        t.clear(h);
      },
    };
    const hub = new RoomHub(LIMITS, counted);
    hub.join(sink("A"), 1, DOC, who("u1"));
    t.advance(1000);
    expect(live).toBe(0);
    await hub.tapEvents(DOC, null, 0);
    await hub.tapEvents(DOC, 0, 0);
    t.advance(TAP_IDLE_MS);
    expect(hub.tapped).toBe(0);
    expect(live).toBe(0);
  });

  test("the long poll answers when an event arrives, not at its timeout", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    let answer: Awaited<ReturnType<RoomHub["tapEvents"]>> | null = null;
    void x.hub.tapEvents(DOC, 0, 60_000).then((a) => {
      answer = a;
    });
    await Promise.resolve();
    expect(answer).toBeNull();
    x.hub.broadcast(DOC, "now", 1);
    await Bun.sleep(0);
    expect(answer).toMatchObject({ events: [{ seq: 1, event: "now" }], newCursor: 1 });
  });

  test("the long poll times out with no events and the same cursor; a waiting poll keeps the tap", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    let answer: unknown = null;
    void x.hub.tapEvents(DOC, 0, 45_000).then((a) => {
      answer = a;
    });
    x.t.advance(TAP_IDLE_MS + 1000);
    expect(x.hub.tapped).toBe(1);
    x.t.advance(45_000 - TAP_IDLE_MS - 1000);
    await Bun.sleep(0);
    expect(answer).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
    x.t.advance(TAP_IDLE_MS - 1);
    expect(x.hub.tapped).toBe(1);
    x.t.advance(1);
    expect(x.hub.tapped).toBe(0);
  });

  test("an aborted long poll answers at once", async () => {
    const x = tapped();
    await x.hub.tapEvents(DOC, null, 0);
    const stop = new AbortController();
    const p = x.hub.tapEvents(DOC, 0, 60_000, stop.signal);
    stop.abort();
    expect(await p).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
  });

  test("a room that is not open: closed, no tap; a room that closes ends its tap and wakes the poll", async () => {
    const x = tapped();
    const OTHER: RoomKey = { ...DOC, argsJson: '{"id":"zzz"}' };
    expect(await x.hub.tapEvents(OTHER, null, 0)).toEqual({ events: [], newCursor: 0, closed: true });
    expect(await x.hub.tapEvents(OTHER, 4, 0)).toEqual({ events: [], newCursor: 4, closed: true });
    expect(x.hub.tapped).toBe(0);
    await x.hub.tapEvents(DOC, null, 0);
    const waiting = x.hub.tapEvents(DOC, 0, 60_000);
    x.hub.leave(x.a, 1);
    x.hub.leave(x.b, 1);
    x.t.advance(LIMITS.tickMs);
    expect(await waiting).toEqual({ events: [], newCursor: 0, closed: true });
    expect(x.hub.tapped).toBe(0);
  });

  test("each tap has an epoch: the same in every answer, another once the tap is made again", async () => {
    const x = tapped();
    const first = await x.hub.tapEvents(DOC, null, 0);
    expect(first.epoch).toBeString();
    send(x, 1);
    expect((await x.hub.tapEvents(DOC, 0, 0)).epoch).toBe(first.epoch!);
    x.t.advance(TAP_IDLE_MS);
    // this viewer stalls; another makes the tap again, and its seq passes the old cursor
    expect(x.hub.tapped).toBe(0);
    const other = await x.hub.tapEvents(DOC, null, 0);
    send(x, 3);
    const late = await x.hub.tapEvents(DOC, 1, 0);
    // not a reset by the cursor (it is behind the seq), but another tap, told by its epoch
    expect(late.reset).toBeUndefined();
    expect(late.epoch).toBe(other.epoch!);
    expect(late.epoch).not.toBe(first.epoch!);
  });

  test("several polls waiting on one tap are all answered by one event, and leave no timer", async () => {
    const t = fakeTimers();
    let live = 0;
    const counted: Timers = {
      ...t,
      set: (fn, ms) => {
        live++;
        return t.set(() => {
          live--;
          fn();
        }, ms);
      },
      clear: (h) => {
        if (h !== null && h !== undefined && t.pending(h)) live--;
        t.clear(h);
      },
    };
    const hub = new RoomHub(LIMITS, counted);
    hub.join(sink("A"), 1, DOC, who("u1"));
    t.advance(LIMITS.tickMs);
    await hub.tapEvents(DOC, null, 0);
    const polls = [hub.tapEvents(DOC, 0, 60_000), hub.tapEvents(DOC, 0, 60_000), hub.tapEvents(DOC, 0, 60_000)];
    // the tap's expiry and the three polls' timeouts
    expect(live).toBe(4);
    hub.broadcast(DOC, "now", 1);
    const answers = await Promise.all(polls);
    expect(answers.map((a) => a.events.map((e) => e.seq))).toEqual([[1], [1], [1]]);
    // only the tap's expiry is left
    expect(live).toBe(1);
    t.advance(TAP_IDLE_MS);
    expect(live).toBe(0);
  });

  test("a scope can be tapped (it has no events)", async () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    hub.join(sink("A"), 1, ONLINE, who("u1"));
    expect(await hub.tapEvents(ONLINE, null, 0)).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
  });
});

describe("rooms: the dashboard's removals (AD-43)", () => {
  /** A sink that records evictions, as RoomConnection sends RoomLeft for them. */
  const evicting = (sessionId: string) => {
    const s = sink(sessionId);
    const evicted: { roomId: number; code: string; message: string }[] = [];
    return Object.assign(s, {
      evicted,
      evict: (roomId: number, code: "removed", message: string) => void evicted.push({ roomId, code, message }),
    });
  };
  const REMOVED = { code: "removed", message: "Removed from the dashboard." } as const;
  const memberOf = (hub: RoomHub, key: RoomKey, userId: string) =>
    hub.membersPage(key, null, 100).page.find((m) => m.userId === userId)!.memberId;

  test("removeMember ends the member at once: its sink evicts it, the others see it leave", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = evicting("A"),
      b = evicting("B");
    hub.join(a, 7, DOC, { userId: "u1", canPublish: true });
    hub.join(b, 1, DOC, { userId: "u2", canPublish: true });
    t.advance(30);
    const id = memberOf(hub, DOC, "u1");
    expect(hub.removeMember(DOC, id)).toEqual({ connections: 1 });
    expect(a.evicted).toEqual([{ roomId: 7, ...REMOVED }]);
    expect(b.evicted).toEqual([]);
    expect(hub.membersPage(DOC, null, 100).page.map((m) => m.userId)).toEqual(["u2"]);
    a.frames.length = 0;
    t.advance(30);
    expect(last(b)).toEqual({ type: "RoomMembers", roomId: 1, set: [], left: [id] });
    // the removed sink hears nothing more of the room
    expect(a.frames).toEqual([]);
    hub.broadcast(DOC, "ping", { n: 1 });
    expect(a.frames).toEqual([]);
    // and its later leave of the old room id is a no-op
    hub.leave(a, 7);
    expect(hub.stats()).toMatchObject({ members: 1, leaves: 1 });
  });

  test("a scope user is removed with every tab, on every connection", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const tab1 = evicting("S1"),
      tab2 = evicting("S2"),
      other = evicting("S3");
    hub.join(tab1, 1, ONLINE, { userId: "ada", canPublish: true });
    hub.join(tab2, 4, ONLINE, { userId: "ada", canPublish: true });
    hub.join(other, 1, ONLINE, { userId: "bob", canPublish: true });
    expect(hub.removeMember(ONLINE, "ada")).toEqual({ connections: 2 });
    expect(tab1.evicted).toEqual([{ roomId: 1, ...REMOVED }]);
    expect(tab2.evicted).toEqual([{ roomId: 4, ...REMOVED }]);
    expect(other.evicted).toEqual([]);
    expect(hub.list()[0]).toMatchObject({ members: 1, connections: 1 });
  });

  test("an attachment in its grace leaves; its reconnect within the window is refused as removed", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = evicting("A"),
      b = evicting("B");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.join(b, 1, DOC, { userId: "u2", canPublish: true });
    hub.detach(a);
    expect(hub.removeMember(DOC, memberOf(hub, DOC, "u1"))).toEqual({ connections: 1 });
    expect(a.evicted).toEqual([]);
    // the same session reconnecting within the window: refused, nothing attached, nothing sent
    const a2 = evicting("A");
    expect(hub.join(a2, 1, DOC, { userId: "u1", canPublish: true })).toBe("removed");
    expect(a2.frames).toEqual([]);
    expect(hub.stats()).toMatchObject({ members: 1, leaves: 1, graceExpiries: 0 });
    // asked once: a second join of that session is a fresh member
    expect(hub.join(a2, 2, DOC, { userId: "u1", canPublish: true })).toBe("ok");
    expect(hub.stats().members).toBe(2);
  });

  test("a removal in the grace refuses only that session, and only within the window", () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = evicting("A");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.join(evicting("B"), 1, DOC, { userId: "u2", canPublish: true });
    hub.detach(a);
    hub.removeMember(DOC, memberOf(hub, DOC, "u1"));
    // another session as the same user joins
    expect(hub.join(evicting("C"), 1, DOC, { userId: "u1", canPublish: true })).toBe("ok");
    // past the window the removed session joins again
    t.advance(LIMITS.graceMs);
    expect(hub.join(evicting("A"), 1, DOC, { userId: "u1", canPublish: true })).toBe("ok");
    expect(hub.stats().members).toBe(3);
  });

  test("removeMember of no such member, or of a room not open, is null", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    expect(hub.removeMember(DOC, "nobody")).toBeNull();
    hub.join(evicting("A"), 1, DOC, { userId: "u1", canPublish: true });
    expect(hub.removeMember(DOC, "nobody")).toBeNull();
  });

  test("closeRoom removes everyone: every sink evicted, the room gone from the list, its tap ended", async () => {
    const t = fakeTimers();
    const hub = new RoomHub(LIMITS, t);
    const a = evicting("A"),
      b = evicting("B"),
      c = evicting("C");
    hub.join(a, 1, DOC, { userId: "u1", canPublish: true });
    hub.join(b, 2, DOC, { userId: "u2", canPublish: true });
    hub.join(c, 1, ONLINE, { userId: "ada", canPublish: true });
    await hub.tapEvents(DOC, null, 0);
    const waiting = hub.tapEvents(DOC, 0, 60_000);
    expect(hub.closeRoom(DOC)).toEqual({ members: 2, connections: 2 });
    expect(a.evicted).toEqual([{ roomId: 1, ...REMOVED }]);
    expect(b.evicted).toEqual([{ roomId: 2, ...REMOVED }]);
    expect(c.evicted).toEqual([]);
    expect(hub.list().map((r) => r.kind)).toEqual(["presence"]);
    expect(await waiting).toEqual({ events: [], newCursor: 0, closed: true });
    expect(hub.tapped).toBe(0);
    expect(hub.closeRoom(DOC)).toBeNull();
    t.advance(LIMITS.tickMs);
    expect(hub.stats()).toMatchObject({ rooms: 1, members: 1, leaves: 2 });
  });

  test("a sink without evict is sent RoomLeft by the hub, and it is counted", () => {
    const hub = new RoomHub(LIMITS, fakeTimers());
    const a = sink("A");
    hub.join(a, 3, DOC, { userId: "u1", canPublish: true });
    hub.closeRoom(DOC);
    expect(last(a)).toEqual({ type: "RoomLeft", roomId: 3, ...REMOVED });
    expect(hub.stats().roomLeft).toBe(1);
  });
});

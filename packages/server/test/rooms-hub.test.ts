import { describe, expect, test } from "bun:test";
import type { v1 } from "@bunvex/protocol";
import { RoomHub, type RoomKey, type RoomSink, type Timers } from "../src/rooms/hub.ts";
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
function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    set: (fn, ms) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void due.delete(h as number),
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

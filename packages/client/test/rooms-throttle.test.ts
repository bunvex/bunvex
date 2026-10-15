// Room presence is sent at most every 50 ms, on the leading and trailing edge (AD-42), and the manager's
// ref-counting, rejoin and snapshot rules, with a fake clock and a fake socket.
import { describe, expect, test } from "bun:test";
import type { v1 } from "@bunvex/protocol";
import { RoomManager } from "../src/rooms.ts";

function setup() {
  let t = 1000;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sent: v1.ClientMessage[] = [];
  let open = true;
  const warnings: unknown[][] = [];
  const logger = { logVerbose() {}, log() {}, error() {}, warn: (...a: unknown[]) => warnings.push(a) };
  const rooms = new RoomManager(
    (m) => {
      if (!open) return false;
      sent.push(m);
      return true;
    },
    logger,
    {
      now: () => t,
      setTimeout: (fn, ms) => {
        timers.set(++nextTimer, { at: t + ms, fn });
        return nextTimer;
      },
      clearTimeout: (h) => void timers.delete(h as number),
    },
  );
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = end;
  };
  const presences = () => sent.filter((m): m is v1.RoomPresence => m.type === "RoomPresence");
  return { rooms, sent, advance, presences, warnings, setOpen: (o: boolean) => (open = o) };
}

describe("presence throttle", () => {
  test("10 setPresence within 50 ms send 2 RoomPresence: the first at once, the last at 50 ms", () => {
    const { rooms, advance, presences } = setup();
    const h = rooms.joinRoom<{ x: number }, Record<string, never>>("rooms:doc", {});
    for (let i = 1; i <= 10; i++) {
      h.setPresence({ x: i });
      advance(4);
    }
    expect(presences().map((m) => m.presence)).toEqual([{ x: 1 }]);
    advance(10); // 50 ms after the first
    expect(presences().map((m) => m.presence)).toEqual([{ x: 1 }, { x: 10 }]);
    advance(500);
    expect(presences()).toHaveLength(2);
  });

  test("one setPresence and nothing more is one message", () => {
    const { rooms, advance, presences } = setup();
    rooms.joinRoom<{ x: number }, Record<string, never>>("rooms:doc", {}).setPresence({ x: 1 });
    advance(1000);
    expect(presences()).toHaveLength(1);
  });

  test("after a quiet 50 ms the next one is a leading edge again", () => {
    const { rooms, advance, presences } = setup();
    const h = rooms.joinRoom<number, Record<string, never>>("rooms:doc", {});
    h.setPresence(1);
    advance(60);
    h.setPresence(2);
    expect(presences().map((m) => m.presence)).toEqual([1, 2]);
  });

  test("a presence set before the socket is open goes out once, after the join", () => {
    const { rooms, sent, setOpen } = setup();
    setOpen(false);
    rooms.joinRoom<number, Record<string, never>>("rooms:doc", {}).setPresence(7);
    expect(sent).toEqual([]);
    setOpen(true);
    rooms.onOpen();
    expect(sent.map((m) => m.type)).toEqual(["RoomJoin", "RoomPresence"]);
  });
});

describe("memberships", () => {
  test("equal args in another key order are one membership; the last leave sends RoomLeave", () => {
    const { rooms, sent } = setup();
    const a = rooms.joinRoom("rooms:doc", { a: 1, b: { c: 2, d: 3 } });
    const b = rooms.joinRoom("rooms:doc", { b: { d: 3, c: 2 }, a: 1 });
    expect(sent.filter((m) => m.type === "RoomJoin")).toHaveLength(1);
    a.leave();
    a.leave(); // a second leave of the same handle does nothing
    expect(sent.filter((m) => m.type === "RoomLeave")).toHaveLength(0);
    b.leave();
    expect(sent.filter((m) => m.type === "RoomLeave")).toHaveLength(1);
  });

  test("different args, or a scope of the same name, are separate memberships", () => {
    const { rooms, sent } = setup();
    rooms.joinRoom("rooms:doc", { id: "a" });
    rooms.joinRoom("rooms:doc", { id: "b" });
    rooms.joinPresence("rooms:doc", { id: "a" });
    expect(sent.filter((m) => m.type === "RoomJoin")).toHaveLength(3);
  });

  test("a new socket joins again under a fresh room id, with the last presence", () => {
    const { rooms, sent } = setup();
    const h = rooms.joinRoom<number, Record<string, never>>("rooms:doc", {});
    h.setPresence(5);
    const first = sent.find((m) => m.type === "RoomJoin") as v1.RoomJoin;
    sent.length = 0;
    rooms.onOpen();
    const [join, presence] = sent as [v1.RoomJoin, v1.RoomPresence];
    expect(join.type).toBe("RoomJoin");
    expect(join.roomId).not.toBe(first.roomId);
    expect(presence).toMatchObject({ type: "RoomPresence", roomId: join.roomId, presence: 5 });
    expect(h.status).toBe("joining");
  });

  test("every RoomSync is a full snapshot; others() is stable until members change", () => {
    const { rooms, sent } = setup();
    const h = rooms.joinRoom<{ x: number }, Record<string, never>>("rooms:doc", {});
    let calls = 0;
    h.subscribe(() => calls++);
    const roomId = (sent[0] as v1.RoomJoin).roomId;
    rooms.onMessage({
      type: "RoomSync",
      roomId,
      self: "me",
      canPublish: true,
      members: [{ memberId: "u", userId: null, presence: { x: 1 } }],
    });
    const first = h.others();
    expect(first).toEqual([{ memberId: "u", userId: null, presence: { x: 1 }, idle: false } as never]);
    expect(h.others()).toBe(first);
    expect(h.status).toBe("joined");
    rooms.onMessage({ type: "RoomSync", roomId, self: "me", canPublish: false, members: [] });
    expect(h.others()).toEqual([]);
    expect(h.canPublish).toBe(false);
    expect(calls).toBe(2);
  });

  test("rate_limited and forbidden only warn; no_access is an error and stays so", () => {
    const { rooms, sent, warnings } = setup();
    const h = rooms.joinRoom("rooms:doc", {});
    const roomId = (sent[0] as v1.RoomJoin).roomId;
    rooms.onMessage({ type: "RoomError", roomId, code: "rate_limited", message: "slow" });
    rooms.onMessage({ type: "RoomError", roomId, code: "forbidden", message: "no" });
    expect(h.status).toBe("joining");
    expect(warnings).toHaveLength(2);
    rooms.onMessage({ type: "RoomError", roomId, code: "no_access", message: "nope" });
    expect(h.status).toBe("error");
    expect(h.error).toEqual({ code: "no_access", message: "nope" });
    expect(sent.filter((m) => m.type === "RoomJoin")).toHaveLength(1);
  });
});

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

  test("a presence set and a leave made while the socket is paused go out once, on resume", () => {
    const { rooms, sent, advance, setOpen } = setup();
    const keep = rooms.joinRoom<number, Record<string, never>>("rooms:doc", { id: "keep" });
    const gone = rooms.joinRoom("rooms:doc", { id: "gone" });
    const goneId = (sent[1] as v1.RoomJoin).roomId;
    sent.length = 0;
    setOpen(false); // setAuth paused the socket: sends return false
    keep.setPresence(4);
    gone.leave();
    advance(500);
    expect(sent).toEqual([]);
    setOpen(true);
    rooms.onResume();
    rooms.onResume();
    advance(500);
    expect(sent.map((m) => m.type).sort()).toEqual(["RoomLeave", "RoomPresence"]);
    expect(sent.find((m) => m.type === "RoomLeave")).toMatchObject({ roomId: goneId });
    expect(sent.find((m) => m.type === "RoomPresence")).toMatchObject({ presence: 4 });
  });

  test("a payload error on a joined room warns and keeps the status; a join error is not overwritten", () => {
    const { rooms, sent, warnings } = setup();
    const h = rooms.joinRoom("rooms:doc", {});
    const roomId = (sent[0] as v1.RoomJoin).roomId;
    rooms.onMessage({ type: "RoomSync", roomId, self: "me", canPublish: true, members: [] });
    rooms.onMessage({ type: "RoomError", roomId, code: "validation", message: "bad presence" });
    expect(h.status).toBe("joined");
    expect(h.error).toBeNull();
    expect(warnings).toHaveLength(1);
    const g = rooms.joinRoom("rooms:doc", { id: "x" });
    const gid = (sent.at(-1) as v1.RoomJoin).roomId;
    rooms.onMessage({ type: "RoomError", roomId: gid, code: "no_access", message: "first" });
    rooms.onMessage({ type: "RoomError", roomId: gid, code: "limit", message: "second" });
    expect(g.error).toEqual({ code: "no_access", message: "first" });
  });
});

describe("memberships the server ends, a new identity, and idle per handle", () => {
  const joinOf = (sent: v1.ClientMessage[]) => sent.filter((m): m is v1.RoomJoin => m.type === "RoomJoin").at(-1)!;

  test("RoomLeft on a joined room is terminal: status error, members cleared, and nothing more is sent", () => {
    const { rooms, sent, advance } = setup();
    const h = rooms.joinRoom<{ x: number }, { wave: number }>("rooms:doc", {});
    const roomId = joinOf(sent).roomId;
    rooms.onMessage({
      type: "RoomSync",
      roomId,
      self: "me",
      canPublish: true,
      members: [{ memberId: "u", userId: null, presence: null }],
    });
    let calls = 0;
    h.subscribe(() => calls++);
    rooms.onMessage({ type: "RoomLeft", roomId, code: "no_access", message: "You cannot join this room." });
    expect(h.status).toBe("error");
    expect(h.error).toEqual({ code: "no_access", message: "You cannot join this room." });
    expect(h.others()).toEqual([]);
    expect(h.canPublish).toBe(false);
    expect(calls).toBe(1);
    sent.length = 0;
    h.setPresence({ x: 1 });
    h.broadcast("wave", 1);
    advance(500);
    expect(sent).toEqual([]);
  });

  test("a refused room sends no presence or event (no warning spam); a retry carries the presence", () => {
    const { rooms, sent, advance } = setup();
    const h = rooms.joinRoom<{ x: number }, { wave: number }>("rooms:doc", {});
    rooms.onMessage({ type: "RoomError", roomId: joinOf(sent).roomId, code: "no_access", message: "no" });
    sent.length = 0;
    h.setPresence({ x: 2 });
    h.broadcast("wave", 1);
    advance(500);
    expect(sent).toEqual([]);
    rooms.onAuthenticate();
    expect(sent.map((m) => m.type)).toEqual(["RoomJoin", "RoomPresence"]);
    expect(sent[1]).toMatchObject({ roomId: (sent[0] as v1.RoomJoin).roomId, presence: { x: 2 } });
  });

  test("a new Authenticate rejoins memberships in error under a fresh room id, and leaves the others alone", () => {
    const { rooms, sent } = setup();
    const refused = rooms.joinPresence("rooms:online", {});
    const refusedId = joinOf(sent).roomId;
    const ok = rooms.joinRoom("rooms:doc", {});
    const okId = joinOf(sent).roomId;
    rooms.onMessage({ type: "RoomError", roomId: refusedId, code: "no_access", message: "sign in" });
    rooms.onMessage({ type: "RoomSync", roomId: okId, self: "me", canPublish: true, members: [] });
    sent.length = 0;
    rooms.onAuthenticate();
    expect(sent).toHaveLength(1);
    const again = sent[0] as v1.RoomJoin;
    expect(again).toMatchObject({ type: "RoomJoin", kind: "presence", name: "rooms:online" });
    expect(again.roomId).not.toBe(refusedId);
    expect(again.roomId).not.toBe(okId);
    expect(refused.status).toBe("joining");
    expect(refused.error).toBeNull();
    expect(ok.status).toBe("joined");
    rooms.onMessage({ type: "RoomSync", roomId: again.roomId, self: "ada", canPublish: true, members: [] });
    expect(refused.status).toBe("joined");
    // The old id is no longer this membership's.
    rooms.onMessage({ type: "RoomError", roomId: refusedId, code: "no_access", message: "late" });
    expect(refused.status).toBe("joined");
  });

  test("a join in flight when Authenticate went out, refused under the old identity, is retried", () => {
    const { rooms, sent } = setup();
    const p = rooms.joinPresence("rooms:online", {});
    const first = joinOf(sent).roomId;
    rooms.onAuthenticate(); // the RoomJoin went out before it; its answer is not in yet
    expect(sent.filter((m) => m.type === "RoomJoin")).toHaveLength(1);
    rooms.onMessage({ type: "RoomError", roomId: first, code: "no_access", message: "sign in" });
    expect(p.status).toBe("joining");
    const retry = joinOf(sent);
    expect(retry.roomId).not.toBe(first);
    rooms.onMessage({ type: "RoomError", roomId: retry.roomId, code: "no_access", message: "still no" });
    expect(p.status).toBe("error"); // under the new identity: final
  });

  test("RoomLeft memberships rejoin on the next Authenticate", () => {
    const { rooms, sent } = setup();
    const h = rooms.joinRoom("rooms:doc", {});
    const roomId = joinOf(sent).roomId;
    rooms.onMessage({ type: "RoomSync", roomId, self: "me", canPublish: true, members: [] });
    rooms.onMessage({ type: "RoomLeft", roomId, code: "no_access", message: "no" });
    sent.length = 0;
    rooms.onAuthenticate();
    expect(sent.map((m) => m.type)).toEqual(["RoomJoin"]);
    expect(h.status).toBe("joining");
  });

  test("args differing only by a __proto__ key are separate client keys", async () => {
    const { canonical } = await import("../src/rooms.ts");
    expect(canonical(JSON.parse('{"x":1,"__proto__":{"y":2}}'))).not.toBe(canonical({ x: 1 }));
    expect(canonical(JSON.parse('{"__proto__":{"y":2},"x":1}'))).toBe('{"__proto__":{"y":2},"x":1}');
  });

  test("idle is per handle: the idle handle's leave makes the membership active for the one that remains", () => {
    const { rooms, presences, advance } = setup();
    const a = rooms.joinPresence<{ s: number }>("rooms:online", {});
    const b = rooms.joinPresence<{ s: number }>("rooms:online", {});
    b.setState({ s: 1 });
    a.setIdle(true);
    advance(60);
    expect(presences().at(-1)).toMatchObject({ presence: { s: 1 }, idle: true });
    a.leave(); // as React runs a component's cleanups: the handle's leave, then its idle reset (dropped)
    a.setIdle(false);
    advance(60);
    expect(presences().at(-1)).toMatchObject({ presence: { s: 1 }, idle: false });
    expect(b.status).toBe("joining");
  });

  test("a membership is idle only when every handle that reported idle says so", () => {
    const { rooms, presences, advance } = setup();
    const a = rooms.joinPresence<{ s: number }>("rooms:online", {});
    const b = rooms.joinPresence<{ s: number }>("rooms:online", {});
    a.setState({ s: 1 });
    a.setIdle(true);
    b.setIdle(false);
    advance(60);
    expect(presences().at(-1)?.idle).toBe(false);
    b.setIdle(true);
    advance(60);
    expect(presences().at(-1)?.idle).toBe(true);
  });
});

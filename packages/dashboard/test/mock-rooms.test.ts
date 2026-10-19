// The mock's rooms (AD-43, STUDY-165): a `rooms:doc` room whose members' cursors move with the clock, a
// `presence:online` scope with a user on two tabs and one idle, definitions that match them, and counters that
// move on. Deterministic for a seed and a clock; the contract suite (mock.test.ts) covers the shapes.
import { describe, expect, test } from "bun:test";
import { DataSourceError, type RoomEvent, type RoomEventsInfo } from "@bunvex/dashboard/data-source";
import { MockDataSource } from "@bunvex/dashboard/mock";

const NOW = Date.UTC(2026, 8, 29, 12);
const make = (extra = {}) => new MockDataSource({ seed: 7, now: NOW, statsIntervalMs: 5, ...extra });
const at = (src: MockDataSource, t: number) => {
  src.scheduler.now = () => t;
  return src;
};

describe("MockDataSource rooms", () => {
  test("a document room with five members and a scope with three users, one on two tabs and one idle", async () => {
    const src = make();
    expect(typeof src.listRooms).toBe("function");
    const rooms = await src.listRooms!();
    expect(rooms.map((r) => [r.kind, r.name, r.members])).toEqual([
      ["presence", "presence:online", 3],
      ["room", "rooms:doc", 5],
    ]);
    const doc = rooms.find((r) => r.name === "rooms:doc")!;
    expect(doc.args).toEqual({ id: expect.any(String) });
    const scope = rooms.find((r) => r.kind === "presence")!;
    expect(scope.connections).toBe(4);
    const users = (await src.listRoomMembers!({ key: scope.key }, { numItems: 10, cursor: null })).page;
    expect(users.map((m) => m.connections).sort()).toEqual([1, 1, 2]);
    expect(users.filter((m) => m.idle === true)).toHaveLength(1);
    expect(users.every((m) => m.userId !== null)).toBe(true);
  });

  test("cursor presence moves with the clock, and is the same for the same clock", async () => {
    const cursors = async (t: number) => {
      const src = at(make(), t);
      const [room] = (await src.listRooms!()).filter((r) => r.kind === "room");
      return (await src.listRoomMembers!({ key: room!.key }, { numItems: 10, cursor: null })).page.map(
        (m) => m.presence,
      );
    };
    const a = await cursors(NOW);
    expect(a).toEqual(await cursors(NOW));
    expect(a).not.toEqual(await cursors(NOW + 2_000));
    for (const p of a) expect(p).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
  });

  test("definitions match the open rooms", async () => {
    const src = make();
    const defs = await src.listRoomDefinitions!();
    expect(defs.map((d) => d.name)).toEqual(["presence:online", "rooms:doc"]);
    const doc = defs.find((d) => d.name === "rooms:doc")!;
    expect(doc).toMatchObject({ kind: "room", module: "rooms.js" });
    expect(doc.events.length).toBeGreaterThan(0);
    expect(defs.find((d) => d.kind === "presence")!.state).not.toBeUndefined();
  });

  test("the stats carry the rooms: gauges that match the list, counters that only grow", async () => {
    const src = make();
    const first = (await src.getStats()).rooms!;
    expect(first).toMatchObject({ rooms: 2, members: 8, connections: 9 });
    const seen: number[] = [first.presenceAccepted];
    await new Promise<void>((resolve) => {
      const off = src.watchStats(
        (s) => {
          seen.push(s.rooms!.presenceAccepted);
          expect(s.rooms).toMatchObject({ rooms: 2, members: 8 });
          if (seen.length > 4) {
            off();
            resolve();
          }
        },
        () => {},
      );
    });
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)!).toBeGreaterThan(seen[0]!);
  });

  test("a credential without ViewMetrics is refused", async () => {
    const src = make({ capabilities: { operations: ["viewData"], readOnly: false } });
    for (const call of [
      () => src.listRooms!(),
      () => src.listRoomDefinitions!(),
      () => src.listRoomMembers!({ key: "x" }, { numItems: 1, cursor: null }),
    ]) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DataSourceError);
      expect((e as DataSourceError).code).toBe("unauthorized");
    }
  });

  test("a numItems that is NaN gives the default page, not a broken one", async () => {
    const src = make();
    const [room] = await src.listRooms!();
    const p = await src.listRoomMembers!({ key: room!.key }, { numItems: Number.NaN, cursor: null });
    expect(p.page).toHaveLength(room!.members);
    expect(p.isDone).toBe(true);
  });
});

test("a test can close a room: it leaves the list, its members count as leaves, its members page is empty", async () => {
  const src = new MockDataSource({ seed: 3 });
  const before = await src.listRooms!();
  const room = before[0]!;
  const leaves = (await src.getStats()).rooms!.leaves;
  expect(src.rooms.close(room.key)).toBe(true);
  expect((await src.listRooms!()).map((r) => r.key)).not.toContain(room.key);
  expect((await src.getStats()).rooms!.leaves).toBe(leaves + room.members);
  expect(await src.listRoomMembers!({ key: room.key }, { numItems: 10, cursor: null })).toEqual({
    page: [],
    isDone: true,
    continueCursor: "",
  });
  expect(src.rooms.close(room.key)).toBe(false);
});

describe("MockDataSource rooms: the event tap", () => {
  type Batch = { events: RoomEvent[]; info: RoomEventsInfo };
  const tap = (src: MockDataSource, key: string) => {
    const batches: Batch[] = [];
    const errors: DataSourceError[] = [];
    let closed = 0;
    const off = src.watchRoomEvents!(
      { key },
      (events, info) => batches.push({ events, info }),
      (e) => errors.push(e),
      () => closed++,
    );
    return { batches, errors, off, closed: () => closed, events: () => batches.flatMap((b) => b.events) };
  };
  const docKey = async (src: MockDataSource) => (await src.listRooms!()).find((r) => r.kind === "room")!.key;

  test("the document room waves on the mock's clock: one per interval it passes, none while it stands still", async () => {
    let t = NOW;
    const src = make({ roomEventIntervalMs: 3000 });
    src.scheduler.now = () => t;
    const w = tap(src, await docKey(src));
    await Bun.sleep(150);
    expect(w.events()).toEqual([]);
    t += 3000 * 3;
    await until(() => w.events().length === 3);
    await Bun.sleep(150);
    expect(w.events()).toHaveLength(3);
    const first = Math.floor(NOW / 3000) + 1;
    expect(w.events().map((e) => e.at)).toEqual([first, first + 1, first + 2].map((k) => k * 3000));
    expect(w.events().every((e) => e.event === "wave" && typeof e.from === "string")).toBe(true);
    expect(w.events()[0]!.size).toBe(JSON.stringify(w.events()[0]!.data).length);
    w.off();
  });

  test("a wave is the same for the same seed and mock time, whenever its tap started", async () => {
    let t = NOW;
    const a = make({ roomEventIntervalMs: 3000 });
    const b = make({ roomEventIntervalMs: 3000 });
    a.scheduler.now = () => t;
    b.scheduler.now = () => t;
    const wa = tap(a, await docKey(a));
    t += 3000;
    await until(() => wa.events().length === 1);
    const wb = tap(b, await docKey(b));
    t += 3000 * 2;
    await until(() => wa.events().length === 3 && wb.events().length === 2);
    const view = (e: RoomEvent) => [e.at, e.from, e.data];
    expect(wb.events().map(view)).toEqual(wa.events().slice(1).map(view));
    wa.off();
    wb.off();
  });

  test("a document room with no member who may publish waves from the server", async () => {
    let t = NOW;
    const src = make({ roomEventIntervalMs: 3000 });
    src.scheduler.now = () => t;
    const internals = src.rooms as unknown as { open: { seats: { member: { canPublish: boolean } }[] }[] };
    for (const r of internals.open) for (const s of r.seats) s.member.canPublish = false;
    const w = tap(src, await docKey(src));
    t += 3000;
    await until(() => w.events().length === 1);
    expect(w.events()[0]!.from).toBeNull();
    w.off();
  });

  test("a test pushes an event; a tap sees only what came after it, never synchronously", async () => {
    const src = make({ roomEventIntervalMs: 60_000 });
    const key = await docKey(src);
    src.rooms.emit(key, "ping", { at: 1 });
    const t = tap(src, key);
    src.rooms.emit(key, "ping", { at: 2 });
    expect(t.batches).toHaveLength(0);
    await until(() => t.events().length === 1);
    expect(t.batches[0]).toEqual({
      events: [{ seq: 1, at: expect.any(Number), event: "ping", from: null, size: 8, data: { at: 2 } }],
      info: { dropped: 0, gap: false },
    });
    t.off();
  });

  test("data over 16 KiB is omitted with its real size", async () => {
    const src = make({ roomEventIntervalMs: 60_000 });
    const key = await docKey(src);
    const t = tap(src, key);
    src.rooms.emit(key, "big", "y".repeat(16 * 1024));
    await until(() => t.events().length === 1);
    expect(t.events()[0]).toMatchObject({ data: null, dataOmitted: true, size: 16 * 1024 + 2 });
    t.off();
  });

  test("closing the room ends the tap with onClosed; a room that is not open is closed at once", async () => {
    const src = make({ roomEventIntervalMs: 60_000 });
    const key = await docKey(src);
    const t = tap(src, key);
    src.rooms.close(key);
    expect(t.closed()).toBe(0);
    await until(() => t.closed() === 1);
    src.rooms.emit(key, "late", 1);
    await Bun.sleep(20);
    expect(t.batches).toHaveLength(0);
    const none = tap(src, key);
    await until(() => none.closed() === 1);
  });

  test("a stopped tap is called no more", async () => {
    let now = NOW;
    const src = make({ roomEventIntervalMs: 3000 });
    src.scheduler.now = () => now;
    const t = tap(src, await docKey(src));
    now += 3000;
    await until(() => t.batches.length > 0);
    t.off();
    const n = t.batches.length;
    now += 3000 * 5;
    await Bun.sleep(150);
    expect(t.batches).toHaveLength(n);
  });

  test("a malformed key, and a credential without ViewMetrics, are terminal errors", async () => {
    const bad = tap(make(), "garbage");
    await until(() => bad.errors.length === 1);
    expect(bad.errors[0]!.code).toBe("invalid_request");
    const src = make({ capabilities: { operations: ["viewData"], readOnly: false } });
    const no = tap(src, "room|rooms:doc|{}");
    await until(() => no.errors.length === 1);
    expect(no.errors[0]!.code).toBe("unauthorized");
  });
});

async function until(done: () => boolean) {
  for (let i = 0; !done(); i++) {
    if (i > 200) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

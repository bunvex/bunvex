// The mock's rooms (AD-43, STUDY-165): a `rooms:doc` room whose members' cursors move with the clock, a
// `presence:online` scope with a user on two tabs and one idle, definitions that match them, and counters that
// move on. Deterministic for a seed and a clock; the contract suite (mock.test.ts) covers the shapes.
import { describe, expect, test } from "bun:test";
import { DataSourceError } from "@bunvex/dashboard/data-source";
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

// The contract suite's part for the rooms (AD-43, data-source-rooms.ts). Read-only, so it runs whenever the source
// offers the screen and the credential may see metrics: the open rooms in order, a room's members paged by
// `memberId` with the cursor passed through and `numItems` capped at 100, a room that is not open an empty done
// page, the definitions, and the rooms' counters in the stats. A live run opens the rooms before it asserts.
import { expect } from "bun:test";
import type { DashboardDataSource, Page, RoomMember } from "./data-source.ts";

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
};

const canSee = async (src: DashboardDataSource) => (await src.getCapabilities()).operations.includes("viewMetrics");
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function expectRoomMember(m: RoomMember, kind: "room" | "presence") {
  expect(typeof m.memberId).toBe("string");
  expect(m.userId === null || typeof m.userId === "string").toBe(true);
  expect(m.presence === undefined).toBe(false);
  expect(typeof m.canPublish).toBe("boolean");
  expect(typeof m.graced).toBe("boolean");
  expect(m.connections).toBeGreaterThanOrEqual(0);
  expect(m.lastActivityAt).toBeGreaterThanOrEqual(m.joinedAt);
  // only a scope's members can be idle
  if (kind === "presence") expect(typeof m.idle).toBe("boolean");
  else expect(m.idle).toBeUndefined();
}

export function describeRoomsContract({ make, test }: Ctx) {
  test("rooms (when offered): the open rooms, by name then key, each with members", async () => {
    const src = await make();
    if (!src.listRooms || !(await canSee(src))) return;
    const rooms = await src.listRooms();
    expect(new Set(rooms.map((r) => r.key)).size).toBe(rooms.length);
    for (const r of rooms) {
      expect(["room", "presence"]).toContain(r.kind);
      expect(typeof r.name).toBe("string");
      expect(r.members).toBeGreaterThanOrEqual(1);
      expect(r.connections).toBeGreaterThanOrEqual(r.members);
      expect(r.openedAt).toBeGreaterThan(0);
      expect(r.args).not.toBeUndefined();
    }
    // by name, then key, as the server sorts
    expect(
      rooms.every((r, i) => i === 0 || byText(rooms[i - 1]!.name, r.name) || byText(rooms[i - 1]!.key, r.key) < 0),
    ).toBe(true);
    expect(rooms.every((r, i) => i === 0 || byText(rooms[i - 1]!.name, r.name) <= 0)).toBe(true);
  });

  test("rooms (when offered): a room's members page by memberId, the cursor passed through", async () => {
    const src = await make();
    if (!src.listRooms || !src.listRoomMembers || !(await canSee(src))) return;
    const rooms = await src.listRooms();
    expect(rooms.length).toBeGreaterThan(0);
    for (const r of rooms) {
      const everyone = await src.listRoomMembers({ key: r.key }, { numItems: 100, cursor: null });
      expect(everyone.isDone).toBe(true);
      expect(everyone.page).toHaveLength(r.members);
      const ids = everyone.page.map((m) => m.memberId);
      expect(ids).toEqual([...ids].sort(byText));
      for (const m of everyone.page) expectRoomMember(m, r.kind);
      // the same members, two at a time
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 100; pages++) {
        const p: Page<RoomMember> = await src.listRoomMembers({ key: r.key }, { numItems: 2, cursor });
        expect(p.page.length).toBeLessThanOrEqual(2);
        seen.push(...p.page.map((m) => m.memberId));
        if (p.isDone) {
          expect(p.continueCursor).toBe("");
          break;
        }
        expect(p.continueCursor).not.toBe("");
        cursor = p.continueCursor;
      }
      expect(seen).toEqual(ids);
    }
  });

  test("rooms (when offered): numItems over 100 is capped at 100", async () => {
    const src = await make();
    if (!src.listRooms || !src.listRoomMembers || !(await canSee(src))) return;
    for (const r of await src.listRooms()) {
      const p = await src.listRoomMembers({ key: r.key }, { numItems: 5000, cursor: null });
      expect(p.page.length).toBeLessThanOrEqual(100);
      if (r.members > 100) {
        expect(p.page).toHaveLength(100);
        expect(p.isDone).toBe(false);
      }
    }
  });

  test("rooms (when offered): a room that is not open is an empty, done page", async () => {
    const src = await make();
    if (!src.listRoomMembers || !(await canSee(src))) return;
    const none = await src.listRoomMembers({ key: "room|no/such:room|{}" }, { numItems: 10, cursor: null });
    expect(none).toEqual({ page: [], isDone: true, continueCursor: "" });
  });

  test("rooms (when offered): the definitions, by name, one for each open room", async () => {
    const src = await make();
    if (!src.listRoomDefinitions || !(await canSee(src))) return;
    const defs = await src.listRoomDefinitions();
    expect(defs.map((d) => d.name)).toEqual(defs.map((d) => d.name).sort(byText));
    for (const d of defs) {
      expect(["room", "presence"]).toContain(d.kind);
      expect(d.module).toMatch(/\.js$/);
      expect(d.args === null || typeof d.args.type === "string").toBe(true);
      expect(Array.isArray(d.events)).toBe(true);
      for (const e of d.events) {
        expect(typeof e.name).toBe("string");
        expect(e.payload === null || typeof e.payload.type === "string").toBe(true);
      }
      if (d.kind === "presence") expect(d.state).not.toBeUndefined();
      else expect(d.presence).not.toBeUndefined();
    }
    if (!src.listRooms) return;
    for (const r of await src.listRooms()) expect(defs.some((d) => d.kind === r.kind && d.name === r.name)).toBe(true);
  });

  test("rooms (when offered): the stats carry the rooms' gauges and counters, which match the list", async () => {
    const src = await make();
    if (!src.listRooms || !(await canSee(src))) return;
    const s = (await src.getStats()).rooms;
    expect(s).toBeDefined();
    for (const [k, v] of Object.entries(s!)) {
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v) && v >= 0).toBe(true);
      expect(k.length).toBeGreaterThan(0);
    }
    expect(Object.keys(s!).sort()).toEqual(
      [
        "rooms",
        "members",
        "connections",
        "joins",
        "joinsRefusedByGate",
        "joinsRefusedByLimit",
        "leaves",
        "graceExpiries",
        "presenceAccepted",
        "presenceDropped",
        "eventsAccepted",
        "eventsDropped",
        "resyncs",
        "roomLeft",
      ].sort(),
    );
    const rooms = await src.listRooms();
    expect(s!.rooms).toBe(rooms.length);
    expect(s!.members).toBe(rooms.reduce((n, r) => n + r.members, 0));
    expect(s!.joins).toBeGreaterThanOrEqual(s!.members);
  });
}

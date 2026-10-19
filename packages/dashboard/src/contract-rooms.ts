// The contract suite's part for the rooms (AD-43, data-source-rooms.ts). Read-only, so it runs whenever the source
// offers the screen and the credential may see metrics: the open rooms in order, a room's members paged by
// `memberId` with the cursor passed through and `numItems` capped at 100, a room that is not open an empty done
// page, the definitions, and the rooms' counters in the stats. A live run opens the rooms before it asserts. The
// event tap: a room that is not open is closed at once; with `roomEvents`, a tap sees what is sent after it starts
// and not before, in seq order, until it is stopped, and a room that closes under it ends it.
import { expect } from "bun:test";
import {
  type DashboardDataSource,
  DataSourceError,
  type Page,
  type RoomEvent,
  type RoomEventsInfo,
  type RoomMember,
  type Value,
} from "./data-source.ts";

/** An open room the suite may send events into (as a member or the server would) and close. */
export type ContractRoom = {
  key: string;
  emit(event: string, data: Value): Promise<void>;
  /** Ends the room, as its last member leaving would. */
  close(): Promise<void>;
};

export type RoomsContractOptions = {
  /** Enables the event tap's tests: opens a room for one test (the suite closes it at the end). */
  roomEvents?: { open(src: DashboardDataSource): Promise<ContractRoom> };
};

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
  opts: RoomsContractOptions;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `done` every 20 ms until it holds, or fails after `ms`. */
async function until(done: () => boolean, ms: number, what: string) {
  for (const end = Date.now() + ms; !done(); await sleep(20))
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

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

export function describeRoomsContract({ make, test, watchTimeoutMs, opts }: Ctx) {
  test("rooms (when offered): a tap on a room that is not open is closed, never synchronously", async () => {
    const src = await make();
    if (!src.watchRoomEvents || !(await canSee(src))) return;
    let closed = 0;
    let other = 0;
    const off = src.watchRoomEvents(
      { key: "room|no/such:room|{}" },
      () => other++,
      () => other++,
      () => closed++,
    );
    expect(closed).toBe(0);
    await until(() => closed > 0, watchTimeoutMs, "onClosed");
    await sleep(50);
    off();
    expect(closed).toBe(1);
    expect(other).toBe(0);
  });

  test("rooms (when offered): a tap sees what is sent after it starts, not before, in seq order, until stopped", async () => {
    const src = await make();
    if (!src.watchRoomEvents || !opts.roomEvents || !(await canSee(src))) return;
    const room = await opts.roomEvents.open(src);
    try {
      await room.emit("wave", { mark: "before" });
      const seen: RoomEvent[] = [];
      const infos: RoomEventsInfo[] = [];
      const errors: DataSourceError[] = [];
      let calls = 0;
      const off = src.watchRoomEvents(
        { key: room.key },
        (events, info) => {
          calls++;
          seen.push(...events);
          infos.push(info);
        },
        (e) => errors.push(e),
      );
      expect(calls).toBe(0);
      const marks = () => seen.map((e) => (e.data as { mark?: unknown } | null)?.mark).filter((m) => m !== undefined);
      // the tap starts when the source's first request lands: send until one is seen
      for (let i = 0, end = Date.now() + watchTimeoutMs; !marks().some((m) => typeof m === "number"); i++) {
        if (Date.now() > end) throw new Error("no event reached the tap");
        await room.emit("wave", { mark: i });
        // under a room's default rate limit (10 events a second)
        await sleep(150);
      }
      await room.emit("wave", { mark: "x1" });
      await sleep(150);
      await room.emit("wave", { mark: "x2" });
      await until(() => marks().includes("x2"), watchTimeoutMs, "the events after the start");
      expect(marks()).not.toContain("before");
      // in the order sent, and in seq order
      expect(marks().slice(-2)).toEqual(["x1", "x2"]);
      for (let i = 1; i < seen.length; i++) expect(seen[i]!.seq).toBeGreaterThan(seen[i - 1]!.seq);
      for (const e of seen) {
        expect(typeof e.event).toBe("string");
        expect(e.from === null || typeof e.from === "string").toBe(true);
        expect(e.size).toBeGreaterThan(0);
        expect(e.at).toBeGreaterThan(0);
      }
      expect(seen.find((e) => (e.data as { mark?: unknown })?.mark === "x2")!.event).toBe("wave");
      expect(infos.every((x) => x.dropped === 0 && x.gap === false)).toBe(true);
      expect(errors).toEqual([]);
      off();
      const before = calls;
      await room.emit("wave", { mark: "after-stop" });
      await sleep(300);
      expect(calls).toBe(before);
    } finally {
      await room.close();
    }
  });

  test("rooms (when offered): a room that closes under a tap ends it with onClosed", async () => {
    const src = await make();
    if (!src.watchRoomEvents || !opts.roomEvents || !(await canSee(src))) return;
    const room = await opts.roomEvents.open(src);
    let closed = 0;
    let errors = 0;
    let gaps = 0;
    const off = src.watchRoomEvents(
      { key: room.key },
      (_events, info) => {
        if (info.gap) gaps++;
      },
      () => errors++,
      () => closed++,
    );
    try {
      // let the tap start, then end the room
      await sleep(200);
      await room.close();
      await until(() => closed > 0, watchTimeoutMs, "onClosed");
      await sleep(100);
      expect(closed).toBe(1);
      expect(errors).toBe(0);
      expect(gaps).toBe(0);
    } finally {
      off();
    }
  });

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
    // by name, then key, as the server sorts (keys are unique, so strictly)
    expect(
      rooms.every((r, i) => i === 0 || (byText(rooms[i - 1]!.name, r.name) || byText(rooms[i - 1]!.key, r.key)) < 0),
    ).toBe(true);
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

  test("rooms (when offered): a malformed key is refused as invalid_request, like the server's 400", async () => {
    const src = await make();
    if (!src.listRoomMembers || !(await canSee(src))) return;
    for (const key of ["", "garbage", "nope|rooms:doc|{}", "room|only-one-bar"]) {
      const e = await src.listRoomMembers({ key }, { numItems: 10, cursor: null }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DataSourceError);
      expect((e as DataSourceError).code).toBe("invalid_request");
      expect((e as DataSourceError).message).toBe("`key` is not a room key from the list.");
    }
  });

  test("rooms (when offered): a numItems that is not a number asks for the default page", async () => {
    const src = await make();
    if (!src.listRooms || !src.listRoomMembers || !(await canSee(src))) return;
    const [room] = await src.listRooms();
    if (!room) return;
    const p = await src.listRoomMembers({ key: room.key }, { numItems: Number.NaN, cursor: null });
    expect(p.page).toHaveLength(Math.min(room.members, 100));
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
    // (assumes the test controls the clients: nobody joins or leaves between the two reads)
    expect(s!.rooms).toBe(rooms.length);
    expect(s!.members).toBe(rooms.reduce((n, r) => n + r.members, 0));
    expect(s!.joins).toBeGreaterThanOrEqual(s!.members);
  });
}

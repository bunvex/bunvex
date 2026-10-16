// The rooms (AD-43, STUDY-165): `/api/debug/rooms`, `/members` and `/definitions` read as the contract's types —
// the admin key, the key and the cursor passed through, `numItems` capped at 100, the values as the contract's —
// and what a server without rooms answers.
import { describe, expect, test } from "bun:test";
import { DataSourceError, type RoomDefinition } from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { roomStatsOf, roomsReads } from "../src/rooms.ts";

function answering(respond: (url: URL) => Response) {
  const asked: Request[] = [];
  const http = new AdminHttp({
    url: "http://x",
    adminKey: "k",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(String(input), init);
      asked.push(req);
      return Promise.resolve(respond(new URL(req.url)));
    }) as typeof fetch,
  });
  return { rooms: roomsReads(http), asked };
}

const member = (over = {}) => ({
  memberId: "m1",
  userId: "u1",
  presence: { x: 1, big: { $integer: "BQAAAAAAAAA=" }, raw: { $bytes: "AQID" } },
  canPublish: true,
  graced: false,
  connections: 1,
  joinedAt: 10,
  lastActivityAt: 20,
  ...over,
});

describe("listRooms", () => {
  test("the route with the admin key; the rooms as the server lists them", async () => {
    const room = {
      key: "room|a:b|{}",
      kind: "room",
      name: "a:b",
      args: {},
      members: 1,
      connections: 1,
      openedAt: 5,
      extra: 1,
    };
    const { rooms, asked } = answering(() => Response.json({ rooms: [room] }));
    expect(await rooms.listRooms()).toEqual([
      { key: "room|a:b|{}", kind: "room", name: "a:b", args: {}, members: 1, connections: 1, openedAt: 5 },
    ]);
    expect(new URL(asked[0]!.url).pathname).toBe("/api/debug/rooms");
    expect(asked[0]!.headers.get("authorization")).toBe("Bunvex k");
  });

  test("a server without rooms answers 404: a not_found that says so", async () => {
    const { rooms } = answering(() => new Response("not found", { status: 404 }));
    for (const call of [
      () => rooms.listRooms(),
      () => rooms.listRoomMembers({ key: "x" }, { numItems: 1, cursor: null }),
      () => rooms.listRoomDefinitions(),
    ]) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DataSourceError);
      expect((e as DataSourceError).code).toBe("not_found");
      expect((e as DataSourceError).message).toMatch(/does not run rooms/);
    }
  });

  test("a refusal stays unauthorized", async () => {
    const { rooms } = answering(() => new Response("no", { status: 403 }));
    expect(await rooms.listRooms().catch((e: DataSourceError) => e.code)).toBe("unauthorized");
  });
});

describe("listRoomMembers", () => {
  test("the key, the cursor and numItems go to the server; the presence values stay in the JSON form", async () => {
    const { rooms, asked } = answering(() =>
      Response.json({ page: [member({ extra: 1 })], isDone: false, continueCursor: "m1" }),
    );
    const page = await rooms.listRoomMembers({ key: "room|a:b|{}" }, { numItems: 3, cursor: "m0" });
    const url = new URL(asked[0]!.url);
    expect(url.pathname).toBe("/api/debug/rooms/members");
    expect(url.searchParams.get("key")).toBe("room|a:b|{}");
    expect(url.searchParams.get("cursor")).toBe("m0");
    expect(url.searchParams.get("numItems")).toBe("3");
    expect(page).toEqual({ page: [member()], isDone: false, continueCursor: "m1" });
  });

  test("the first page sends no cursor; numItems over 100 is asked as 100", async () => {
    const { rooms, asked } = answering(() => Response.json({ page: [], isDone: true, continueCursor: "" }));
    await rooms.listRoomMembers({ key: "k" }, { numItems: 5000, cursor: null });
    const url = new URL(asked[0]!.url);
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.get("numItems")).toBe("100");
  });

  test("idle is kept for a scope's member only, null presence stays null", async () => {
    const { rooms } = answering(() =>
      Response.json({
        page: [member({ idle: true, presence: null }), member({ memberId: "m2" })],
        isDone: true,
        continueCursor: "",
      }),
    );
    const { page } = await rooms.listRoomMembers({ key: "k" }, { numItems: 10, cursor: null });
    expect(page[0]).toMatchObject({ idle: true, presence: null });
    expect("idle" in page[1]!).toBe(false);
  });
});

describe("listRoomDefinitions and the stats", () => {
  test("the definitions as the server sends them, the optional validators left as they are", async () => {
    const def: RoomDefinition = {
      kind: "room",
      name: "rooms:doc",
      module: "rooms.js",
      args: { type: "object", value: {} },
      presence: { type: "any" },
      events: [{ name: "ping", payload: null }],
    };
    const { rooms, asked } = answering(() => Response.json({ definitions: [def] }));
    expect(await rooms.listRoomDefinitions()).toEqual([def]);
    expect(new URL(asked[0]!.url).pathname).toBe("/api/debug/rooms/definitions");
  });

  test("the rooms' counters from /stats", () => {
    const wire = {
      rooms: 1,
      members: 2,
      connections: 3,
      joins: 4,
      joinsRefusedByGate: 5,
      joinsRefusedByLimit: 6,
      leaves: 7,
      graceExpiries: 8,
      presenceAccepted: 9,
      presenceDropped: 10,
      eventsAccepted: 11,
      eventsDropped: 12,
      resyncs: 13,
      roomLeft: 14,
    };
    expect(roomStatsOf({ ...wire, other: 1 } as never)).toEqual(wire);
  });
});

// The rooms in the dashboard (AD-43, STUDY-165): `/api/debug/rooms`, `/members` and `/definitions`, the `rooms`
// counters in `/stats`, and the rooms' series in `/metrics`. Admin only, with ViewMetrics, as the topology.
import { afterEach, describe, expect, test } from "bun:test";
import { DEPLOYMENT_AUDIT_LOG_TABLE, defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, query } from "../src/functions.ts";
import { presence, room } from "../src/rooms/define.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5e".repeat(32);
const NAME = "rooms-debug-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), memberId: 42 });
const READ_ONLY_KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET), readOnly: true });

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function setup() {
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
    { instanceName: NAME, instanceSecret: SECRET },
  ).init();
  const functions = new Functions(engine)
    .register("m", { count: query(async ({ db }) => (await db.query("a").collect()).length) })
    .register("rooms", {
      doc: room({
        args: { id: v.string(), tag: v.optional(v.string()) },
        presence: { x: v.number() },
        events: { ping: { n: v.number() } },
      }),
      lobby: room({ presence: v.any() }),
      online: presence({ args: { team: v.string() }, state: { status: v.string() } }),
      closed: room({ canJoin: async () => false, presence: v.any() }),
      big: room({ presence: v.any(), events: { blob: { s: v.string() } } }),
    });
  const s = createServer({ engine, functions, port: 0, onFatal: () => {} });
  const hub = s.rooms;
  stops.push(() => s.shutdown());
  const api = `http://127.0.0.1:${s.server.port}`;
  const get = async (path: string, key: string | null = KEY) => {
    const r = await fetch(`${api}${path}`, { headers: key ? { authorization: `Bunvex ${key}` } : {} });
    const text = await r.text();
    return { status: r.status, text, body: r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  const client = async () => {
    const c = await v1Client(syncUrl(s.server.port));
    stops.push(() => c.ws.close());
    return {
      ...c,
      join: (roomId: number, name: string, args: any, kind: "room" | "presence" = "room") =>
        c.send({ type: "RoomJoin", roomId, kind, name, args }),
      synced: (roomId: number) => c.until(() => c.got.find((m) => m.type === "RoomSync" && m.roomId === roomId)),
    };
  };
  const post = async (path: string, body: unknown, key: string | null = KEY) => {
    const r = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bunvex ${key}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, body: r.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
  };
  /** The audit log's events, oldest first. */
  const audit = () =>
    engine.query((db) => db.asSystem(() => db.query(DEPLOYMENT_AUDIT_LOG_TABLE).collect())) as Promise<
      Record<string, any>[]
    >;
  return { get, post, audit, client, api, hub };
}

test("the endpoints need the admin key", async () => {
  const { get } = await setup();
  for (const p of [
    "/api/debug/rooms",
    "/api/debug/rooms/members?kind=room&name=rooms:doc",
    "/api/debug/rooms/definitions",
    "/api/debug/rooms/events?kind=room&name=rooms:doc",
  ]) {
    expect([401, 403]).toContain((await get(p, null)).status);
    expect((await get(p)).status).not.toBe(401);
  }
});

test("a joined room is listed, and its member found with the args in another key order", async () => {
  const { get, client } = await setup();
  expect((await get("/api/debug/rooms")).body).toEqual({ rooms: [] });
  const c = await client();
  c.join(1, "rooms:doc", { id: "a", tag: "t" });
  await c.synced(1);
  const { rooms } = (await get("/api/debug/rooms")).body;
  expect(rooms).toEqual([
    {
      key: expect.any(String),
      kind: "room",
      name: "rooms:doc",
      args: { id: "a", tag: "t" },
      members: 1,
      connections: 1,
      openedAt: expect.any(Number),
    },
  ]);
  const byArgs = await get(
    `/api/debug/rooms/members?kind=room&name=${encodeURIComponent("rooms:doc")}&args=${encodeURIComponent('{"tag":"t","id":"a"}')}`,
  );
  expect(byArgs.status).toBe(200);
  expect(byArgs.body).toMatchObject({
    isDone: true,
    continueCursor: "",
    page: [{ canPublish: true, graced: false, connections: 1 }],
  });
  const byKey = await get(`/api/debug/rooms/members?key=${encodeURIComponent(rooms[0].key)}`);
  expect(byKey.body).toEqual(byArgs.body);
  const none = await get(
    `/api/debug/rooms/members?kind=room&name=rooms:doc&args=${encodeURIComponent('{"id":"zzz"}')}`,
  );
  expect(none.body).toEqual({ page: [], isDone: true, continueCursor: "" });
});

test("bad parameters are 400 with a message", async () => {
  const { get } = await setup();
  const bad = [
    "/api/debug/rooms/members",
    "/api/debug/rooms/members?kind=nope&name=rooms:doc",
    "/api/debug/rooms/members?kind=room",
    "/api/debug/rooms/members?kind=room&name=rooms:doc&args=%7Bnot",
    "/api/debug/rooms/members?kind=room&name=rooms:doc&numItems=0",
    "/api/debug/rooms/members?kind=room&name=rooms:doc&numItems=abc",
    "/api/debug/rooms/members?key=garbage",
    "/api/debug/rooms/events",
    "/api/debug/rooms/events?key=garbage",
    "/api/debug/rooms/events?kind=room&name=rooms:doc&cursor=-1",
    "/api/debug/rooms/events?kind=room&name=rooms:doc&cursor=1.5",
    "/api/debug/rooms/events?kind=room&name=rooms:doc&cursor=abc",
  ];
  for (const p of bad) {
    const r = await get(p);
    expect(r.status).toBe(400);
    expect(r.body.message).toBeString();
  }
});

test("numItems is capped at 100: a page of 100 with a cursor", async () => {
  const { get, hub } = await setup();
  for (let i = 0; i < 150; i++)
    hub.join(
      { sessionId: `s${i}`, send() {}, behind: () => 0, resync() {} },
      1,
      { kind: "room", name: "rooms:lobby", argsJson: "{}" },
      { userId: null, canPublish: true },
    );
  const r = (await get("/api/debug/rooms/members?kind=room&name=rooms:lobby&numItems=5000")).body;
  expect(r.page).toHaveLength(100);
  expect(r.isDone).toBe(false);
  expect(r.continueCursor).toBe(r.page[99].memberId);
  const next = (await get(`/api/debug/rooms/members?kind=room&name=rooms:lobby&cursor=${r.continueCursor}`)).body;
  expect(next.page).toHaveLength(50);
  expect(next.isDone).toBe(true);
});

test("a preflight on the rooms routes is answered by the CORS layer", async () => {
  const { api } = await setup();
  for (const p of [
    "/api/debug/rooms",
    "/api/debug/rooms/members",
    "/api/debug/rooms/definitions",
    "/api/debug/rooms/events",
  ]) {
    const r = await fetch(`${api}${p}`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:6791",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:6791");
    expect(r.headers.get("access-control-allow-headers")).toBe("authorization");
  }
});

test("/stats has the rooms counters, /metrics the series", async () => {
  const { get, client } = await setup();
  const c = await client();
  c.join(1, "rooms:lobby", {});
  await c.synced(1);
  c.join(2, "rooms:closed", {});
  await c.until(() => c.got.find((m) => m.type === "RoomError" && m.roomId === 2));
  const stats = (await get("/stats")).body.rooms;
  expect(stats).toMatchObject({ rooms: 1, members: 1, connections: 1, joins: 1, joinsRefusedByGate: 1 });
  const metrics = (await get("/metrics", null)).text;
  for (const name of [
    "bunvex_rooms_open 1",
    "bunvex_rooms_members 1",
    "bunvex_rooms_connections 1",
    "bunvex_rooms_joins_total 1",
    "bunvex_rooms_joins_refused_by_gate_total 1",
    "bunvex_rooms_joins_refused_by_limit_total 0",
    "bunvex_rooms_grace_expiries_total 0",
    "bunvex_rooms_presence_accepted_total 0",
    "bunvex_rooms_events_dropped_total 0",
    "bunvex_rooms_resyncs_total 0",
    "bunvex_rooms_room_left_total 0",
  ])
    expect(metrics).toContain(name);
});

test("definitions: the deployed rooms and scopes with validators and events, sorted", async () => {
  const { get } = await setup();
  const { definitions } = (await get("/api/debug/rooms/definitions")).body;
  expect(definitions.map((d: { name: string }) => d.name)).toEqual([
    "rooms:big",
    "rooms:closed",
    "rooms:doc",
    "rooms:lobby",
    "rooms:online",
  ]);
  const doc = definitions.find((d: { name: string }) => d.name === "rooms:doc");
  expect(doc).toMatchObject({
    kind: "room",
    module: "rooms.js",
    args: { type: "object" },
    presence: { type: "object" },
    events: [{ name: "ping", payload: { type: "object" } }],
  });
  const lobby = definitions.find((d: { name: string }) => d.name === "rooms:lobby");
  expect(lobby.args).toBeNull();
  const online = definitions.find((d: { name: string }) => d.name === "rooms:online");
  expect(online).toMatchObject({ kind: "presence", state: { type: "object" }, events: [] });
});

describe("the event tap: /api/debug/rooms/events (AD-43)", () => {
  /** A room with two members over the wire: `a` sends, `b` listens. */
  async function room() {
    const x = await setup();
    const a = await x.client();
    const b = await x.client();
    a.join(1, "rooms:doc", { id: "t" });
    await a.synced(1);
    b.join(1, "rooms:doc", { id: "t" });
    await b.synced(1);
    const key = (await x.get("/api/debug/rooms")).body.rooms[0].key as string;
    const events = (q: string) => x.get(`/api/debug/rooms/events?key=${encodeURIComponent(key)}${q}`);
    return { ...x, a, b, key, events };
  }

  test("no cursor starts the tap at once; an event sent before it is not seen, one after it is", async () => {
    const r = await room();
    r.a.send({ type: "RoomEvent", roomId: 1, event: "ping", data: { n: 1 } });
    await r.b.until(() => r.b.got.find((m) => m.type === "RoomEvent"));
    const start = await r.events("");
    expect(start.status).toBe(200);
    expect(start.body).toEqual({ events: [], newCursor: 0, epoch: expect.any(String) });
    r.a.send({ type: "RoomEvent", roomId: 1, event: "ping", data: { n: 2 } });
    const got = (await r.events("&cursor=0")).body;
    expect(got).toEqual({
      events: [{ seq: 1, at: expect.any(Number), event: "ping", from: expect.any(String), size: 7, data: { n: 2 } }],
      newCursor: 1,
      epoch: expect.any(String),
    });
  });

  test("the long poll answers when an event arrives, not at its timeout", async () => {
    const r = await room();
    await r.events("");
    const t0 = performance.now();
    const waiting = r.events("&cursor=0&timeoutMs=30000");
    await Bun.sleep(50);
    r.hub.broadcast({ kind: "room", name: "rooms:doc", argsJson: '{"id":"t"}' }, "notice", { hi: 1 });
    const got = (await waiting).body;
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(got.events).toEqual([expect.objectContaining({ seq: 1, event: "notice", from: null, data: { hi: 1 } })]);
  });

  test("a long poll with nothing times out with the same cursor", async () => {
    const r = await room();
    await r.events("");
    expect((await r.events("&cursor=0&timeoutMs=50")).body).toEqual({
      events: [],
      newCursor: 0,
      epoch: expect.any(String),
    });
  });

  test("an overflowed buffer answers how many were dropped; a cursor of a gone tap is reset", async () => {
    const r = await room();
    const KEY = { kind: "room" as const, name: "rooms:doc", argsJson: '{"id":"t"}' };
    await r.events("");
    for (let i = 0; i < 205; i++) r.hub.broadcast(KEY, "n", i);
    const got = (await r.events("&cursor=0")).body;
    expect(got.events).toHaveLength(200);
    expect(got.dropped).toBe(5);
    expect(got.newCursor).toBe(205);
    expect((await r.events("&cursor=999")).body).toEqual({
      events: [],
      newCursor: 205,
      reset: true,
      epoch: expect.any(String),
    });
  });

  test("timeoutMs is capped at 60 000 ms, and defaults to it", async () => {
    const r = await room();
    const asked: number[] = [];
    const tapEvents = r.hub.tapEvents.bind(r.hub);
    r.hub.tapEvents = (key, cursor, timeoutMs, signal) => {
      asked.push(timeoutMs);
      return tapEvents(key, cursor, 0, signal);
    };
    await r.events("&cursor=0&timeoutMs=999999");
    await r.events("&cursor=0");
    await r.events("&cursor=0&timeoutMs=20");
    expect(asked).toEqual([60_000, 60_000, 20]);
  });

  test("a room that is not open is closed, whatever the cursor", async () => {
    const { get } = await setup();
    const q = `kind=room&name=rooms:doc&args=${encodeURIComponent('{"id":"none"}')}`;
    expect((await get(`/api/debug/rooms/events?${q}`)).body).toEqual({ events: [], newCursor: 0, closed: true });
    expect((await get(`/api/debug/rooms/events?${q}&cursor=7`)).body).toEqual({
      events: [],
      newCursor: 7,
      closed: true,
    });
  });
});

describe("the dashboard's actions: broadcast, remove, close (AD-43)", () => {
  /** Two clients in one room, one more in a scope on two sockets as one user. */
  async function rooms() {
    const x = await setup();
    const a = await x.client();
    const b = await x.client();
    a.join(1, "rooms:doc", { id: "t" });
    await a.synced(1);
    b.join(5, "rooms:doc", { id: "t" });
    await b.synced(5);
    const key = (await x.get("/api/debug/rooms")).body.rooms[0].key as string;
    const members = async (k = key) =>
      (await x.get(`/api/debug/rooms/members?key=${encodeURIComponent(k)}`)).body.page as { memberId: string }[];
    const selfOf = (c: typeof a, roomId: number) =>
      (c.got.find((m) => m.type === "RoomSync" && m.roomId === roomId) as { self: string }).self;
    return { ...x, a, b, key, members, selfOf };
  }
  const leftOf = (c: { got: any[] }) => c.got.filter((m) => m.type === "RoomLeft");

  test("broadcast: every member gets the event from the server, the tap sees it, the audit log has it", async () => {
    const r = await rooms();
    await r.get(`/api/debug/rooms/events?key=${encodeURIComponent(r.key)}`);
    const sent = await r.post("/api/debug/rooms/broadcast", { key: r.key, event: "ping", data: { n: 3 } });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({});
    for (const [c, roomId] of [
      [r.a, 1],
      [r.b, 5],
    ] as const) {
      const e = await c.until(() => c.got.find((m) => m.type === "RoomEvent"));
      expect(e).toEqual({ type: "RoomEvent", roomId, from: null, event: "ping", data: { n: 3 } });
    }
    const tap = (await r.get(`/api/debug/rooms/events?key=${encodeURIComponent(r.key)}&cursor=0&timeoutMs=0`)).body;
    expect(tap.events).toEqual([expect.objectContaining({ event: "ping", from: null, data: { n: 3 } })]);
    const [entry] = await r.audit();
    expect(entry).toMatchObject({
      action: "broadcast_room_event",
      member_id: 42n,
      metadata: { room: "rooms:doc", args: '{"id":"t"}', event: "ping" },
    });
  });

  test("broadcast refuses what ctx.rooms.broadcast refuses, in its words, and sends nothing", async () => {
    const r = await rooms();
    const cases: [unknown, number, string | RegExp][] = [
      [{ key: r.key, event: "nope", data: {} }, 400, 'This room has no event "nope".'],
      [{ key: r.key, event: "ping", data: { n: "x" } }, 400, /^ArgumentValidationError: .*n/s],
      [{ key: r.key, event: "ping", data: { n: 1, pad: "x".repeat(5000) } }, 400, /^ArgumentValidationError/],
      [{ key: "garbage", event: "ping", data: {} }, 400, "`key` is not a room key from the list."],
      [{ key: r.key, data: {} }, 400, "`event` must be a string."],
      ["{not json", 400, "The body is not valid JSON."],
    ];
    for (const [body, status, message] of cases) {
      const res = await r.post("/api/debug/rooms/broadcast", body);
      expect(res.status).toBe(status);
      if (typeof message === "string") expect(res.body.message).toBe(message);
      else expect(res.body.message).toMatch(message);
    }
    const lobbyKey = `room|rooms:lobby|{}`;
    const c = await r.client();
    c.join(1, "rooms:lobby", {});
    await c.synced(1);
    // the lobby declares no event: the room's events, not a size limit, refuse it
    expect((await r.post("/api/debug/rooms/broadcast", { key: lobbyKey, event: "x", data: 1 })).status).toBe(400);
    await Bun.sleep(50);
    expect([...r.a.got, ...r.b.got].some((m) => m.type === "RoomEvent")).toBe(false);
    expect(await r.audit()).toEqual([]);
  });

  test("broadcast over the event size limit is refused with ctx.rooms.broadcast's message", async () => {
    const { post, client } = await setup();
    const c = await client();
    c.join(1, "rooms:big", {});
    await c.synced(1);
    const res = await post("/api/debug/rooms/broadcast", {
      key: "room|rooms:big|{}",
      event: "blob",
      data: { s: "x".repeat(5000) },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("The event is too large.");
  });

  test("broadcast to a room that is not open is 404, nothing sent", async () => {
    const r = await rooms();
    const res = await r.post("/api/debug/rooms/broadcast", {
      key: `room|rooms:doc|{"id":"none"}`,
      event: "ping",
      data: { n: 1 },
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "RoomNotOpen", message: "The room is not open." });
    expect(await r.audit()).toEqual([]);
  });

  test("remove: the client is sent RoomLeft removed, the member leaves the list, the others see it leave", async () => {
    const r = await rooms();
    const id = r.selfOf(r.a, 1);
    const res = await r.post("/api/debug/rooms/remove", { key: r.key, memberId: id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: { connections: 1 } });
    expect(await r.a.until(() => leftOf(r.a)[0])).toEqual({
      type: "RoomLeft",
      roomId: 1,
      code: "removed",
      message: "Removed from the dashboard.",
    });
    expect((await r.members()).map((m) => m.memberId)).toEqual([r.selfOf(r.b, 5)]);
    await r.b.until(() => r.b.got.find((m) => m.type === "RoomMembers" && m.left.includes(id)));
    expect(leftOf(r.b)).toEqual([]);
    const [entry] = await r.audit();
    expect(entry).toMatchObject({
      action: "remove_room_member",
      member_id: 42n,
      metadata: { room: "rooms:doc", args: '{"id":"t"}', member_id: id, connections: 1 },
    });
    expect((await r.get("/stats")).body.rooms).toMatchObject({ roomLeft: 1, leaves: 1 });
    // no such member now: null, and nothing recorded
    expect((await r.post("/api/debug/rooms/remove", { key: r.key, memberId: id })).body).toEqual({ removed: null });
    expect(await r.audit()).toHaveLength(1);
  });

  test("close: every client is sent RoomLeft, the room leaves the list, the counts answered", async () => {
    const r = await rooms();
    const res = await r.post("/api/debug/rooms/close", { key: r.key });
    expect(res.body).toEqual({ closed: { members: 2, connections: 2 } });
    for (const [c, roomId] of [
      [r.a, 1],
      [r.b, 5],
    ] as const)
      expect(await c.until(() => leftOf(c)[0])).toMatchObject({ roomId, code: "removed" });
    expect((await r.get("/api/debug/rooms")).body.rooms).toEqual([]);
    expect((await r.audit()).map((e) => [e.action, e.metadata])).toEqual([
      ["close_room", { room: "rooms:doc", args: '{"id":"t"}', members: 2, connections: 2 }],
    ]);
    expect((await r.post("/api/debug/rooms/close", { key: r.key })).body).toEqual({ closed: null });
    expect(await r.audit()).toHaveLength(1);
  });

  test("a read-only key, or none, may not act: nothing done, nothing recorded", async () => {
    const r = await rooms();
    const id = r.selfOf(r.a, 1);
    for (const key of [READ_ONLY_KEY, null]) {
      const calls = [
        r.post("/api/debug/rooms/broadcast", { key: r.key, event: "ping", data: { n: 1 } }, key),
        r.post("/api/debug/rooms/remove", { key: r.key, memberId: id }, key),
        r.post("/api/debug/rooms/close", { key: r.key }, key),
      ];
      for (const res of await Promise.all(calls)) {
        if (key) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("OperationNotPermitted");
        } else expect([401, 403]).toContain(res.status);
      }
    }
    expect((await r.members()).length).toBe(2);
    expect(await r.audit()).toEqual([]);
    await Bun.sleep(50);
    expect([...r.a.got, ...r.b.got].some((m) => m.type === "RoomEvent" || m.type === "RoomLeft")).toBe(false);
  });

  test("the actions are POST only, with a preflight answered", async () => {
    const r = await rooms();
    for (const p of ["broadcast", "remove", "close"]) {
      expect((await r.get(`/api/debug/rooms/${p}`)).status).toBe(404);
      const pre = await fetch(`${r.api}/api/debug/rooms/${p}`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:6791", "access-control-request-method": "POST" },
      });
      expect(pre.status).toBe(200);
      expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    }
  });
});

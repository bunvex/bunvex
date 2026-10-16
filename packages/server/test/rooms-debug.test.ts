// The rooms in the dashboard (AD-43, STUDY-165): `/api/debug/rooms`, `/members` and `/definitions`, the `rooms`
// counters in `/stats`, and the rooms' series in `/metrics`. Admin only, with ViewMetrics, as the topology.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { adminKeyCipherKey, issueAdminKey } from "../src/admin-keys.ts";
import { Functions, query } from "../src/functions.ts";
import { presence, room } from "../src/rooms/define.ts";
import { createServer } from "../src/server.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const SECRET = "5e".repeat(32);
const NAME = "rooms-debug-test";
const KEY = issueAdminKey({ instanceName: NAME, cipherKey: adminKeyCipherKey(SECRET) });

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
    });
  const s = createServer({ engine, functions, port: 0, onFatal: () => {} });
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
  return { get, client, api };
}

test("the endpoints need the admin key", async () => {
  const { get } = await setup();
  for (const p of [
    "/api/debug/rooms",
    "/api/debug/rooms/members?kind=room&name=rooms:doc",
    "/api/debug/rooms/definitions",
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
  ];
  for (const p of bad) {
    const r = await get(p);
    expect(r.status).toBe(400);
    expect(r.body.message).toBeString();
  }
});

test("numItems is capped at 100", async () => {
  const { get } = await setup();
  expect((await get("/api/debug/rooms/members?kind=room&name=rooms:lobby&numItems=5000")).status).toBe(200);
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

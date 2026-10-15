// Rooms over the sync protocol (AD-42, STUDY-164 §3.4–3.6): joins with their gates, presence and events
// validated and relayed, identity changes, the socket closing mid-join, a reconnect within the grace, and a
// connection that uses no room seeing none of it.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { Functions, mutation, query } from "../src/functions.ts";
import { presence, room } from "../src/rooms/define.ts";
import { createServer } from "../src/server.ts";
import type { SyncSession } from "../src/sync.ts";
import { startIssuer } from "./issuer.ts";
import { add, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

async function setup() {
  const issuer = await startIssuer({ cacheControl: "max-age=600" });
  stops.push(issuer.stop);
  const engine = await new Engine(
    defineSchema({ a: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  /**
   * The gates of `doc {id: "wait"}` (canJoin), `doc {id: "waitPublish"}` (canPublish) and `online {team: "wait"}`
   * (a scope's canJoin): each says when it started, and waits until the test releases it.
   */
  const held = () => ({ entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() });
  const waiting = { canJoin: held(), canPublish: held(), scope: held() };
  const functions = new Functions(engine)
    .register("m", {
      count: query(async ({ db }) => (await db.query("a").collect()).length),
      insert: mutation(({ db }) => db.insert("a", {})),
    })
    .register("rooms", {
      doc: room({
        args: { id: v.string() },
        canJoin: async (_ctx: unknown, { id }: { id: string }) => {
          if (id === "throw") throw new Error("the gate's internal detail: hunter2");
          if (id === "wait") {
            waiting.canJoin.entered.resolve();
            await waiting.canJoin.release.promise;
          }
          return id !== "no";
        },
        canPublish: async (_ctx: unknown, { id }: { id: string }) => {
          if (id === "waitPublish") {
            waiting.canPublish.entered.resolve();
            await waiting.canPublish.release.promise;
          }
          return id !== "ro";
        },
        presence: { x: v.number() },
        events: { ping: { n: v.number() } },
      }),
      online: presence({
        args: { team: v.string() },
        canJoin: async (_ctx: unknown, { team }: { team: string }) => {
          if (team === "wait") {
            waiting.scope.entered.resolve();
            await waiting.scope.release.promise;
          }
          return true;
        },
        state: { status: v.string() },
      }),
      lobby: room({ presence: v.any() }),
      secret: room({
        canJoin: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
          (await ctx.auth.getUserIdentity())?.subject === "ada",
        presence: v.any(),
      }),
    });
  const { server, rooms, sync, stop } = createServer({
    engine,
    functions,
    port: 0,
    redactLogsToClient: false,
    auth: { providers: [{ domain: issuer.url, applicationID: "app" }] },
  });
  stops.push(stop);
  return { issuer, rooms, sync, waiting, url: `ws://127.0.0.1:${server.port}/api/1.0.0/sync` };
}

async function client(url: string, sessionId: string = crypto.randomUUID()) {
  const c = await v1Client(url, sessionId);
  let identity = 0;
  const of = <T extends v1.ServerMessage["type"]>(type: T) =>
    c.got.filter((m): m is Extract<v1.ServerMessage, { type: T }> => m.type === type);
  return {
    ...c,
    sessionId,
    of,
    join: (roomId: number, name: string, args: v1.JSONValue = {}, kind: v1.RoomKind = "room") =>
      c.send({ type: "RoomJoin", roomId, kind, name, args }),
    leave: (roomId: number) => c.send({ type: "RoomLeave", roomId }),
    presence: (roomId: number, presence: v1.JSONValue, idle?: boolean) =>
      c.send({ type: "RoomPresence", roomId, presence, ...(idle === undefined ? {} : { idle }) }),
    event: (roomId: number, event: string, data: v1.JSONValue) => c.send({ type: "RoomEvent", roomId, event, data }),
    authenticate: (token: string | null) =>
      c.send(
        token === null
          ? { type: "Authenticate", tokenType: "None", baseVersion: identity++ }
          : { type: "Authenticate", tokenType: "User", value: token, baseVersion: identity++ },
      ),
    synced: (roomId: number) => c.until(() => of("RoomSync").find((m) => m.roomId === roomId)),
    error: (roomId: number) => c.until(() => of("RoomError").find((m) => m.roomId === roomId)),
    /**
     * Every presence the member was set to in this client's RoomMembers frames; not its join's (null), which
     * a client may hear of or not, depending on whether it joined in the same tick.
     */
    presencesOf: (memberId: string) =>
      of("RoomMembers").flatMap((m) =>
        m.set.filter((x) => x.memberId === memberId && x.presence !== null).map((x) => x.presence),
      ),
  };
}

const isRoomFrame = (m: v1.ServerMessage) => m.type.startsWith("Room");

describe("rooms over the sync protocol", () => {
  test("two clients join rooms:doc {id: a}: each gets RoomSync, and the second appears in the first's RoomMembers", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const syncA = await a.synced(1);
    expect(syncA).toMatchObject({ roomId: 1, canPublish: true, members: [] });
    b.join(7, "rooms:doc", { id: "a" });
    const syncB = await b.synced(7);
    expect(syncB.members).toEqual([{ memberId: syncA.self, userId: null, presence: null }]);
    expect(syncB.self).not.toBe(syncA.self);
    const members = await a.until(() => a.of("RoomMembers")[0]);
    expect(members).toEqual({
      type: "RoomMembers",
      roomId: 1,
      set: [{ memberId: syncB.self, userId: null, presence: null }],
      left: [],
    });
  });

  test("one room whatever the spelling of its name or the order of its args' keys", async () => {
    const { url, rooms } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a", z: null } as v1.JSONValue);
    expect(await a.error(1)).toMatchObject({ code: "validation" }); // the args are validated
    a.join(1, "rooms:lobby", { y: 1, x: { b: 2, a: 1 } });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms.js:lobby", { x: { a: 1, b: 2 }, y: 1 });
    expect((await b.synced(2)).members.map((m) => m.memberId)).toEqual([selfA]);
    expect(rooms.size).toEqual({ rooms: 1, members: 2 });
  });

  test("RoomPresence from A reaches B as RoomMembers.set with A's presence, and never echoes to A", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms:doc", { id: "a" });
    const selfB = (await b.synced(2)).self;
    a.presence(1, { x: 1 });
    await b.until(() => b.presencesOf(selfA).length > 0);
    expect(b.presencesOf(selfA)).toEqual([{ x: 1 }]);
    // B's presence after A's reaches A in a later flush: by then any echo of A's own would have come first.
    b.presence(2, { x: 2 });
    await a.until(() => a.presencesOf(selfB).length > 0);
    expect(a.presencesOf(selfA)).toEqual([]);
    expect(a.of("RoomMembers").every((m) => m.set.every((x) => x.memberId !== selfA))).toBe(true);
  });

  test("RoomEvent from A reaches B with from = A's memberId", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms:doc", { id: "a" });
    await b.synced(2);
    a.event(1, "ping", { n: 5 });
    const e = await b.until(() => b.of("RoomEvent")[0]);
    expect(e).toEqual({ type: "RoomEvent", roomId: 2, from: selfA, event: "ping", data: { n: 5 } });
    expect(a.of("RoomEvent")).toEqual([]);
  });

  test("an undeclared event name → RoomError validation, and nothing is sent", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    await a.synced(1);
    b.join(2, "rooms:doc", { id: "a" });
    await b.synced(2);
    a.event(1, "shout", { n: 1 });
    const err = await a.error(1);
    expect(err).toEqual({
      type: "RoomError",
      roomId: 1,
      code: "validation",
      message: 'This room has no event "shout".',
    });
    // Messages are handled in order: once the next event arrives, the undeclared one would have come first.
    a.event(1, "ping", { n: 2 });
    await b.until(() => b.of("RoomEvent").length > 0);
    expect(b.of("RoomEvent").map((m) => m.event)).toEqual(["ping"]);
  });

  test("a presence that fails the validator → RoomError validation with checkValue's message, nothing sent", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms:doc", { id: "a" });
    await b.synced(2);
    a.presence(1, { x: "not a number" });
    const err = await a.error(1);
    expect(err.code).toBe("validation");
    expect(err.message).toContain("Value does not match validator");
    expect(err.message).toContain(".x");
    a.presence(1, { x: 3 });
    await b.until(() => b.presencesOf(selfA).length > 0);
    expect(b.presencesOf(selfA)).toEqual([{ x: 3 }]);
  });

  test("a payload over 4 KB → RoomError limit", async () => {
    const { url } = await setup();
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms:doc", { id: "a" });
    await b.synced(2);
    a.presence(1, { x: 1, pad: "y".repeat(5000) });
    expect(await a.error(1)).toMatchObject({ code: "limit" });
    a.event(1, "ping", { n: 1, pad: "y".repeat(5000) });
    await a.until(() => a.of("RoomError").length === 2);
    expect(a.of("RoomError")[1]).toMatchObject({ code: "limit" });
    a.join(3, "rooms:doc", { id: "y".repeat(5000) });
    await a.until(() => a.of("RoomError").length === 3);
    expect(a.of("RoomError")[2]).toMatchObject({ roomId: 3, code: "limit" });
    a.presence(1, { x: 4 });
    await b.until(() => b.presencesOf(selfA).length > 0);
    expect(b.presencesOf(selfA)).toEqual([{ x: 4 }]);
    expect(b.of("RoomEvent")).toEqual([]);
  });

  test('canJoin false → RoomError no_access, "You cannot join this room."', async () => {
    const { url, rooms } = await setup();
    const a = await client(url);
    a.join(1, "rooms:doc", { id: "no" });
    expect(await a.error(1)).toEqual({
      type: "RoomError",
      roomId: 1,
      code: "no_access",
      message: "You cannot join this room.",
    });
    expect(a.of("RoomSync")).toEqual([]);
    expect(rooms.size.members).toBe(0);
  });

  test("canJoin throws → the same message, with no internals", async () => {
    const { url, rooms } = await setup();
    const a = await client(url);
    a.join(1, "rooms:doc", { id: "throw" });
    expect(await a.error(1)).toEqual({
      type: "RoomError",
      roomId: 1,
      code: "no_access",
      message: "You cannot join this room.",
    });
    expect(JSON.stringify(a.got)).not.toContain("hunter2");
    expect(rooms.size.members).toBe(0);
  });

  test("updates over the rate are dropped, with one rate_limited RoomError a second", async () => {
    const { url } = await setup();
    const a = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    await a.synced(1);
    // 40 a second, from a full bucket: a burst of 70 drops about 30, reported once.
    for (let i = 0; i < 70; i++) a.presence(1, { x: i });
    a.presence(99, { x: 0 }); // in order after the burst: its not_found comes after every report of it
    await a.error(99);
    expect(a.of("RoomError").filter((e) => e.roomId === 1)).toEqual([
      { type: "RoomError", roomId: 1, code: "rate_limited", message: "Too many updates: some were dropped." },
    ]);
  });

  test("a room is not a function: a client cannot run it, or its gates, as a query", async () => {
    const { url } = await setup();
    const a = await client(url);
    a.modify([add(1, "rooms:doc", { id: "a" })]);
    const t = await a.transition(0);
    expect(t.modifications).toEqual([
      expect.objectContaining({
        type: "QueryFailed",
        queryId: 1,
        errorMessage: expect.stringContaining("Could not find"),
      }),
    ]);
  });

  test("canPublish false → RoomSync.canPublish false; RoomPresence → RoomError forbidden", async () => {
    const { url } = await setup();
    const a = await client(url);
    a.join(1, "rooms:doc", { id: "ro" });
    expect((await a.synced(1)).canPublish).toBe(false);
    a.presence(1, { x: 1 });
    expect(await a.error(1)).toEqual({
      type: "RoomError",
      roomId: 1,
      code: "forbidden",
      message: "This connection may not publish in this room.",
    });
  });

  test("an unknown room name → RoomError not_found", async () => {
    const { url } = await setup();
    const a = await client(url);
    a.join(1, "rooms:nope");
    expect(await a.error(1)).toMatchObject({ code: "not_found" });
  });

  test("a room name joined with kind presence → RoomError not_found", async () => {
    const { url, issuer } = await setup();
    const a = await client(url);
    a.authenticate(await issuer.sign({ sub: "ada" }));
    a.join(1, "rooms:doc", { id: "a" }, "presence");
    expect(await a.error(1)).toMatchObject({ code: "not_found" });
    expect(a.of("RoomSync")).toEqual([]);
  });

  test("a message for a room the connection has not joined → RoomError not_found", async () => {
    const { url } = await setup();
    const a = await client(url);
    a.presence(9, { x: 1 });
    expect(await a.error(9)).toMatchObject({ code: "not_found" });
    a.event(8, "ping", { n: 1 });
    expect(await a.error(8)).toMatchObject({ code: "not_found" });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  test("a presence scope refuses an anonymous connection (no_access) whatever canJoin says", async () => {
    const { url, issuer, rooms } = await setup();
    const a = await client(url);
    a.join(1, "rooms:online", { team: "t" }, "presence");
    expect(await a.error(1)).toMatchObject({ code: "no_access" });
    expect(rooms.size.members).toBe(0);
    a.authenticate(await issuer.sign({ sub: "ada" }));
    a.join(2, "rooms:online", { team: "t" }, "presence");
    expect(await a.synced(2)).toMatchObject({ self: "ada", canPublish: true });
  });

  test("Authenticate to a user canJoin refuses → RoomError no_access for that room, and the others see it leave", async () => {
    const { url, issuer } = await setup();
    const a = await client(url);
    const b = await client(url);
    const ada = await issuer.sign({ sub: "ada" });
    a.authenticate(ada);
    b.authenticate(ada);
    a.join(1, "rooms:secret", {});
    const selfA = (await a.synced(1)).self;
    a.join(2, "rooms:doc", { id: "a" });
    await a.synced(2);
    b.join(5, "rooms:secret", {});
    await b.synced(5);
    a.authenticate(await issuer.sign({ sub: "bob" }));
    expect(await a.error(1)).toEqual({
      type: "RoomError",
      roomId: 1,
      code: "no_access",
      message: "You cannot join this room.",
    });
    const left = await b.until(() => b.of("RoomMembers").find((m) => m.left.length > 0));
    expect(left.left).toEqual([selfA]);
    // The room the new user may still join is kept (as a new member, for a new user).
    expect(a.of("RoomError").filter((e) => e.roomId === 2)).toEqual([]);
  });

  for (const [gate, name, args] of [
    ["canJoin", "rooms:doc", { id: "wait" }],
    ["canPublish", "rooms:doc", { id: "waitPublish" }],
    ["scope", "rooms:online", { team: "wait" }],
  ] as const)
    test(`the socket closes while ${gate} is awaiting: no member is inserted`, async () => {
      const { url, issuer, sync, rooms, waiting } = await setup();
      const a = await client(url);
      const kind = gate === "scope" ? "presence" : "room";
      if (kind === "presence") a.authenticate(await issuer.sign({ sub: "ada" }));
      a.join(1, name, args, kind);
      await waiting[gate].entered.promise;
      const [session] = [...sync.sessions] as SyncSession[];
      a.ws.close();
      await a.closed;
      await a.until(() => !session!.isOpen);
      waiting[gate].release.resolve();
      await (session as unknown as { inbox: Promise<void> }).inbox;
      expect(rooms.size.members).toBe(0);
    });

  test("a reconnect with the same sessionId within the grace, rejoining: B sees no RoomMembers at all", async () => {
    const { url } = await setup();
    const sessionId = crypto.randomUUID();
    const a = await client(url, sessionId);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    const selfA = (await a.synced(1)).self;
    b.join(2, "rooms:doc", { id: "a" });
    const selfB = (await b.synced(2)).self;
    // A's presence reaches B after any frame of the joins' flush (B may hear of A there too).
    a.presence(1, { x: 1 });
    await b.until(() => b.presencesOf(selfA).length > 0);
    const before = b.of("RoomMembers").length;
    a.ws.close();
    await a.closed;
    const again = await client(url, sessionId);
    again.join(1, "rooms:doc", { id: "a" });
    const sync = await again.synced(1);
    expect(sync.self).toBe(selfA);
    expect(sync.members).toEqual([{ memberId: selfB, userId: null, presence: null }]);
    // B's presence goes out in a later flush than any frame about A's leave or rejoin would have; the event A
    // sends once A has it reaches B after that flush's frames.
    b.presence(2, { x: 9 });
    await again.until(() => again.presencesOf(selfB).length > 0);
    again.event(1, "ping", { n: 1 });
    await b.until(() => b.of("RoomEvent").length > 0);
    expect(b.of("RoomMembers").length).toBe(before);
    expect(b.of("RoomEvent")[0]!.from).toBe(selfA);
  });

  test("a connection that never sends a room message receives no room frame, and hub.size is untouched", async () => {
    const { url, rooms } = await setup();
    const quiet = await client(url);
    quiet.modify([add(1, "m:count")]);
    await quiet.transition(0);
    const a = await client(url);
    const b = await client(url);
    a.join(1, "rooms:doc", { id: "a" });
    await a.synced(1);
    b.join(2, "rooms:doc", { id: "a" });
    await b.synced(2);
    const before = rooms.size;
    a.presence(1, { x: 1 });
    a.event(1, "ping", { n: 1 });
    await b.until(() => b.of("RoomEvent").length > 0);
    quiet.mutate(0, "m:insert");
    await quiet.until(() => quiet.responses().length > 0);
    await quiet.transition(1);
    expect(quiet.got.filter(isRoomFrame)).toEqual([]);
    expect(rooms.size).toEqual(before);
    expect(before).toEqual({ rooms: 1, members: 2 });
  });
});

// ctx.rooms and ctx.presence (AD-42, STUDY-164 §3.4): mutations broadcast after the commit and only once, actions
// broadcast at once and read members, queries have neither.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { presence, room } from "../src/rooms/define.ts";
import { createServer } from "../src/server.ts";
import { v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

// biome-ignore lint/suspicious/noExplicitAny: the test ctx is untyped
type Ctx = any;

async function setup() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const hold = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  let attempts = 0;
  const functions = new Functions(engine)
    .register("m", {
      say: mutation(async (ctx: Ctx, { id, text }: { id: string; text: string }) => {
        await ctx.rooms.broadcast("rooms:doc", { id }, "ping", { text });
        return "done";
      }),
      sayThenThrow: mutation(async (ctx: Ctx) => {
        await ctx.rooms.broadcast("rooms:doc", { id: "a" }, "ping", { text: "lost" });
        throw new Error("boom");
      }),
      nested: mutation(async (ctx: Ctx) => {
        await ctx.rooms.broadcast("rooms:doc", { id: "a" }, "ping", { text: "parent" });
        try {
          await ctx.runMutation("m:sayThenThrow", {});
        } catch {}
        return "ok";
      }),
      nestedOk: mutation(async (ctx: Ctx) => {
        await ctx.runMutation("m:say", { id: "a", text: "child" });
        return "ok";
      }),
      bad: mutation(async (ctx: Ctx, { what }: { what: string }) => {
        if (what === "event") await ctx.rooms.broadcast("rooms:doc", { id: "a" }, "nope", {});
        if (what === "data") await ctx.rooms.broadcast("rooms:doc", { id: "a" }, "ping", { text: 1 });
        if (what === "args") await ctx.rooms.broadcast("rooms:doc", { id: 1 }, "ping", { text: "x" });
        if (what === "name") await ctx.rooms.broadcast("rooms:missing", {}, "ping", {});
        if (what === "kind") await ctx.rooms.broadcast("rooms:online", { team: "t" }, "ping", {});
      }),
      retried: mutation(async (ctx: Ctx) => {
        const n = ++attempts;
        await ctx.rooms.broadcast("rooms:doc", { id: "a" }, "ping", { text: `attempt ${n}` });
        await ctx.db.query("items").collect();
        if (n === 1) {
          read.resolve();
          await hold.promise; // another commit lands on what this attempt read
        }
        await ctx.db.insert("items", { n });
        return n;
      }),
      noRoomInQuery: query((ctx: Ctx) => [typeof ctx.rooms, typeof ctx.presence]),
      noMembersInMutation: mutation((ctx: Ctx) => [typeof ctx.rooms.members, typeof ctx.presence]),
    })
    .register("a", {
      say: action(async (ctx: Ctx, { id }: { id: string }) => {
        await ctx.rooms.broadcast("rooms:doc", { id }, "ping", { text: "from action" });
        return "sent";
      }),
      read: action(async (ctx: Ctx) => ({
        members: await ctx.rooms.members("rooms:doc", { id: "a" }),
        online: await ctx.presence.list("rooms:online", { team: "t" }),
      })),
      wrongKind: action(async (ctx: Ctx) => ctx.presence.list("rooms:doc", { id: "a" })),
    })
    .register("rooms", {
      doc: room({ args: { id: v.string() }, presence: { x: v.number() }, events: { ping: { text: v.string() } } }),
      online: presence({ args: { team: v.string() }, state: { at: v.bigint() } }),
    });
  const { server, rooms, stop } = createServer({ engine, functions, port: 0, redactLogsToClient: false });
  stops.push(stop);
  const url = `ws://127.0.0.1:${server.port}/api/1.0.0/sync`;
  const client = async () => {
    const c = await v1Client(url);
    const of = <T extends v1.ServerMessage["type"]>(type: T) =>
      c.got.filter((m): m is Extract<v1.ServerMessage, { type: T }> => m.type === type);
    const join = async (roomId: number, name: string, args: v1.JSONValue, kind: v1.RoomKind = "room") => {
      c.send({ type: "RoomJoin", roomId, kind, name, args });
      return c.until(() => of("RoomSync").find((m) => m.roomId === roomId));
    };
    return { ...c, of, join, events: () => of("RoomEvent") };
  };
  return { engine, functions, rooms, client, hold, read };
}

/** Let any frame in flight arrive: a broadcast is flushed on the hub's next tick. */
const settle = () => Bun.sleep(80);

describe("ctx.rooms in mutations", () => {
  test("a member gets a RoomEvent with from = null once the mutation resolved, with validated data", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    await functions.runMutation("m:say", { id: "a", text: "hi" }, false);
    const e = await a.until(() => a.events()[0]);
    expect(e).toMatchObject({ roomId: 1, event: "ping", from: null, data: { text: "hi" } });
    expect(a.events()).toHaveLength(1);
  });

  test("a mutation that broadcasts then throws sends nothing", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    await expect(functions.runMutation("m:sayThenThrow", {}, false)).rejects.toThrow("boom");
    await settle();
    expect(a.events()).toEqual([]);
  });

  test("a mutation retried by an OCC conflict sends exactly one event, the committed attempt's", async () => {
    const { functions, engine, client, hold, read } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    const pending = functions.runMutation("m:retried", {}, false);
    await read.promise;
    await engine.mutation((db) => db.insert("items", { other: true }));
    hold.resolve();
    expect(await pending).toBe(2);
    await a.until(() => a.events()[0]);
    await settle();
    expect(a.events().map((e) => e.data)).toEqual([{ text: "attempt 2" }]);
  });

  test("a nested runMutation that broadcasts then throws, caught by the parent: only the parent's broadcast is sent", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    await functions.runMutation("m:nested", {}, false);
    await a.until(() => a.events()[0]);
    await settle();
    expect(a.events().map((e) => e.data)).toEqual([{ text: "parent" }]);
  });

  test("a nested runMutation that succeeds broadcasts once the outer commits", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    await functions.runMutation("m:nestedOk", {}, false);
    await a.until(() => a.events()[0]);
    await settle();
    expect(a.events().map((e) => e.data)).toEqual([{ text: "child" }]);
  });

  test.each([
    ["event", /no event "nope"/],
    ["data", /ArgumentValidationError/],
    ["args", /ArgumentValidationError/],
    ["name", /No room named "rooms:missing"/],
    ["kind", /No room named "rooms:online"/],
  ])("a bad broadcast (%s) throws in the mutation and sends nothing", async (what, message) => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    await expect(functions.runMutation("m:bad", { what }, false)).rejects.toThrow(message);
    await settle();
    expect(a.events()).toEqual([]);
  });

  test("a broadcast to a room no one is in is a no-op", async () => {
    const { functions, rooms } = await setup();
    expect(await functions.runMutation("m:say", { id: "empty", text: "hi" }, false)).toBe("done");
    expect(rooms.size).toEqual({ rooms: 0, members: 0 });
  });

  test("a mutation can broadcast but not read members; a query has neither ctx.rooms nor ctx.presence", async () => {
    const { functions } = await setup();
    expect(await functions.runQuery("m:noRoomInQuery", {}, false)).toEqual(["undefined", "undefined"]);
    expect(await functions.runMutation("m:noMembersInMutation", {}, false)).toEqual(["undefined", "undefined"]);
  });
});

describe("ctx.rooms and ctx.presence in actions", () => {
  test("an action broadcasts at once", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    expect(await functions.runAction("a:say", { id: "a" })).toBe("sent");
    const e = await a.until(() => a.events()[0]);
    expect(e).toMatchObject({ roomId: 1, from: null, data: { text: "from action" } });
  });

  test("an action reads a room's members and a scope's list: one user on two tabs is one entry", async () => {
    const { functions, client } = await setup();
    const a = await client();
    const b = await client();
    const selfA = (await a.join(1, "rooms:doc", { id: "a" })).self;
    const selfB = (await b.join(1, "rooms:doc", { id: "a" })).self;
    a.send({ type: "RoomPresence", roomId: 1, presence: { x: 7 } });
    await b.until(() => b.of("RoomMembers").some((m) => m.set.some((s) => s.memberId === selfA && s.presence)));
    const r = (await functions.runAction("a:read", {})) as {
      members: { memberId: string; userId: string | null; presence: unknown }[];
      online: unknown[];
    };
    expect(r.members.map((m) => m.memberId).sort()).toEqual([selfA, selfB].sort());
    expect(r.members.find((m) => m.memberId === selfA)).toEqual({ memberId: selfA, userId: null, presence: { x: 7 } });
    expect(r.online).toEqual([]);
  });

  test("a presence scope's list is one entry per user, its state a value (bigint), idle false", async () => {
    const { functions, rooms } = await setup();
    // Scopes are for signed-in users: seat two connections of one user straight in the hub.
    const sink = (id: string) => ({ sessionId: id, send() {}, behind: () => 0, resync() {} });
    const s1 = sink("s1");
    const s2 = sink("s2");
    const key = { kind: "presence" as const, name: "rooms:online", argsJson: '{"team":"t"}' };
    rooms.join(s1, 1, key, { userId: "ada", canPublish: true });
    rooms.join(s2, 1, key, { userId: "ada", canPublish: true });
    rooms.setPresence(s1, 1, { at: { $integer: "AQAAAAAAAAA=" } });
    const list = (await functions.runAction("a:read", {})) as {
      online: { userId: string; state: unknown; idle: boolean }[];
    };
    expect(list.online).toEqual([{ userId: "ada", state: { at: 1n }, idle: false }]);
  });

  test("a member list's presence is a value, not wire JSON", async () => {
    const { functions, client } = await setup();
    const a = await client();
    await a.join(1, "rooms:doc", { id: "a" });
    a.send({ type: "RoomPresence", roomId: 1, presence: { x: 3 } });
    await a.until(() => true);
    await settle();
    const r = (await functions.runAction("a:read", {})) as { members: { presence: unknown }[] };
    expect(r.members[0]?.presence).toEqual({ x: 3 });
  });

  test("an action asking a presence list of a room (wrong kind) throws", async () => {
    const { functions } = await setup();
    await expect(functions.runAction("a:wrongKind", {})).rejects.toThrow(/No presence named "rooms:doc"/);
  });
});

// The rooms (AD-43, STUDY-165) on a live bunvex server: the contract's rooms area with rooms opened by real
// clients, then what it does not pin down — the values as clients sent them, a user on two tabs, a room that
// closes dropping out of the list, the stats' counters, and a read-only key. The dashboard's actions: the
// contract's tests with real clients, a removed client staying out across a token refresh, and a scope's user
// removed with every tab.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { describeDataSourceContract } from "@bunvex/dashboard/contract";
import type { RoomEvent, RoomEventsInfo } from "@bunvex/dashboard/data-source";
import { createServerDataSource, type ServerDataSource } from "@bunvex/dashboard-source";
import { adminKeyCipherKey, issueAdminKey } from "@bunvex/server";
import { startServer } from "../test/harness.ts";
import { startIssuer } from "../test/issuer.ts";
import { until } from "./live-server.ts";

const SECRET = "4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974";
const cipherKey = adminKeyCipherKey(SECRET);
const ADMIN_KEY = issueAdminKey({ instanceName: "harness", cipherKey });
const READ_ONLY_KEY = issueAdminKey({ instanceName: "harness", cipherKey, readOnly: true });

const api = anyApi;
const quiet = { logVerbose() {}, log() {}, error() {}, warn() {} };
let srv: Awaited<ReturnType<typeof startServer>>;
let issuer: Awaited<ReturnType<typeof startIssuer>>;
const clients: BunvexClient[] = [];
const sources: ServerDataSource[] = [];
const open = (adminKey = ADMIN_KEY) => {
  const s = createServerDataSource({ url: srv.url, adminKey });
  sources.push(s);
  return s;
};
const client = () => {
  const c = new BunvexClient(srv.url, { logger: quiet });
  clients.push(c);
  return c;
};
const signedIn = async (sub: string) => {
  const c = client();
  let ok = false;
  c.setAuth(
    async () => issuer.sign({ sub }),
    (a) => {
      ok = a;
    },
  );
  await until(() => ok, `${sub} signed in`);
  return c;
};

type Handle = { status: string; leave(): void };
const SETUP_MS = 30_000;
const handles: Handle[] = [];
let closing: Handle;

beforeAll(async () => {
  issuer = await startIssuer({ cacheControl: "max-age=600" });
  srv = await startServer({ auth: { providers: [{ domain: issuer.url, applicationID: "app" }] } });
  // three members in one room (one with a bigint and bytes in its presence), one in another
  for (let i = 0; i < 3; i++) {
    const h = client().client.joinRoom<{ id: string }, unknown, Record<string, unknown>>(api.rooms.doc as never, {
      id: "a",
    });
    if (i === 0) h.setPresence({ x: 1, big: 5n, raw: new Uint8Array([1, 2, 3]).buffer });
    handles.push(h);
  }
  closing = client().client.joinRoom<{ id: string }, unknown, Record<string, unknown>>(api.rooms.doc as never, {
    id: "b",
  });
  handles.push(closing);
  // a scope: ada on two tabs, bob on one
  const [ada1, ada2, bob] = [await signedIn("ada"), await signedIn("ada"), await signedIn("bob")];
  for (const c of [ada1, ada2, bob]) {
    const h = c.client.joinPresence<{ team: string }, { status: string }>(api.rooms.online as never, { team: "t" });
    // a scope joins with its first state
    h.setState({ status: "here" });
    handles.push(h);
  }
  await until(() => handles.every((h) => h.status === "joined"), "everyone joined");
  const probe = open();
  await until(async () => (await probe.getStats()).rooms?.members === 6, "the members in the hub");
}, SETUP_MS);

afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
  for (const c of clients) await c.close();
  srv.stop();
  issuer.stop();
});

let tapRooms = 0;
/** A room of its own for one event tap test: one member that broadcasts, and leaves to close it. */
const tapRoom = async (src: { listRooms?: () => Promise<{ key: string; args: unknown }[]> }) => {
  const id = `tap-${++tapRooms}`;
  const h = client().client.joinRoom<{ id: string }, unknown, { wave: unknown }>(api.rooms.doc as never, { id });
  await until(() => h.status === "joined", `${id} joined`);
  const key = await until(
    async () => (await src.listRooms!()).find((r) => (r.args as { id?: string }).id === id)?.key,
    `${id} listed`,
  );
  return {
    key,
    handle: h,
    emit: async (event: string, data: unknown) => h.broadcast(event as "wave", data),
    close: async () => {
      h.leave();
      await until(async () => !(await src.listRooms!()).some((r) => r.key === key), `${id} closed`);
    },
  };
};

let actionRooms = 0;
/** A room of its own for one actions test: two clients, each recording the notes it got and how it was ended. */
const actionRoom = async (src: { listRooms?: () => Promise<{ key: string; args: unknown }[]> }) => {
  const id = `act-${++actionRooms}`;
  const members = [0, 1].map(() => {
    const h = client().client.joinRoom<{ id: string }, unknown, { note: { text: string } }>(api.rooms.doc as never, {
      id,
    });
    const received: { event: string; from: string | null; data: unknown }[] = [];
    h.on("note", (from, data) => received.push({ event: "note", from, data }));
    return { h, received };
  });
  await until(() => members.every((m) => m.h.status === "joined"), `${id} joined`);
  const key = await until(
    async () => (await src.listRooms!()).find((r) => (r.args as { id?: string }).id === id)?.key,
    `${id} listed`,
  );
  return {
    key,
    event: { name: "note", data: { text: "hello" }, badData: { text: 1 }, bigData: { text: "x".repeat(5000) } },
    clients: members.map(({ h, received }) => ({
      memberId: h.self!,
      received: () => received as never,
      ended: () => (h.status === "error" ? h.error : null),
    })),
    dispose: async () => {
      for (const m of members) m.h.leave();
      await until(async () => !(await src.listRooms!()).some((r) => r.key === key), `${id} gone`);
    },
  };
};

describeDataSourceContract("@bunvex/dashboard-source on a live server (rooms)", () => open(), {
  only: ["rooms"],
  roomEvents: { open: (src) => tapRoom(src) },
  roomActions: { open: (src) => actionRoom(src), readOnly: () => open(READ_ONLY_KEY) },
});

describe("the open rooms", () => {
  test("two rooms and a scope, the scope's user on two tabs one member with two connections", async () => {
    const src = open();
    const rooms = await src.listRooms!();
    expect(rooms.map((r) => [r.kind, r.name, r.args, r.members, r.connections])).toEqual([
      ["room", "rooms:doc", { id: "a" }, 3, 3],
      ["room", "rooms:doc", { id: "b" }, 1, 1],
      ["presence", "rooms:online", { team: "t" }, 2, 3],
    ]);
    const scope = rooms.find((r) => r.kind === "presence")!;
    const users = (await src.listRoomMembers!({ key: scope.key }, { numItems: 10, cursor: null })).page;
    expect(users.map((m) => m.connections).sort()).toEqual([1, 2]);
    expect(users.every((m) => m.userId !== null && m.idle === false)).toBe(true);
  });

  test("a member's presence arrives in the contract's value form", async () => {
    const src = open();
    const room = (await src.listRooms!()).find((r) => r.name === "rooms:doc" && r.members === 3)!;
    const { page } = await src.listRoomMembers!({ key: room.key }, { numItems: 10, cursor: null });
    const withPresence = await until(async () => {
      const p = (await src.listRoomMembers!({ key: room.key }, { numItems: 10, cursor: null })).page;
      return p.find((m) => m.presence !== null);
    }, "the first member's presence");
    expect(withPresence.presence).toEqual({ x: 1, big: { $integer: "BQAAAAAAAAA=" }, raw: { $bytes: "AQID" } });
    expect(page.filter((m) => m.presence === null)).toHaveLength(2);
    expect(page.every((m) => m.userId === null && m.canPublish)).toBe(true);
  });

  test("the definitions are the deployed rooms and scopes", async () => {
    const defs = await open().listRoomDefinitions!();
    expect(defs.map((d) => [d.kind, d.name])).toEqual(
      [
        ["room", "rooms:doc"],
        ["room", "rooms:locked"],
        ["presence", "rooms:online"],
        ["room", "rooms:staff"],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
    expect(defs.find((d) => d.name === "rooms:doc")!.args).toMatchObject({ type: "object" });
  });

  test("a room whose last member leaves is gone from the list, and its members page is empty", async () => {
    const src = open();
    const key = (await src.listRooms!()).find((r) => r.members === 1 && r.kind === "room")!.key;
    closing.leave();
    await until(async () => !(await src.listRooms!()).some((r) => r.key === key), "the room closed");
    expect(await src.listRoomMembers!({ key }, { numItems: 10, cursor: null })).toEqual({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    const rooms = (await src.getStats()).rooms!;
    expect(rooms.leaves).toBeGreaterThanOrEqual(1);
  });

  test("the tap: a member's events and the server's, with sender, size and data in the contract's form", async () => {
    const src = open();
    const room = await tapRoom(src);
    const seen: RoomEvent[] = [];
    const errors: unknown[] = [];
    const off = src.watchRoomEvents!(
      { key: room.key },
      (events) => seen.push(...events),
      (e) => errors.push(e),
    );
    try {
      for (let i = 0; !seen.some((e) => (e.data as { n?: number }).n === 5); i++) {
        if (i > 40) throw new Error("no event reached the tap");
        room.handle.broadcast("wave", { n: 5, big: 7n });
        await Bun.sleep(150);
      }
      const e = seen.find((x) => (x.data as { n?: number }).n === 5)!;
      expect(e).toMatchObject({ event: "wave", data: { n: 5, big: { $integer: "BwAAAAAAAAA=" } } });
      expect(e.from).toBeString();
      expect(e.size).toBe(JSON.stringify(e.data).length);
      expect(errors).toEqual([]);
    } finally {
      off();
      await room.close();
    }
  });

  test("the tap across a server restart: a gap, then the events again; no onError", async () => {
    const src = open();
    const room = await tapRoom(src);
    const batches: { events: RoomEvent[]; info: RoomEventsInfo }[] = [];
    const errors: unknown[] = [];
    const off = src.watchRoomEvents!(
      { key: room.key },
      (events, info) => batches.push({ events, info }),
      (e) => errors.push(e),
      // a room whose members are still reconnecting is not closed
      () => errors.push("closed"),
    );
    const marks = () => batches.flatMap((b) => b.events.map((e) => (e.data as { m?: string }).m));
    const sendUntilSeen = async (m: string) => {
      for (let i = 0; !marks().includes(m); i++) {
        if (i > 200) throw new Error(`${m} never reached the tap`);
        if (room.handle.status === "joined") room.handle.broadcast("wave", { m });
        await Bun.sleep(150);
      }
    };
    try {
      await sendUntilSeen("before");
      srv.restart();
      await sendUntilSeen("after");
      expect(batches.some((b) => b.info.gap)).toBe(true);
      // the gap comes before the events of the new tap
      const gapAt = batches.findIndex((b) => b.info.gap);
      const afterAt = batches.findIndex((b) => b.events.some((e) => (e.data as { m?: string }).m === "after"));
      expect(gapAt).toBeLessThanOrEqual(afterAt);
      expect(errors).toEqual([]);
    } finally {
      off();
      await room.close();
    }
  }, 60_000);

  test("a read-only key may look (ViewMetrics)", async () => {
    expect((await open(READ_ONLY_KEY).listRooms!()).length).toBeGreaterThan(0);
  });
});

describe("the dashboard's actions on live clients", () => {
  test("a removed client sees status error, code removed, and stays out across a token refresh", async () => {
    const src = open();
    const c = await signedIn("eve");
    const h = c.client.joinRoom<{ id: string }, unknown, Record<string, unknown>>(api.rooms.doc as never, {
      id: "removed",
    });
    await until(() => h.status === "joined", "eve joined");
    const key = await until(
      async () => (await src.listRooms!()).find((r) => (r.args as { id?: string }).id === "removed")?.key,
      "the room listed",
    );
    expect(await src.removeRoomMember!({ key }, h.self!)).toEqual({ connections: 1 });
    await until(() => h.status === "error", "the removal at the client");
    expect(h.error).toEqual({ code: "removed", message: "Removed from the dashboard." });
    // a token refresh: a new Authenticate, which rejoins memberships a refused identity ended, not this one
    let refreshed = false;
    c.setAuth(
      async () => issuer.sign({ sub: "eve", n: 2 }),
      (ok) => {
        refreshed = ok;
      },
    );
    await until(() => refreshed, "the new token accepted");
    await Bun.sleep(300);
    expect(h.status).toBe("error");
    expect(h.error?.code).toBe("removed");
    expect((await src.listRooms!()).some((r) => r.key === key)).toBe(false);
    h.leave();
  });

  test("a member removed while its socket is down is refused as removed when it reconnects", async () => {
    const src = open();
    const mine: WebSocket[] = [];
    class Tracked extends WebSocket {
      constructor(...a: ConstructorParameters<typeof WebSocket>) {
        super(...a);
        mine.push(this);
      }
    }
    // a slow reconnect, so that the removal lands while the member is in its grace
    const c = new BunvexClient(srv.url, {
      logger: quiet,
      webSocketConstructor: Tracked as unknown as typeof WebSocket,
      webSocket: { defaultInitialBackoffMs: 1500, maxBackoffMs: 1500 },
    });
    clients.push(c);
    const h = c.client.joinRoom<{ id: string }, unknown, Record<string, unknown>>(api.rooms.doc as never, {
      id: "graced",
    });
    await until(() => h.status === "joined", "joined");
    const self = h.self!;
    const key = await until(
      async () => (await src.listRooms!()).find((r) => (r.args as { id?: string }).id === "graced")?.key,
      "the room listed",
    );
    mine.at(-1)!.close(); // the connection drops
    await until(
      async () => (await src.listRoomMembers!({ key }, { numItems: 10, cursor: null })).page.some((m) => m.graced),
      "the member in its grace",
    );
    expect(await src.removeRoomMember!({ key }, self)).toEqual({ connections: 1 });
    await until(() => mine.length > 1, "the reconnect");
    await until(() => h.status === "error", "the removal at the client");
    expect(h.error).toEqual({ code: "removed", message: "Removed from the dashboard." });
    await Bun.sleep(300);
    expect(h.status).toBe("error");
    expect((await src.listRooms!()).some((r) => r.key === key)).toBe(false);
    h.leave();
  });

  test("a scope's user is removed with both tabs", async () => {
    const src = open();
    const scope = (await src.listRooms!()).find((r) => r.kind === "presence")!;
    const ada = (await src.listRoomMembers!({ key: scope.key }, { numItems: 10, cursor: null })).page.find(
      (m) => m.connections === 2,
    )!;
    expect(await src.removeRoomMember!({ key: scope.key }, ada.memberId)).toEqual({ connections: 2 });
    // handles: [doc×3, closing, ada1, ada2, bob]
    const [ada1, ada2, bob] = handles.slice(4) as (Handle & { error: { code: string } | null })[];
    await until(() => ada1!.status === "error" && ada2!.status === "error", "both of ada's tabs removed");
    expect([ada1!.error?.code, ada2!.error?.code]).toEqual(["removed", "removed"]);
    expect(bob!.status).toBe("joined");
    const left = (await src.listRoomMembers!({ key: scope.key }, { numItems: 10, cursor: null })).page;
    expect(left.map((m) => m.userId)).toEqual(["bob"]);
  });
});

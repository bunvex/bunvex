// The rooms (AD-43, STUDY-165): `/api/debug/rooms`, `/members` and `/definitions` read as the contract's types —
// the admin key, the key and the cursor passed through, `numItems` capped at 100, the values as the contract's —
// and what a server without rooms answers.
import { describe, expect, test } from "bun:test";
import {
  DataSourceError,
  type RoomDefinition,
  type RoomEvent,
  type RoomEventsInfo,
} from "@bunvex/dashboard/data-source";
import { AdminHttp } from "../src/admin-http.ts";
import { ROOM_CLOSED_RETRY_MS, type RoomsOptions, roomStatsOf, roomsReads } from "../src/rooms.ts";

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

  test("a numItems that is NaN is asked as the default, 100", async () => {
    const { rooms, asked } = answering(() => Response.json({ page: [], isDone: true, continueCursor: "" }));
    await rooms.listRoomMembers({ key: "k" }, { numItems: Number.NaN, cursor: null });
    expect(new URL(asked[0]!.url).searchParams.get("numItems")).toBe("100");
  });

  test("a 400 for a malformed key is invalid_request with the server's message", async () => {
    const { rooms } = answering(() =>
      Response.json({ code: "BadRequest", message: "`key` is not a room key from the list." }, { status: 400 }),
    );
    const e = await rooms.listRoomMembers({ key: "" }, { numItems: 1, cursor: null }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "invalid_request", message: "`key` is not a room key from the list." });
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

// ------------------------------------------------------------------ the event tap

type TapJson = { events: unknown[]; newCursor: number; dropped?: number; reset?: true; closed?: true };

/** A room's tap as the server keeps it: no cursor starts it, a cursor waits for the next event (held here). */
class FakeTap {
  asked: string[] = [];
  aborted = 0;
  seq = 0;
  events: { seq: number; [k: string]: unknown }[] = [];
  closed = false;
  /** Answers for the next requests, before the tap logic (a failure, a reset). */
  script: (() => Response)[] = [];
  private held: (() => void)[] = [];
  get waiting() {
    return this.held.length;
  }
  readonly http = new AdminHttp({
    url: "http://x",
    adminKey: "k",
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      this.asked.push(`${url.pathname}${url.search}`);
      const scripted = this.script.shift();
      if (scripted) return scripted();
      const raw = url.searchParams.get("cursor");
      const cursor = raw === null ? null : Number(raw);
      if (this.closed) return Response.json({ events: [], newCursor: cursor ?? 0, closed: true });
      if (cursor === null) return Response.json({ events: [], newCursor: this.seq });
      if (cursor >= this.seq)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            this.held = this.held.filter((h) => h !== done);
            resolve();
          };
          this.held.push(done);
          init?.signal?.addEventListener("abort", () => {
            this.aborted++;
            this.held = this.held.filter((h) => h !== done);
            reject(init.signal!.reason);
          });
        });
      if (this.closed) return Response.json({ events: [], newCursor: cursor, closed: true });
      const events = this.events.filter((e) => e.seq > cursor);
      return Response.json({ events, newCursor: events.at(-1)?.seq ?? cursor } satisfies TapJson);
    }) as typeof fetch,
  });
  push(over: Record<string, unknown> = {}) {
    this.seq++;
    this.events.push({ seq: this.seq, at: 1000 + this.seq, event: "wave", from: "m1", size: 2, data: {}, ...over });
    for (const h of [...this.held]) h();
  }
  close() {
    this.closed = true;
    for (const h of [...this.held]) h();
  }
}

const settle = () => Bun.sleep(10);
async function until(done: () => boolean, what: string) {
  for (let i = 0; !done(); i++) {
    if (i > 300) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}
const KEY = "room|rooms:doc|{}";
const evPath = (cursor: number | null, timeoutMs?: number) =>
  `/api/debug/rooms/events?key=${encodeURIComponent(KEY)}${cursor === null ? "" : `&cursor=${cursor}&timeoutMs=${timeoutMs ?? 60000}`}`;

function tapper(tap: FakeTap, opts: RoomsOptions = {}) {
  const batches: { events: RoomEvent[]; info: RoomEventsInfo }[] = [];
  const errors: DataSourceError[] = [];
  let closed = 0;
  const rooms = roomsReads(tap.http, { backoff: () => 1, ...opts });
  const off = rooms.watchRoomEvents(
    { key: KEY },
    (events, info) => batches.push({ events, info }),
    (e) => errors.push(e),
    () => closed++,
  );
  return {
    rooms,
    off,
    batches,
    errors,
    closed: () => closed,
    seqs: () => batches.flatMap((b) => b.events.map((e) => e.seq)),
  };
}

describe("watchRoomEvents", () => {
  test("starts without a cursor, then follows from newCursor; never synchronously; the events as the contract's", async () => {
    const tap = new FakeTap();
    tap.push(); // before the call: not seen
    const t = tapper(tap);
    expect(tap.asked).toEqual([]);
    await until(() => tap.waiting === 1, "the follow request");
    expect(tap.asked).toEqual([evPath(null), evPath(1)]);
    tap.push({ data: { $integer: "BQAAAAAAAAA=" }, extra: 1 });
    tap.push({ from: null, data: null, dataOmitted: true, size: 20_000 });
    await until(() => t.seqs().length === 2 && tap.waiting === 1, "the events");
    expect(t.batches.flatMap((b) => b.events)).toEqual([
      { seq: 2, at: 1002, event: "wave", from: "m1", size: 2, data: { $integer: "BQAAAAAAAAA=" } },
      { seq: 3, at: 1003, event: "wave", from: null, size: 20_000, data: null, dataOmitted: true },
    ]);
    expect(t.batches.every((b) => b.info.dropped === 0 && !b.info.gap)).toBe(true);
    expect(tap.asked.at(-1)).toBe(evPath(3));
    expect(tap.asked.every((p) => p.startsWith("/api/debug/rooms/events?"))).toBe(true);
    t.off();
    expect(t.errors).toEqual([]);
  });

  test("dropped is passed on with its batch", async () => {
    const tap = new FakeTap();
    const t = tapper(tap);
    await until(() => tap.waiting === 1, "the follow request");
    tap.script.push(() =>
      Response.json({
        events: [{ seq: 9, at: 1, event: "e", from: null, size: 1, data: 1 }],
        newCursor: 9,
        dropped: 8,
      }),
    );
    tap.push(); // answers the held request (seq 1)
    await until(() => t.batches.length === 2, "two batches");
    expect(t.batches.map((b) => [b.events.map((e) => e.seq), b.info])).toEqual([
      [[1], { dropped: 0, gap: false }],
      [[9], { dropped: 8, gap: false }],
    ]);
    t.off();
  });

  test("a reset (the tap expired, or the server restarted) is a gap, and the follow goes on from its seq", async () => {
    const tap = new FakeTap();
    const t = tapper(tap);
    await until(() => tap.waiting === 1, "the follow request");
    // the next request finds the tap gone: the server started a new one, at 0
    tap.script.push(() => {
      tap.seq = 0;
      tap.events = [];
      return Response.json({ events: [], newCursor: 0, reset: true });
    });
    tap.push();
    await until(() => t.batches.length === 2 && tap.waiting === 1, "the gap, then following again");
    expect(t.batches[1]).toEqual({ events: [], info: { dropped: 0, gap: true } });
    expect(tap.asked.at(-1)).toBe(evPath(0));
    tap.push();
    await until(() => t.batches.length === 3, "after the gap");
    expect(t.batches[2]!.info).toEqual({ dropped: 0, gap: false });
    expect(t.errors).toEqual([]);
    t.off();
  });

  test("a transient failure is retried with a backoff, restarts the tap without a cursor, and says gap; no onError", async () => {
    const tap = new FakeTap();
    const backoffs: number[] = [];
    const t = tapper(tap, {
      backoff: (n) => {
        backoffs.push(n);
        return 1;
      },
    });
    await until(() => tap.waiting === 1, "the follow request");
    for (let i = 0; i < 7; i++) tap.script.push(() => new Response("down", { status: 503 }));
    tap.push(); // seq 1 delivered; the next seven requests fail
    await until(() => backoffs.length === 7 && tap.waiting === 1, "the retries, then following again");
    expect(backoffs).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.errors).toEqual([]);
    // after the failures: the tap again without a cursor, a gap, then the follow
    expect(tap.asked.slice(-2)).toEqual([evPath(null), evPath(1)]);
    expect(t.batches.map((b) => b.info)).toEqual([
      { dropped: 0, gap: false },
      { dropped: 0, gap: true },
    ]);
    expect(t.batches[1]!.events).toEqual([]);
    t.off();
  });

  test("after a failure, a room found closed is asked again for a while (its members may still be reconnecting)", async () => {
    let now = 0;
    const tap = new FakeTap();
    const t = tapper(tap, { now: () => now });
    await until(() => tap.waiting === 1, "the follow request");
    // a restart: the request fails, then the room is not open yet, then it is again
    tap.script.push(() => new Response("down", { status: 502 }));
    tap.script.push(() => Response.json({ events: [], newCursor: 0, closed: true }));
    tap.script.push(() => {
      now += 4000;
      return Response.json({ events: [], newCursor: 0, closed: true });
    });
    tap.push();
    await until(() => tap.waiting === 1 && t.batches.length === 2, "following again");
    expect(t.closed()).toBe(0);
    expect(t.batches[1]).toEqual({ events: [], info: { dropped: 0, gap: true } });
    // and once following, a closed room is closed at once
    tap.close();
    await until(() => t.closed() === 1, "onClosed");
  });

  test("after a failure, a room still closed when the reconnect window is over is closed", async () => {
    let now = 0;
    const tap = new FakeTap();
    const t = tapper(tap, { now: () => now });
    await until(() => tap.waiting === 1, "the follow request");
    tap.script.push(() => new Response("down", { status: 502 }));
    tap.script.push(() => {
      now += ROOM_CLOSED_RETRY_MS + 1;
      return Response.json({ events: [], newCursor: 0, closed: true });
    });
    tap.push();
    await until(() => t.closed() === 1, "onClosed");
    expect(t.errors).toEqual([]);
  });

  test("a closed room: onClosed, and nothing more is asked", async () => {
    const tap = new FakeTap();
    const t = tapper(tap);
    await until(() => tap.waiting === 1, "the follow request");
    tap.close();
    await until(() => t.closed() === 1, "onClosed");
    const n = tap.asked.length;
    await settle();
    expect(tap.asked).toHaveLength(n);
    expect([t.closed(), t.errors.length, t.batches.length]).toEqual([1, 0, 0]);
  });

  test("terminal errors: 404 is not_found (no rooms), 403 unauthorized, 400 invalid_request; then no more calls", async () => {
    for (const [status, code] of [
      [404, "not_found"],
      [403, "unauthorized"],
      [400, "invalid_request"],
    ] as const) {
      const tap = new FakeTap();
      tap.script.push(() => new Response("no", { status }));
      const t = tapper(tap);
      await until(() => t.errors.length === 1, "the error");
      await settle();
      expect(t.errors.map((e) => e.code)).toEqual([code]);
      if (status === 404) expect(t.errors[0]!.message).toMatch(/does not run rooms/);
      expect(tap.asked).toHaveLength(1);
      expect(t.batches).toEqual([]);
    }
  });

  test("stopping aborts the request in flight; nothing is asked or delivered after; close stops every tap", async () => {
    const tap = new FakeTap();
    const t = tapper(tap);
    await until(() => tap.waiting === 1, "the follow request");
    const n = tap.asked.length;
    t.off();
    await until(() => tap.aborted === 1, "the abort");
    tap.push();
    await settle();
    expect([tap.asked.length, t.batches.length, t.errors.length]).toEqual([n, 0, 0]);
    // close(): every tap of the reads stops
    const t2 = tapper(tap);
    await until(() => tap.waiting === 1, "the second follow request");
    t2.rooms.close();
    await until(() => tap.aborted === 2, "the second abort");
  });
});

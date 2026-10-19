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
import { ROOM_CLOSED_RETRY_DELAY_MS, type RoomsOptions, roomStatsOf, roomsReads } from "../src/rooms.ts";

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

type TapJson = {
  events: unknown[];
  newCursor: number;
  epoch?: string;
  dropped?: number;
  reset?: true;
  closed?: true;
};

/** A room's tap as the server keeps it: no cursor starts it, a cursor waits for the next event (held here). */
class FakeTap {
  asked: string[] = [];
  aborted = 0;
  seq = 0;
  epoch = "A";
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
      if (cursor === null) return Response.json({ events: [], newCursor: this.seq, epoch: this.epoch });
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
      return Response.json({ events, newCursor: events.at(-1)?.seq ?? cursor, epoch: this.epoch } satisfies TapJson);
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
/** The loop's timers, every wait cut to a tick. */
const fast: RoomsOptions["after"] = (fn) => {
  const h = setTimeout(fn, 0);
  return () => clearTimeout(h);
};
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
    const t = tapper(tap, { now: () => now, after: fast });
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

  test("after an outage longer than the window, a room found closed is asked again for the window from that answer", async () => {
    let now = 0;
    const waits: number[] = [];
    const tap = new FakeTap();
    const t = tapper(tap, {
      now: () => now,
      backoff: () => 7,
      after: (fn, ms) => {
        if (ms > 0) waits.push(ms);
        const h = setTimeout(fn, 0);
        return () => clearTimeout(h);
      },
    });
    await until(() => tap.waiting === 1, "the follow request");
    // a slow restart: 11 s of failures
    tap.script.push(() => new Response("down", { status: 502 }));
    tap.script.push(() => {
      now += 11_000;
      return new Response("down", { status: 502 });
    });
    // then the room is not open yet, answer after answer, 3 s apart
    let closedAnswers = 0;
    for (let i = 0; i < 6; i++)
      tap.script.push(() => {
        if (closedAnswers++ > 0) now += 3000;
        return Response.json({ events: [], newCursor: 0, closed: true });
      });
    tap.push();
    await until(() => t.closed() === 1, "onClosed");
    // the window starts at the first closed answer (11 000), and ends 10 s later: answers at 11, 14, 17, 20 s are
    // asked again, the one at 23 s is closed
    expect(closedAnswers).toBe(5);
    // the outage's backoff, then a short fixed delay between the closed answers
    expect(waits).toEqual([
      7,
      7,
      ROOM_CLOSED_RETRY_DELAY_MS,
      ROOM_CLOSED_RETRY_DELAY_MS,
      ROOM_CLOSED_RETRY_DELAY_MS,
      ROOM_CLOSED_RETRY_DELAY_MS,
    ]);
    expect(t.errors).toEqual([]);
  });

  test("a new tap behind the same cursor (expired, then made again by another viewer) is a gap, told by its epoch", async () => {
    const tap = new FakeTap();
    const t = tapper(tap);
    await until(() => tap.waiting === 1, "the follow request");
    tap.push(); // seq 1 of tap A
    await until(() => t.batches.length === 1 && tap.waiting === 1, "following from 1");
    // while this viewer stalls, tap A expires and another viewer makes tap B, whose seq passes 1
    tap.epoch = "B";
    tap.seq = 0;
    tap.events = [];
    tap.push();
    tap.push();
    tap.push();
    await until(() => t.batches.length === 2, "the batch of the new tap");
    expect(t.batches[1]!.info).toEqual({ dropped: 0, gap: true });
    expect(t.batches[1]!.events.map((e) => e.seq)).toEqual([2, 3]);
    tap.push();
    await until(() => t.batches.length === 3, "after the gap");
    expect(t.batches[2]!.info.gap).toBe(false);
    t.off();
  });

  test("a consumer that throws is not taken for a failure: the error surfaces, nothing is retried", async () => {
    // in a process of its own: the error must surface (the test runner would take it for this test's)
    const src = new URL("../src/rooms.ts", import.meta.url).pathname;
    const http = new URL("../src/admin-http.ts", import.meta.url).pathname;
    const script = `
      import { roomsReads } from ${JSON.stringify(src)};
      import { AdminHttp } from ${JSON.stringify(http)};
      let asked = 0;
      const fetch = async (input) => {
        asked++;
        const cursor = new URL(String(input)).searchParams.get("cursor");
        if (cursor === null) return Response.json({ events: [], newCursor: 0, epoch: "A" });
        if (asked > 2) return new Promise(() => {});
        return Response.json({ events: [{ seq: 1, at: 1, event: "e", from: null, size: 1, data: 1 }], newCursor: 1, epoch: "A" });
      };
      process.on("exit", () => console.log("asked=" + asked));
      roomsReads(new AdminHttp({ url: "http://x", adminKey: "k", fetch }), { backoff: () => 1 }).watchRoomEvents(
        { key: "room|a:b|{}" },
        () => { throw new Error("consumer bug"); },
        (e) => console.log("onError " + e.code),
      );
      setTimeout(() => {}, 300);
      // never left running, whatever happens
      setTimeout(() => process.exit(3), 3000).unref();
    `;
    const p = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    expect(err).toContain("consumer bug");
    expect(code).not.toBe(0);
    expect(out).not.toContain("onError");
    // the first two requests only: nothing retried after the throw
    expect(out).toContain("asked=2");
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

describe("the actions (STUDY-165 §3.4)", () => {
  /** A source whose server answers `respond`, recording each request's method, path and JSON body. */
  function posting(respond: (path: string) => Response) {
    const asked: { method: string; path: string; body: unknown; auth: string | null }[] = [];
    const http = new AdminHttp({
      url: "http://x",
      adminKey: "k",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(String(input), init);
        const path = new URL(req.url).pathname;
        asked.push({ method: req.method, path, body: await req.json(), auth: req.headers.get("authorization") });
        return respond(path);
      }) as typeof fetch,
    });
    return { rooms: roomsReads(http), asked };
  }
  const KEY = { key: 'room|rooms:doc|{"id":"a"}' };

  test("each POSTs its body with the admin key, and answers what the server counted", async () => {
    const { rooms, asked } = posting((path) =>
      path.endsWith("/broadcast")
        ? Response.json({})
        : path.endsWith("/remove")
          ? Response.json({ removed: { connections: 2, extra: 1 } })
          : Response.json({ closed: { members: 3, connections: 4 } }),
    );
    expect(await rooms.broadcastRoomEvent(KEY, "ping", { n: { $integer: "AQAAAAAAAAA=" } })).toBeUndefined();
    expect(await rooms.removeRoomMember(KEY, "m1")).toEqual({ connections: 2 });
    expect(await rooms.closeRoom(KEY)).toEqual({ members: 3, connections: 4 });
    expect(asked).toEqual([
      {
        method: "POST",
        path: "/api/debug/rooms/broadcast",
        body: { key: KEY.key, event: "ping", data: { n: { $integer: "AQAAAAAAAAA=" } } },
        auth: "Bunvex k",
      },
      { method: "POST", path: "/api/debug/rooms/remove", body: { key: KEY.key, memberId: "m1" }, auth: "Bunvex k" },
      { method: "POST", path: "/api/debug/rooms/close", body: { key: KEY.key }, auth: "Bunvex k" },
    ]);
  });

  test("null when there was nothing to remove or close", async () => {
    const { rooms } = posting((path) =>
      path.endsWith("/remove") ? Response.json({ removed: null }) : Response.json({ closed: null }),
    );
    expect(await rooms.removeRoomMember(KEY, "m1")).toBeNull();
    expect(await rooms.closeRoom(KEY)).toBeNull();
  });

  test("errors: a refused key is unauthorized, a 400 invalid_request in the server's words, a room not open not_found", async () => {
    const code = async (status: number, body: unknown) => {
      const { rooms } = posting(() => Response.json(body, { status }));
      const e = (await rooms.broadcastRoomEvent(KEY, "ping", {}).catch((x: unknown) => x)) as DataSourceError;
      expect(e).toBeInstanceOf(DataSourceError);
      return [e.code, e.message];
    };
    expect(await code(403, { code: "OperationNotPermitted", message: "no" })).toEqual(["unauthorized", "no"]);
    expect(await code(400, { code: "BadRequest", message: 'This room has no event "ping".' })).toEqual([
      "invalid_request",
      'This room has no event "ping".',
    ]);
    expect(await code(404, { code: "RoomNotOpen", message: "The room is not open." })).toEqual([
      "not_found",
      "The room is not open.",
    ]);
    // an older server, without the routes
    const [c, m] = await code(404, { code: "NotFound", message: "no route" });
    expect(c).toBe("not_found");
    expect(m).toMatch(/does not run rooms/);
  });
});

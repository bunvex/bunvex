// The sync socket's WS heartbeat and close frames (STUDY-104), as Convex's `run_sync_socket`
// (crates/local_backend/src/subs/mod.rs) and `ErrorMetadata::close_frame` (crates/errors/src/lib.rs): a WS ping
// every 5 s, a client silent for 120 s closed with 1000 `ClientDisconnected`, any inbound frame counting as
// life. The timings are injected (`wsHeartbeat`) so the cases run in milliseconds.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_NORMAL,
  CLOSE_TRY_AGAIN_LATER,
  closeFrame,
  type ErrorCode,
  isDeterministicUserError,
  truncateUtf8,
} from "../src/close-frame.ts";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { CLIENT_TIMEOUT_MS, WS_PING_INTERVAL_MS, type WsHeartbeatOptions } from "../src/sync.ts";
import { type RawWs, rawWs } from "./raw-ws.ts";
import { syncUrl, v1Client } from "./v1-client.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

const PING_MS = 25;
const TIMEOUT_MS = 200;

async function setup(
  wsHeartbeat: Partial<WsHeartbeatOptions> = { pingIntervalMs: PING_MS, clientTimeoutMs: TIMEOUT_MS },
) {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("m", { one: query(() => 1) });
  const { server, sync, stop } = createServer({ engine, functions, port: 0, wsHeartbeat });
  stops.push(stop);
  return { port: server.port!, sync };
}

describe("close frames (Convex's ErrorMetadata::close_frame)", () => {
  const all: ErrorCode[] = [
    "BadRequest",
    "Unauthenticated",
    "AuthUpdateFailed",
    "Conflict",
    "NotFound",
    "PaginationLimit",
    "Forbidden",
    "ClientDisconnect",
    "OCC",
    "OutOfRetention",
    "Overloaded",
    "FeatureTemporarilyUnavailable",
    "RateLimited",
    "RejectedBeforeExecution",
    "MisdirectedRequest",
    "TooEarly",
    "OperationalInternalServerError",
  ];

  test("each code's close frame, the short code as the reason", () => {
    const frames = Object.fromEntries(all.map((code) => [code, closeFrame({ code, shortMsg: "Short" })?.code ?? null]));
    expect(frames).toEqual({
      BadRequest: null,
      Unauthenticated: null,
      AuthUpdateFailed: null,
      Conflict: null,
      NotFound: CLOSE_NORMAL,
      PaginationLimit: CLOSE_NORMAL,
      Forbidden: CLOSE_NORMAL,
      ClientDisconnect: CLOSE_NORMAL,
      OCC: CLOSE_TRY_AGAIN_LATER,
      OutOfRetention: CLOSE_TRY_AGAIN_LATER,
      Overloaded: CLOSE_TRY_AGAIN_LATER,
      FeatureTemporarilyUnavailable: CLOSE_TRY_AGAIN_LATER,
      RateLimited: CLOSE_TRY_AGAIN_LATER,
      RejectedBeforeExecution: CLOSE_TRY_AGAIN_LATER,
      MisdirectedRequest: CLOSE_TRY_AGAIN_LATER,
      TooEarly: CLOSE_TRY_AGAIN_LATER,
      OperationalInternalServerError: CLOSE_INTERNAL_ERROR,
    });
    expect([CLOSE_NORMAL, CLOSE_INTERNAL_ERROR, CLOSE_TRY_AGAIN_LATER]).toEqual([1000, 1011, 1013]);
    expect(closeFrame({ code: "Forbidden", shortMsg: "NoAccess" })).toEqual({ code: 1000, reason: "NoAccess" });
    expect(closeFrame({ code: "NotFound", shortMsg: "NoSuchThing" })).toEqual({ code: 1000, reason: "NoSuchThing" });
  });

  test("a FatalError first for the client errors: Forbidden yes, NotFound and ClientDisconnect no", () => {
    expect(all.filter(isDeterministicUserError)).toEqual([
      "BadRequest",
      "Unauthenticated",
      "AuthUpdateFailed",
      "Conflict",
      "PaginationLimit",
      "Forbidden",
    ]);
  });

  test("the reason is cut to 123 bytes, at a character boundary", () => {
    expect(closeFrame({ code: "NotFound", shortMsg: "x".repeat(200) })!.reason).toBe("x".repeat(123));
    expect(truncateUtf8("é".repeat(100), 123)).toBe("é".repeat(61)); // 2 bytes each: 122, not half of the 62nd
    expect(truncateUtf8("short", 123)).toBe("short");
  });
});

describe("the WS heartbeat", () => {
  test("Convex's timings: a ping every 5 s, a client silent for 120 s closed", () => {
    expect(WS_PING_INTERVAL_MS).toBe(5_000);
    expect(CLIENT_TIMEOUT_MS).toBe(120_000);
  });

  test("a client that never answers is pinged, then closed with 1000 ClientDisconnected and nothing before", async () => {
    const { port, sync } = await setup();
    const c = await rawWs(port);
    const opened = performance.now();
    await c.closed;
    const after = performance.now() - opened;
    expect(c.closeFrame).toEqual({ code: 1000, reason: "ClientDisconnected" });
    // Not a client error: no FatalError (Convex's `is_deterministic_user_error` is false for ClientDisconnect).
    expect(c.got).toEqual([]);
    expect(after).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
    expect(after).toBeLessThan(TIMEOUT_MS + 500);
    // Pinged on the interval: one every 25 ms over 200 ms, give or take the timers.
    expect(c.pings.length).toBeGreaterThanOrEqual(4);
    expect(c.pings.length).toBeLessThanOrEqual(Math.ceil(after / PING_MS) + 1);
    expect(sync.sessions.size).toBe(0);
  });

  const keepAlives: [string, (c: RawWs) => void][] = [
    ["pongs", (c) => c.pong()],
    ["pings of its own", (c) => c.ping()],
    // A message the server takes and ignores (the client's `Event`).
    ["messages", (c) => c.send({ type: "Event", eventType: "keepalive", event: null })],
  ];
  for (const [how, keepAlive] of keepAlives) {
    test(`a client that sends only ${how} stays open past the timeout`, async () => {
      const { port, sync } = await setup();
      const c = await rawWs(port);
      const timer = setInterval(() => keepAlive(c), PING_MS);
      await Bun.sleep(TIMEOUT_MS * 3);
      clearInterval(timer);
      expect(c.closeFrame).toBeNull();
      expect(c.got.filter((m) => m.type === "FatalError")).toEqual([]);
      expect(sync.sessions.size).toBe(1);
      if (how === "pings of its own") expect(c.pongs.length).toBeGreaterThan(0); // Bun answers them
      // Silent from here on: closed by the timeout.
      await c.closed;
      expect(c.closeFrame).toEqual({ code: 1000, reason: "ClientDisconnected" });
    });
  }

  test("a WebSocket client (which answers pings itself) stays connected across many intervals", async () => {
    const { port, sync } = await setup();
    const c = await v1Client(syncUrl(port));
    let closed: CloseEvent | null = null;
    c.closed.then((e) => (closed = e));
    await Bun.sleep(TIMEOUT_MS * 4);
    expect(closed).toBeNull();
    expect(sync.sessions.size).toBe(1);
    c.modify([{ type: "Add", queryId: 0, udfPath: "m:one", args: [{}] }]);
    await c.transition(0);
    c.ws.close();
  });
});

describe("closes without a code arrive as 1005, as Convex's", () => {
  test("a malformed message: FatalError, then an empty close frame", async () => {
    const { port } = await setup({});
    const c = await rawWs(port);
    c.send({ type: "Nope" } as never);
    await c.closed;
    expect(c.got.map((m) => m.type)).toEqual(["FatalError"]);
    expect(c.closeFrame).toEqual({ code: null, reason: "" });
  });

  test("a WebSocket client sees the close as 1005", async () => {
    const { port } = await setup({});
    const c = await v1Client(syncUrl(port));
    c.send({ type: "ModifyQuerySet", baseVersion: 7, newVersion: 8, modifications: [] });
    const e = await c.closed;
    expect(c.got.map((m) => m.type)).toEqual(["FatalError"]);
    expect(e.code).toBe(1005);
    expect(e.reason).toBe("");
  });

  test("an AuthError ends with a close without a code too", async () => {
    const { port } = await setup({});
    const c = await v1Client(syncUrl(port));
    c.send({ type: "Authenticate", baseVersion: 0, tokenType: "User", value: "not-a-jwt" });
    const e = await c.closed;
    expect(c.got.map((m) => m.type)).toEqual(["AuthError"]);
    expect(e.code).toBe(1005);
  });
});

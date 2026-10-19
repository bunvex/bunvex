import { describe, expect, test } from "bun:test";
import * as v1 from "../src/v1.ts";
import {
  decodeU64,
  encodeClientMessage,
  encodeServerMessage,
  encodeU64,
  ProtocolError,
  parseClientMessage,
  parseServerMessage,
} from "../src/v1.ts";

describe("sync protocol v1 codecs (STUDY-23)", () => {
  test("u64 timestamps are base64 of 8 little-endian bytes, as Convex's longToU64", () => {
    expect(encodeU64(1n)).toBe("AQAAAAAAAAA=");
    expect(encodeU64(0x0102030405060708n)).toBe(Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]).toString("base64"));
    for (const n of [0n, 1n, 255n, 2n ** 32n, 2n ** 53n + 1n, 2n ** 64n - 1n]) expect(decodeU64(encodeU64(n))).toBe(n);
    expect(() => encodeU64(-1n)).toThrow("not a u64");
    expect(() => decodeU64("AQ==")).toThrow("expected 8 bytes");
  });

  test("server messages encode the timestamps and keep Convex's field names", () => {
    const t = JSON.parse(
      encodeServerMessage({
        type: "Transition",
        startVersion: { querySet: 0, ts: 0n, identity: 0 },
        endVersion: { querySet: 1, ts: 5n, identity: 0 },
        modifications: [{ type: "QueryUpdated", queryId: 0, value: [1], logLines: [], journal: null }],
      }),
    );
    expect(t).toEqual({
      type: "Transition",
      startVersion: { querySet: 0, ts: "AAAAAAAAAAA=", identity: 0 },
      endVersion: { querySet: 1, ts: "BQAAAAAAAAA=", identity: 0 },
      modifications: [{ type: "QueryUpdated", queryId: 0, value: [1], logLines: [], journal: null }],
    });
    const ok = JSON.parse(
      encodeServerMessage({
        type: "MutationResponse",
        requestId: 3,
        success: true,
        result: null,
        ts: 9n,
        logLines: [],
      }),
    );
    expect(ok.ts).toBe(encodeU64(9n));
    const failed = JSON.parse(
      encodeServerMessage({ type: "MutationResponse", requestId: 3, success: false, result: "boom", logLines: [] }),
    );
    expect(failed).toEqual({ type: "MutationResponse", requestId: 3, success: false, result: "boom", logLines: [] });
    expect(encodeServerMessage({ type: "Ping" })).toBe('{"type":"Ping"}');
  });

  test("client frames round-trip through encode (client) and parse (server)", () => {
    const msgs = [
      {
        type: "Connect",
        sessionId: "s",
        connectionCount: 0,
        lastCloseReason: null,
        maxObservedTimestamp: 7n,
        clientTs: 1,
      },
      {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "messages:list", args: [{}], journal: null },
          { type: "Remove", queryId: 3 },
        ],
      },
      { type: "Mutation", requestId: 0, udfPath: "messages:send", args: [{ body: "hi" }] },
      { type: "Action", requestId: 1, udfPath: "a:b", args: [{}] },
      { type: "Authenticate", tokenType: "None", baseVersion: 0 },
      { type: "Event", eventType: "ClientConnect", event: { marks: [] } },
    ] as const;
    for (const m of msgs) expect(parseClientMessage(encodeClientMessage(m as never))).toEqual(m as never);
    // The client side parses what the server sends.
    const back = parseServerMessage(
      encodeServerMessage({ type: "MutationResponse", requestId: 1, success: true, result: 2, ts: 42n, logLines: [] }),
    );
    expect(back).toMatchObject({ ts: 42n, result: 2 });
  });

  test("malformed client frames are protocol errors", () => {
    const bad = [
      "not json",
      "[]",
      '{"type":"Nope"}',
      '{"type":"Mutation","requestId":-1,"udfPath":"a:b","args":[]}',
      '{"type":"Mutation","requestId":1,"udfPath":"a:b","args":{}}',
      '{"type":"ModifyQuerySet","baseVersion":0,"newVersion":1,"modifications":[{"type":"Change"}]}',
      '{"type":"Authenticate","tokenType":"Magic","baseVersion":0}',
      '{"type":"Connect","sessionId":1,"connectionCount":0}',
    ];
    for (const f of bad) expect(() => parseClientMessage(f)).toThrow(ProtocolError);
  });
});

describe("room messages (AD-42, STUDY-164 §3.6)", () => {
  test("RoomJoin, RoomLeave, RoomPresence and RoomEvent parse", () => {
    expect(
      v1.parseClientMessage(
        JSON.stringify({ type: "RoomJoin", roomId: 1, kind: "room", name: "rooms:doc", args: { docId: "x" } }),
      ),
    ).toEqual({ type: "RoomJoin", roomId: 1, kind: "room", name: "rooms:doc", args: { docId: "x" } });
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomLeave", roomId: 1 }))).toEqual({
      type: "RoomLeave",
      roomId: 1,
    });
    expect(
      v1.parseClientMessage(JSON.stringify({ type: "RoomPresence", roomId: 2, presence: { x: 1 }, idle: true })),
    ).toEqual({ type: "RoomPresence", roomId: 2, presence: { x: 1 }, idle: true });
    expect(v1.parseClientMessage(JSON.stringify({ type: "RoomEvent", roomId: 2, event: "wave", data: null }))).toEqual({
      type: "RoomEvent",
      roomId: 2,
      event: "wave",
      data: null,
    });
  });
  test("a bad room message is a ProtocolError", () => {
    for (const m of [
      { type: "RoomJoin", roomId: 1, kind: "lobby", name: "a:b", args: {} },
      { type: "RoomJoin", roomId: -1, kind: "room", name: "a:b", args: {} },
      { type: "RoomJoin", roomId: 1, kind: "room", args: {} },
      { type: "RoomPresence", roomId: 1 },
      { type: "RoomEvent", roomId: 1, event: 3, data: 1 },
    ])
      expect(() => v1.parseClientMessage(JSON.stringify(m))).toThrow(v1.ProtocolError);
  });
  test("server room frames encode and parse back unchanged", () => {
    const frames: v1.ServerMessage[] = [
      {
        type: "RoomSync",
        roomId: 1,
        self: "m1",
        canPublish: true,
        members: [{ memberId: "m2", userId: "u2", presence: { x: 1 } }],
      },
      { type: "RoomMembers", roomId: 1, set: [], left: ["m2"] },
      { type: "RoomEvent", roomId: 1, from: null, event: "wave", data: { emoji: "👋" } },
      { type: "RoomError", roomId: 1, code: "no_access", message: "You cannot join this room." },
      { type: "RoomLeft", roomId: 1, code: "no_access", message: "You cannot join this room." },
      { type: "RoomLeft", roomId: 2, code: "limit", message: "This room is full." },
      { type: "RoomLeft", roomId: 3, code: "removed", message: "Removed from the dashboard." },
    ];
    for (const f of frames) expect(v1.parseServerMessage(v1.encodeServerMessage(f))).toEqual(f);
  });
});

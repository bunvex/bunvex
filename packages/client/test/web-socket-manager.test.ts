// The socket manager on its own (Convex's `sync/web_socket_manager.ts` behaviour): TransitionChunk
// reassembly and its refusals, the close paths and their backoff, a failed send, pause/resume while
// connecting and ready, stop/restart, terminate while connecting, and the browser's `online` event.
import { afterEach, expect, test } from "bun:test";
import { v1 } from "@bunvex/protocol";
import type { Logger } from "../src/logging.ts";
import { type ReconnectMetadata, WebSocketManager } from "../src/web-socket-manager.ts";

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: v1.ClientMessage[] = [];
  closed = false;
  opened = false;
  failSend = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(frame: string) {
    if (this.failSend) throw new Error("socket is gone");
    this.sent.push(v1.parseClientMessage(frame));
  }
  close() {
    this.closed = true;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open() {
    this.opened = true;
    this.onopen?.();
  }
  receive(m: v1.ServerMessage) {
    this.onmessage?.({ data: v1.encodeServerMessage(m) });
  }
}
const last = () => FakeSocket.all.at(-1)!;

function setup(options = {}) {
  const lines: string[] = [];
  const logger: Logger = {
    logVerbose: (...a) => lines.push(a.join(" ")),
    log: (...a) => lines.push(a.join(" ")),
    warn: () => {},
    error: () => {},
  };
  const opened: ReconnectMetadata[] = [];
  const received: v1.ServerMessage[] = [];
  const disconnects: string[] = [];
  let resumed = 0;
  const m = new WebSocketManager(
    "ws://t/sync",
    {
      onOpen: (meta) => opened.push(meta),
      onResume: () => resumed++,
      onMessage: (msg) => {
        received.push(msg);
        return { hasSyncedPastLastReconnect: true };
      },
      onServerDisconnectError: (msg) => disconnects.push(msg),
    },
    FakeSocket as unknown as typeof WebSocket,
    logger,
    () => {},
    { defaultInitialBackoffMs: 1, maxBackoffMs: 4, ...options },
  );
  managers.push(m);
  return { m, lines, opened, received, disconnects, resumed: () => resumed };
}
const managers: WebSocketManager[] = [];
/** Terminate; a socket still connecting is closed once it opens, so open the ones that never did. */
const terminate = (m: WebSocketManager) => {
  const done = m.terminate();
  for (const ws of FakeSocket.all) if (!ws.opened && !ws.closed) ws.open();
  return done;
};
afterEach(async () => {
  for (const m of managers.splice(0)) await terminate(m);
  FakeSocket.all = [];
});

const transition: v1.Transition = {
  type: "Transition",
  startVersion: { querySet: 0, ts: 0n, identity: 0 },
  endVersion: { querySet: 1, ts: 5n, identity: 0 },
  modifications: [],
};
const chunksOf = (t: v1.Transition, parts: number, transitionId = "t1"): v1.TransitionChunk[] => {
  const json = v1.encodeServerMessage(t);
  const size = Math.ceil(json.length / parts);
  return Array.from({ length: parts }, (_, i) => ({
    type: "TransitionChunk",
    chunk: json.slice(i * size, (i + 1) * size),
    partNumber: i,
    totalParts: parts,
    transitionId,
  }));
};
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(2);
  expect(cond()).toBe(true);
};

test("chunks reassemble into one Transition; a Ping alone delivers nothing", () => {
  const s = setup();
  last().open();
  const parts = chunksOf(transition, 3);
  last().receive(parts[0]!);
  last().receive({ type: "Ping" });
  last().receive(parts[1]!);
  expect(s.received).toEqual([]);
  last().receive(parts[2]!);
  expect(s.received).toEqual([transition]);
});

test("bad chunks are refused and the buffer is dropped", () => {
  setup();
  const ws = last();
  ws.open();
  const parts = chunksOf(transition, 3);
  expect(() => ws.receive({ ...parts[0]!, partNumber: 3 })).toThrow("Invalid TransitionChunk");
  expect(() => ws.receive({ ...parts[0]!, totalParts: 0, partNumber: 0 })).toThrow("Invalid TransitionChunk");
  expect(() => ws.receive({ ...parts[0]!, partNumber: -1 })).toThrow("Invalid TransitionChunk");
  ws.receive(parts[0]!);
  // A part of another transition, or another total, while one is buffered.
  expect(() => ws.receive({ ...parts[1]!, transitionId: "other" })).toThrow("Invalid TransitionChunk");
  ws.receive(parts[0]!);
  expect(() => ws.receive({ ...parts[1]!, totalParts: 4 })).toThrow("Invalid TransitionChunk");
  // Out of order.
  expect(() => ws.receive(parts[1]!)).toThrow("TransitionChunk received out of order: expected part 0, got 1");
  // Chunks that assemble into something other than a Transition.
  const ping = JSON.stringify({ type: "Ping" });
  expect(() =>
    ws.receive({ type: "TransitionChunk", chunk: ping, partNumber: 0, totalParts: 1, transitionId: "p" }),
  ).toThrow("Expected Transition, got Ping after assembling chunks");
});

test("another message while chunks are buffered drops them, with a log line", () => {
  const s = setup();
  last().open();
  last().receive(chunksOf(transition, 2)[0]!);
  last().receive(transition);
  expect(s.lines.some((l) => l.includes("Received unexpected Transition while buffering TransitionChunks"))).toBe(true);
  // The dropped buffer does not poison the next chunked transition.
  for (const p of chunksOf(transition, 2, "t2")) last().receive(p);
  expect(s.received).toEqual([transition, transition]);
});

test("an error event is logged; a server close with a reason reports it and reconnects", async () => {
  const s = setup();
  const first = last();
  first.open();
  first.onerror?.({ message: "boom" });
  first.onerror?.({});
  expect(s.lines.filter((l) => l.startsWith("WebSocket error message")).length).toBe(1);
  first.onclose?.({ code: 1011, reason: "InternalServerError: oops" });
  expect(s.disconnects).toEqual(["WebSocket closed with code 1011: InternalServerError: oops"]);
  expect(s.m.socketState()).toBe("disconnected");
  await waitFor(() => FakeSocket.all.length === 2);
  last().open();
  expect(s.opened.at(-1)).toMatchObject({ connectionCount: 1, lastCloseReason: "InternalServerError: oops" });
  // A close with no reason: no report, the code is the close reason.
  last().onclose?.({ code: 1006, reason: "" });
  expect(s.disconnects.length).toBe(1);
  await waitFor(() => FakeSocket.all.length === 3);
  last().open();
  expect(s.opened.at(-1)!.lastCloseReason).toBe("closed with code 1006");
});

test("a failed send closes the socket and reconnects soon", async () => {
  const s = setup();
  const first = last();
  first.open();
  first.failSend = true;
  expect(s.m.sendMessage({ type: "Event", eventType: "x", event: null } as never)).toBe(true);
  expect(first.closed).toBe(true);
  expect(s.lines.some((l) => l.startsWith("Failed to send message on WebSocket"))).toBe(true);
  await waitFor(() => FakeSocket.all.length === 2);
  last().open();
  expect(s.opened.at(-1)!.lastCloseReason).toBe("FailedToSendMessage");
});

test("nothing received for the threshold reconnects (InactiveServer), also while connecting", async () => {
  const s = setup({ serverInactivityThresholdMs: 5 });
  const connecting = last();
  // Closing a socket that never opened waits for it to open, then closes it.
  await waitFor(() => FakeSocket.all.length >= 2);
  connecting.open();
  expect(connecting.closed).toBe(true);
  const ws = last();
  ws.open();
  await waitFor(() => FakeSocket.all.length >= 3);
  last().open();
  expect(s.opened.at(-1)!.lastCloseReason).toBe("InactiveServer");
});

test("pause and resume: not sent while paused; resumed when ready; opened late if paused while connecting", () => {
  const s = setup();
  const msg = { type: "Event", eventType: "x", event: null } as never;
  s.m.pause();
  last().open();
  expect(s.opened).toEqual([]); // paused while connecting: onOpen waits for resume
  expect(s.m.sendMessage(msg)).toBe(false);
  s.m.resume();
  expect(s.opened.length).toBe(1);
  expect(s.m.connectionState().hasEverConnected).toBe(true);
  s.m.pause();
  expect(s.m.sendMessage(msg)).toBe(false);
  s.m.resume();
  expect(s.resumed()).toBe(1);
  expect(s.m.sendMessage(msg)).toBe(true);
  s.m.resume(); // not paused: nothing happens
  expect(s.resumed()).toBe(1);
});

test("pause then resume while connecting opens normally", () => {
  const s = setup();
  s.m.pause();
  s.m.resume();
  last().open();
  expect(s.opened.length).toBe(1);
});

test("stop and restart; restart without stop is ignored; nothing restarts a terminated manager", async () => {
  const s = setup();
  last().open();
  await s.m.stop();
  expect(s.m.socketState()).toBe("stopped");
  s.m.tryRestart();
  expect(FakeSocket.all.length).toBe(2);
  s.m.tryRestart();
  expect(s.lines).toContain("Restart called without stopping first");
  expect(FakeSocket.all.length).toBe(2);
  await terminate(s.m);
  expect(last().closed).toBe(true); // terminated while connecting: closed as soon as it opened
  await s.m.stop();
  expect(s.m.socketState()).toBe("terminated");
});

test("the browser's online event reconnects at once, cancelling the scheduled backoff", async () => {
  const handlers = new Map<string, () => void>();
  (globalThis as { window?: unknown }).window = {
    addEventListener: (t: string, fn: () => void) => handlers.set(t, fn),
    removeEventListener: (t: string) => handlers.delete(t),
  };
  try {
    const s = setup({ defaultInitialBackoffMs: 20, maxBackoffMs: 20 });
    last().open();
    last().onclose?.({ code: 1006, reason: "" });
    expect(FakeSocket.all.length).toBe(1); // scheduled, 10-30 ms away
    handlers.get("online")!();
    expect(FakeSocket.all.length).toBe(2);
    expect(s.lines).toContain("Network recovery detected, reconnecting immediately");
    handlers.get("online")!(); // already connecting: no second socket
    await Bun.sleep(60); // the cancelled backoff never fires
    expect(FakeSocket.all.length).toBe(2);
    expect(s.m.socketState()).toBe("connecting");
    await terminate(s.m);
    expect(handlers.has("online")).toBe(false);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

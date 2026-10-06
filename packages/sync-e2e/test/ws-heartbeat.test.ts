// The WS heartbeat end to end (STUDY-104), with the timings shortened: a peer on a raw socket that never
// answers the server's pings is closed with 1000 `ClientDisconnected`, as Convex's "Websocket ping/pong
// timeout"; the official client, which answers them, stays connected across many intervals and keeps working.
import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { startServer, until } from "./harness.ts";

const PING_MS = 25;
const TIMEOUT_MS = 250;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A WebSocket upgrade on a bare TCP socket that never writes again: what frames come, and the close frame. */
function silentPeer(port: number) {
  const opcodes: number[] = [];
  let close: { code: number | null; reason: string } | null = null;
  let buf = Buffer.alloc(0);
  let upgraded = false;
  const socket = net.connect(port, "127.0.0.1", () =>
    socket.write(
      "GET /api/1.0.0/sync HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    ),
  );
  const closed = new Promise<void>((r) => socket.on("close", () => r()));
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgraded = true;
      buf = buf.subarray(end + 4);
    }
    // Server frames are unmasked; the ones here (pings, a close) are all short.
    while (buf.length >= 2 && buf.length >= 2 + (buf[1]! & 0x7f)) {
      const op = buf[0]! & 0x0f;
      const payload = buf.subarray(2, 2 + (buf[1]! & 0x7f));
      buf = buf.subarray(2 + payload.length);
      opcodes.push(op);
      if (op === 0x8)
        close =
          payload.length >= 2
            ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") }
            : { code: null, reason: "" };
    }
  });
  cleanup.push(() => socket.destroy());
  return { opcodes, closed, close: () => close };
}

test("a peer that never answers the server's pings is closed with 1000 ClientDisconnected", async () => {
  const h = await startServer({ wsHeartbeat: { pingIntervalMs: PING_MS, clientTimeoutMs: TIMEOUT_MS } });
  cleanup.push(h.stop);
  const peer = silentPeer(Number(new URL(h.url).port));
  const t0 = performance.now();
  await peer.closed;
  expect(performance.now() - t0).toBeGreaterThanOrEqual(TIMEOUT_MS - 5);
  expect(peer.close()).toEqual({ code: 1000, reason: "ClientDisconnected" });
  // Pings (0x9) on the interval, then the close (0x8); no text frame (no FatalError).
  expect(peer.opcodes.filter((op) => op === 0x9).length).toBeGreaterThanOrEqual(5);
  expect(peer.opcodes.filter((op) => op !== 0x9)).toEqual([0x8]);
});

test("the official client stays connected across many intervals, and its subscription keeps updating", async () => {
  const h = await startServer({ wsHeartbeat: { pingIntervalMs: PING_MS, clientTimeoutMs: TIMEOUT_MS } });
  cleanup.push(h.stop);
  const c = new ConvexClient(h.url, { skipConvexDeploymentUrlCheck: true });
  cleanup.push(() => c.close());
  const seen: unknown[] = [];
  c.onUpdate(anyApi.messages!.list!, {}, (v) => seen.push(v));
  await until(() => seen.length === 1, "first result");
  const reconnects = () => c.connectionState().connectionRetries;
  // Idle for many timeouts: only the client's pongs show it is alive.
  await Bun.sleep(TIMEOUT_MS * 5);
  expect(c.connectionState().isWebSocketConnected).toBe(true);
  expect(reconnects()).toBe(0);
  expect(c.connectionState().connectionCount).toBe(1);
  await c.mutation(anyApi.messages!.send!, { body: "still here" });
  await until(() => seen.length === 2, "update");
  expect(seen).toEqual([[], ["still here"]]);
});

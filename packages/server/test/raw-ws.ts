// A WebSocket client on a raw TCP socket, for tests that need a client that stops reading: it can pause the
// socket, so the server's frames pile up in the kernel and then in Bun's send buffer (STUDY-64 §1.3). It never
// answers a ping by itself, and it records the server's pings and close frame (STUDY-104).
import net from "node:net";
import { v1 } from "@bunvex/protocol";

export type RawWs = {
  /** Text frames received, parsed, in order. */
  got: v1.ServerMessage[];
  send(m: v1.ClientMessage): void;
  /** Stop reading: the kernel's buffers fill, then the server's. */
  pause(): void;
  resume(): void;
  closed: Promise<void>;
  end(): void;
  /** When each WS ping arrived (`performance.now()`), and each pong. */
  pings: number[];
  pongs: number[];
  /** The server's close frame: its code (null: the frame had none) and reason, once it came. */
  closeFrame: { code: number | null; reason: string } | null;
  /** Send a control frame: a ping, or a pong (which a server takes even unasked, RFC 6455 §5.5.3). */
  ping(): void;
  pong(): void;
};

/** A masked client frame (RFC 6455 §5.2), text unless `op` says otherwise. */
function frame(text: string, op = 0x1): Buffer {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : Buffer.alloc(n < 65536 ? 4 : 10);
  if (n >= 126 && n < 65536) {
    head[0] = 0x81;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else if (n >= 65536) {
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  // A zero mask key leaves the payload as it is.
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}

export function rawWs(port: number, path = "/api/1.0.0/sync"): Promise<RawWs> {
  return new Promise((resolve, reject) => {
    const got: v1.ServerMessage[] = [];
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let fragments: Buffer[] = [];
    let closedResolve!: () => void;
    const closed = new Promise<void>((r) => (closedResolve = r));
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("error", reject);
    socket.on("close", () => closedResolve());
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve(ws);
      }
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0]! & 0x80) !== 0;
        const op = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          at = 10;
        }
        if (buf.length < at + len) return;
        const payload = buf.subarray(at, at + len);
        buf = buf.subarray(at + len);
        if (op === 0x9) ws.pings.push(performance.now());
        if (op === 0xa) ws.pongs.push(performance.now());
        if (op === 0x8) {
          ws.closeFrame =
            payload.length >= 2
              ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString("utf8") }
              : { code: null, reason: "" };
          socket.end();
          return;
        }
        if (op === 0x1 || op === 0x0) {
          fragments.push(Buffer.from(payload));
          if (fin) {
            got.push(v1.parseServerMessage(Buffer.concat(fragments).toString("utf8")));
            fragments = [];
          }
        }
      }
    });
    const ws: RawWs = {
      got,
      send: (m) => socket.write(frame(v1.encodeClientMessage(m))),
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      closed,
      end: () => socket.destroy(),
      pings: [],
      pongs: [],
      closeFrame: null,
      ping: () => socket.write(frame("", 0x9)),
      pong: () => socket.write(frame("", 0xa)),
    };
  });
}

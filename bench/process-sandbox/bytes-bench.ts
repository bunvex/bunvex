// STUDY-168: the cost of bytes over the bridge (`ctx.storage.get`, `store`, an HTTP action's body, `fetch`): the
// host sends `size` bytes to the child, which answers with a small ack.
//   - "ipc json": Bun's IPC channel with JSON, the bytes base64-encoded as the prototype's wire.ts tags them;
//   - "unix socket frames": length-prefixed `bun:jsc` frames, the bytes as an ArrayBuffer (no base64).
//   bun bench/process-sandbox/bytes-bench.ts            -> one JSON line per transport and size (µs, MiB/s)
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, frame } from "./framing.ts";
import { decode, encode } from "./wire.ts";

const SIZES = [1 << 10, 64 << 10, 1 << 20, 8 << 20];
const ITER = (size: number) => (size >= 1 << 20 ? 30 : 300);

if (process.env.MODE === "ipc") {
  process.on("message", (m) => {
    const v = decode((m as { value: never }).value) as ArrayBuffer;
    process.send?.({ t: "ack", n: v.byteLength });
  });
  process.send?.({ t: "ready" });
} else if (process.env.MODE === "socket") {
  const { connect } = await import("node:net");
  const sock = connect(process.env.SOCK as string);
  sock.setNoDelay(true);
  const reader = new FrameReader((m) =>
    sock.write(frame({ t: "ack", n: (m as { value: ArrayBuffer }).value.byteLength })),
  );
  sock.on("data", (d) => reader.push(d as Uint8Array));
} else {
  const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
  async function measure(transport: string, size: number, rt: (b: ArrayBuffer) => Promise<unknown>) {
    const buf = new Uint8Array(size).map((_, i) => i & 0xff).buffer;
    for (let i = 0; i < 5; i++) await rt(buf);
    const s: number[] = [];
    for (let i = 0; i < ITER(size); i++) {
      const t = performance.now();
      await rt(buf);
      s.push((performance.now() - t) * 1000);
    }
    s.sort((a, b) => a - b);
    const p50 = s[Math.floor(s.length / 2)] as number;
    line({
      transport,
      sizeKiB: size / 1024,
      p50Us: +p50.toFixed(1),
      mibPerSec: +(size / 2 ** 20 / (p50 / 1e6)).toFixed(1),
    });
  }
  // Bun IPC, JSON (base64 in the tagged value)
  {
    let resolve: (v: unknown) => void = () => {};
    const child = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, MODE: "ipc" },
      ipc: (m) => resolve(m),
      serialization: "json",
      stdio: ["ignore", "inherit", "inherit"],
    });
    await new Promise((r) => {
      resolve = r;
    });
    for (const size of SIZES)
      await measure("ipc json (base64)", size, (b) => {
        const p = new Promise((r) => {
          resolve = r;
        });
        child.send({ t: "result", value: encode(b) });
        return p;
      });
    child.kill();
    await child.exited;
  }
  // Unix socket, jsc frames
  {
    const path = join(tmpdir(), `bunvex-study-bytes-${process.pid}.sock`);
    let resolve: (v: unknown) => void = () => {};
    const reader = new FrameReader((m) => resolve(m));
    const connected = Promise.withResolvers<Socket>();
    const server = createServer((s) => {
      s.setNoDelay(true);
      s.on("data", (d) => reader.push(d as Uint8Array));
      connected.resolve(s);
    }).listen(path);
    const child = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...process.env, MODE: "socket", SOCK: path },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const sock = await connected.promise;
    for (const size of SIZES)
      await measure("unix socket frames (binary)", size, (b) => {
        const p = new Promise((r) => {
          resolve = r;
        });
        sock.write(frame({ t: "result", value: b }));
        return p;
      });
    child.kill();
    await child.exited;
    server.close();
  }
}

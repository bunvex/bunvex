// STUDY-168: a container per tenant as the boundary. The child runs in its own `docker run` (Docker's default
// seccomp and AppArmor, no network, read-only root, its own memory and pid limits, a non-root uid) and talks to the
// host over a Unix socket in a shared directory: Bun's IPC channel (an inherited fd) cannot cross `docker run`.
// Measures the cold start (spawn to connected) and one small round trip, against the same child as a plain process.
//   bun bench/process-sandbox/container-rtt.ts [image] [iterations]   (Linux, Docker; the image needs no bwrap)
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { FrameReader, frame } from "./framing.ts";

const IMAGE = process.argv[2] ?? "sbstudy";
const N = Number(process.argv[3] ?? 20_000);
const STARTS = 5;
const op = { t: "op", call: 1, op: 7, kind: "get", id: "jd7a2k4n9g8w3v5e6r1t0y2u3i4o5p6a" };
const dir = mkdtempSync("/tmp/bunvex-study-ctr-");
chmodSync(dir, 0o777);

const pct = (s: number[], q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
const line = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

async function run(label: string, cmd: (sock: string) => string[]) {
  const starts: number[] = [];
  for (let i = 0; i < STARTS; i++) {
    const path = join(dir, `${label}-${i}.sock`);
    let resolve: (v: unknown) => void = () => {};
    const reader = new FrameReader((m) => resolve(m));
    const connected = Promise.withResolvers<Socket>();
    const server = createServer((s) => {
      s.setNoDelay(true);
      s.on("data", (d) => reader.push(d as Uint8Array));
      connected.resolve(s);
    }).listen(path);
    await new Promise((r) => server.once("listening", r));
    chmodSync(path, 0o777);
    const t0 = performance.now();
    const child = Bun.spawn(cmd(path), { stdio: ["ignore", "inherit", "inherit"] });
    const sock = await connected.promise;
    starts.push(performance.now() - t0);
    if (i === STARTS - 1) {
      const rt = () => {
        const p = new Promise((r) => {
          resolve = r;
        });
        sock.write(frame(op));
        return p;
      };
      for (let k = 0; k < 2000; k++) await rt();
      const samples: number[] = [];
      for (let k = 0; k < N; k++) {
        const t = performance.now();
        await rt();
        samples.push((performance.now() - t) * 1000);
      }
      samples.sort((a, b) => a - b);
      line({
        transport: label,
        n: N,
        meanUs: +(samples.reduce((a, b) => a + b, 0) / N).toFixed(2),
        p50Us: +pct(samples, 0.5).toFixed(2),
        p99Us: +pct(samples, 0.99).toFixed(2),
        startMs: starts.map((x) => +x.toFixed(1)),
      });
    }
    // The echo exits when the socket closes, which also stops its container (killing `docker run` would not).
    sock.destroy();
    await Promise.race([child.exited, Bun.sleep(10_000)]);
    child.kill("SIGKILL");
    await child.exited;
    server.close();
  }
}

const echo = join(import.meta.dir, "transport-echo.ts");
await run("process unix socket", (sock) => ["/usr/bin/env", "MODE=socket", `SOCK=${sock}`, process.execPath, echo]);
await run("container per tenant, unix socket", (sock) => [
  "docker",
  "run",
  "--rm",
  "--network",
  "none",
  "--read-only",
  "--memory",
  "128m",
  "--memory-swap",
  "128m",
  "--pids-limit",
  "64",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--user",
  "65534:65534",
  "-e",
  "MODE=socket",
  "-e",
  `SOCK=/s/${sock.slice(dir.length + 1)}`,
  "-v",
  `${dir}:/s`,
  "-v",
  `${process.execPath}:/bun:ro`,
  "-v",
  `${import.meta.dir}:/runner:ro`,
  IMAGE,
  "/bun",
  "/runner/transport-echo.ts",
]);
rmSync(dir, { recursive: true, force: true });

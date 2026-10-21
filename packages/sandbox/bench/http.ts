// HTTP actions, `vm` against `process` (STUDY-168 PR 6, STUDY-171 §14.9): each executor's server in a process of its
// own (`http-server.ts`), requested over HTTP by this one, one request at a time.
//
// - **Latency**: an empty HTTP action (`new Response(null)`), and one answering "ok".
// - **Throughput**: 1 MiB and 64 MiB request bodies (read whole, and as a stream) and response bodies (bytes of known
//   length, and a stream made a MiB at a time as it is read); MiB/s from the p50.
// - **Backpressure**: a 96 MiB streamed response read by a slow client (`SLOW_MIBS` MiB/s), the server's and its
//   child's resident memory sampled every 50 ms: what each holds above its idle size, against the same body read fast.
//
//   bun packages/sandbox/bench/http.ts [requests=1000] [warmup=100] [only=<part of a line's name>] [--json]
//     [--vm | --process]
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const JSON_OUT = process.argv.includes("--json");
const REQUESTS = Number(args[0] ?? 1000);
const WARMUP = Number(args[1] ?? 100);
const ONLY = args[2];
const EXECUTORS = process.argv.includes("--vm")
  ? (["vm"] as const)
  : process.argv.includes("--process")
    ? (["process"] as const)
    : (["vm", "process"] as const);
const MiB = 1024 * 1024;
const SLOW_MIBS = 8;
const SLOW_BYTES = 96 * MiB;

const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.trim();
}

/** A process's resident memory (Linux `/proc`), in MiB; NaN elsewhere. */
async function rssMiB(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const kb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
    return kb / 1024;
  } catch {
    return Number.NaN;
  }
}

/** The server's child processes (its sandbox's), by `/proc`. */
async function childrenOf(pid: number): Promise<number[]> {
  const p = Bun.spawn(["ps", "-o", "pid=", "--ppid", String(pid)], { stdout: "pipe" });
  return (await new Response(p.stdout).text())
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => n > 0);
}

type Line = {
  name: string;
  requests: (n: number) => number;
  bytes?: number;
  run: (site: string) => Promise<unknown>;
};

const body = (n: number) => new Uint8Array(n).fill(3);
const uploads: Record<number, Uint8Array> = { [MiB]: body(MiB), [64 * MiB]: body(64 * MiB) };
const drain = async (r: Response) => {
  let n = 0;
  for await (const c of r.body!) n += c.byteLength;
  return n;
};

const LINES: Line[] = [
  { name: "empty HTTP action", requests: (n) => n, run: async (s) => (await fetch(`${s}/empty`)).arrayBuffer() },
  { name: 'HTTP action, "ok"', requests: (n) => n, run: async (s) => (await fetch(`${s}/ok`)).text() },
  ...[1, 64].flatMap((m): Line[] => [
    {
      name: `request body, ${m} MiB, read whole`,
      requests: (n) => (m === 1 ? Math.ceil(n / 5) : 20),
      bytes: m * MiB,
      run: async (s) => (await fetch(`${s}/upload`, { method: "POST", body: uploads[m * MiB] })).text(),
    },
    {
      name: `request body, ${m} MiB, streamed`,
      requests: (n) => (m === 1 ? Math.ceil(n / 5) : 20),
      bytes: m * MiB,
      run: async (s) => (await fetch(`${s}/uploadStream`, { method: "POST", body: uploads[m * MiB] })).text(),
    },
    {
      name: `response body, ${m} MiB, bytes`,
      requests: (n) => (m === 1 ? Math.ceil(n / 5) : 20),
      bytes: m * MiB,
      run: async (s) => drain(await fetch(`${s}/bytes/${m * MiB}`)),
    },
    {
      name: `response body, ${m} MiB, streamed`,
      requests: (n) => (m === 1 ? Math.ceil(n / 5) : 20),
      bytes: m * MiB,
      run: async (s) => drain(await fetch(`${s}/stream/${m * MiB}`)),
    },
  ]),
];

/** A 96 MiB stream read at `mibs` MiB/s (or as fast as it comes): the memory each process holds meanwhile. */
async function backpressure(site: string, pids: { server: number; child: number | null }, mibs: number | null) {
  const idle = { server: await rssMiB(pids.server), child: pids.child ? await rssMiB(pids.child) : Number.NaN };
  const peak = { ...idle };
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak.server = Math.max(peak.server, await rssMiB(pids.server));
      if (pids.child) peak.child = Math.max(peak.child, await rssMiB(pids.child));
      await Bun.sleep(50);
    }
  })();
  const t0 = performance.now();
  const r = await fetch(`${site}/stream/${SLOW_BYTES}`);
  let n = 0;
  for await (const c of r.body!) {
    n += c.byteLength;
    // Read no faster than `mibs`: wait until the bytes read so far are due.
    if (mibs !== null) {
      const due = (n / MiB / mibs) * 1000 - (performance.now() - t0);
      if (due > 0) await Bun.sleep(due);
    }
  }
  const ms = performance.now() - t0;
  sampling = false;
  await sampler;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    read: mibs === null ? "fast" : `${mibs} MiB/s`,
    bytes: n,
    seconds: r1(ms / 1000),
    mibs: r1(n / MiB / (ms / 1000)),
    server: { idle: r1(idle.server), peak: r1(peak.server), above: r1(peak.server - idle.server) },
    child: { idle: r1(idle.child), peak: r1(peak.child), above: r1(peak.child - idle.child) },
  };
}

const out: Record<string, Record<string, unknown>> = {};
for (const executor of EXECUTORS) {
  const server = Bun.spawn([process.execPath, `${import.meta.dir}/http-server.ts`, executor], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const { port, pid } = JSON.parse(await firstLine(server.stdout)) as { port: number; pid: number };
    const site = `http://127.0.0.1:${port}`;
    for (const line of LINES) {
      if (ONLY && !line.name.includes(ONLY)) continue;
      const n = line.requests(REQUESTS);
      const warm = Math.min(WARMUP, Math.max(2, Math.ceil(n / 5)));
      for (let i = 0; i < warm; i++) await line.run(site);
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await line.run(site);
        times.push((performance.now() - t) * 1000);
      }
      const p50 = q(times, 0.5);
      const row: Record<string, unknown> = {
        p50: Math.round(p50),
        mean: Math.round(times.reduce((a, b) => a + b, 0) / n),
        p99: Math.round(q(times, 0.99)),
        n,
      };
      if (line.bytes) row.mibs = Math.round(line.bytes / MiB / (p50 / 1e6));
      out[line.name] ??= {};
      out[line.name]![executor] = row;
      if (!JSON_OUT) console.log(executor.padEnd(8), line.name.padEnd(36), JSON.stringify(row));
    }
    if (!ONLY || "backpressure".includes(ONLY)) {
      const child = (await childrenOf(pid))[0] ?? null;
      for (const mibs of [null, SLOW_MIBS]) {
        const row = await backpressure(site, { server: pid, child: executor === "process" ? child : null }, mibs);
        const name = `backpressure, 96 MiB stream, read ${row.read}`;
        out[name] ??= {};
        out[name]![executor] = row;
        if (!JSON_OUT) console.log(executor.padEnd(8), name.padEnd(36), JSON.stringify(row));
      }
    }
  } finally {
    server.kill("SIGKILL");
    await server.exited;
  }
}
if (JSON_OUT) console.log(JSON.stringify(out, null, 2));

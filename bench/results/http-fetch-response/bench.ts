// A fetched response in an HTTP action under `vm` (read whole, read as a stream, returned as it came): `server.ts` in a
// process of its own, requested over HTTP by this one, one request at a time; p50 / mean / p99 in µs per line.
//
//   bun bench/results/http-fetch-response/bench.ts [requests=2000] [warmup=200]
const REQUESTS = Number(process.argv[2] ?? 2000);
const WARMUP = Number(process.argv[3] ?? 200);
const LINES: [string, string][] = [
  ["fetch, 1 KiB read whole (arrayBuffer)", "/text"],
  ["fetch, 1 KiB read from its body stream", "/body"],
  ["fetch returned as it came (a proxy; 500 on main)", "/proxy"],
];
const server = Bun.spawn(["bun", `${import.meta.dir}/server.ts`], { stdout: "pipe", stderr: "inherit" });
const reader = server.stdout.getReader();
let text = "";
while (!text.includes("\n")) {
  const { value, done } = await reader.read();
  if (done) throw new Error("the server exited");
  text += new TextDecoder().decode(value);
}
const { port } = JSON.parse(text.trim()) as { port: number };
const q = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
try {
  for (const [name, path] of LINES) {
    const url = `http://127.0.0.1:${port}/http${path}`;
    for (let i = 0; i < WARMUP; i++) await (await fetch(url)).arrayBuffer();
    const t: number[] = [];
    for (let i = 0; i < REQUESTS; i++) {
      const t0 = performance.now();
      const r = await fetch(url);
      await r.arrayBuffer();
      if (r.status !== 200) {
        console.log(JSON.stringify({ name, status: r.status }));
        break;
      }
      t.push((performance.now() - t0) * 1000);
    }
    if (t.length < REQUESTS) continue;
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    console.log(
      JSON.stringify({ name, p50: Math.round(q(t, 0.5)), mean: Math.round(mean), p99: Math.round(q(t, 0.99)) }),
    );
  }
} finally {
  server.kill();
  await server.exited;
}

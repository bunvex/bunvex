// bench/cloud: runs on the load box, started by cloud.ts. One k6 per server port, all at once, against TARGET
// (the server box's private address), then one JSON line with each port's rate, error rate and latency.
// Env: TARGET, PORTS (comma-separated), SCENARIO (cached), VUS (32 per server), DURATION (30s).
const target = process.env.TARGET;
const ports = (process.env.PORTS ?? "").split(",").filter(Boolean);
if (!target || ports.length === 0) throw new Error("TARGET and PORTS are required");
const scenario = process.env.SCENARIO ?? "cached";
const vus = process.env.VUS ?? "32";
const duration = process.env.DURATION ?? "30s";
const out = `/tmp/bench-k6-${process.pid}`;

const runs = ports.map(async (port) => {
  const summary = `${out}-${port}.json`;
  const proc = Bun.spawn(
    ["k6", "run", "-q", "--summary-trend-stats", "med,p(90),p(99),max", "--summary-export", summary].concat([
      "-e",
      `SCENARIO=${scenario}`,
      "-e",
      `VUS=${vus}`,
      "-e",
      `DURATION=${duration}`,
      "-e",
      `BENCH_URL=http://${target}:${port}`,
      `${import.meta.dir}/../load/k6.js`,
    ]),
    { stdout: "ignore", stderr: "pipe" },
  );
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`k6 on ${port} exited with ${code}: ${err.slice(-2000)}`);
  const m = (await Bun.file(summary).json()).metrics;
  const latency = m.http_req_duration;
  return {
    port: Number(port),
    rate: m.http_reqs.rate as number,
    errors: m.bench_errors.value as number,
    p50: latency.med as number,
    p90: latency["p(90)"] as number,
    p99: latency["p(99)"] as number,
    max: latency.max as number,
  };
});
console.log(JSON.stringify(await Promise.all(runs)));

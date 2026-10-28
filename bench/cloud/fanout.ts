// bench/cloud: WebSocket fan-out with each product's own client, run on the load box. N clients (`BunvexClient`
// from bunvex/browser, or Convex's `ConvexClient` from convex/browser, resolved from CONVEX_APP's node_modules)
// subscribe to bench:latestMessage for one room, spread over PROCS worker processes. Once every client has its first
// result, MESSAGES messages are posted over HTTP, one every INTERVAL_MS, each carrying its send time; a client counts
// a message delivered when a result with that send time reaches it. Sender and clients share this box's clock.
// Prints one JSON line: delivered fraction and delivery latency percentiles (ms), as the VPS reports' fan-out table.
//   CLIENT=bunvex TARGET_URL=http://10.0.0.2:3210 N=1000 bun bench/cloud/fanout.ts
const client = process.env.CLIENT ?? "bunvex";
const url = process.env.TARGET_URL;
if (!url) throw new Error("TARGET_URL is required");
if (client !== "bunvex" && client !== "convex") throw new Error(`CLIENT=${client}`);

type Sub = { onUpdate(q: unknown, args: unknown, cb: (v: { sentAt: number } | null) => void): unknown };
type ClientClass = new (url: string, opts: object) => Sub & { close(): Promise<void> };

async function load(): Promise<{ Client: ClientClass; latestMessage: unknown }> {
  if (client === "bunvex") {
    const [{ BunvexClient }, { anyApi }] = await Promise.all([import("bunvex/browser"), import("bunvex/server")]);
    return { Client: BunvexClient as unknown as ClientClass, latestMessage: anyApi.bench!.latestMessage };
  }
  const app = `${process.env.CONVEX_APP ?? "/root/convex-app"}/`;
  const [browser, server] = await Promise.all([
    import(Bun.resolveSync("convex/browser", app)),
    import(Bun.resolveSync("convex/server", app)),
  ]);
  return { Client: browser.ConvexClient, latestMessage: server.anyApi.bench.latestMessage };
}

if (process.env.FANOUT_WORKER) {
  // A worker: `count` clients, reports "subscribed" once each has a first result, then its latencies on "report".
  const count = Number(process.env.COUNT);
  const room = process.env.ROOM!;
  const { Client, latestMessage } = await load();
  const latencies: number[] = [];
  let ready = 0;
  const clients = Array.from({ length: count }, () => {
    const c = new Client(url, { skipDeploymentUrlCheck: true, unsavedChangesWarning: false });
    let first = true;
    c.onUpdate(latestMessage, { room }, (m) => {
      if (first) {
        first = false;
        if (++ready === count) process.send!({ subscribed: true });
        return;
      }
      if (m) latencies.push(Date.now() - m.sentAt);
    });
    return c;
  });
  process.on("message", async (msg: { report?: boolean }) => {
    if (!msg.report) return;
    process.send!({ latencies });
    await Promise.all(clients.map((c) => c.close()));
    process.exit(0);
  });
} else {
  const n = Number(process.env.N ?? 100);
  const procs = Math.min(Number(process.env.PROCS ?? navigator.hardwareConcurrency), n);
  const messages = Number(process.env.MESSAGES ?? 20);
  const interval = Number(process.env.INTERVAL_MS ?? 1000);
  const settle = Number(process.env.SETTLE_MS ?? 10_000);
  // A server that died (out of memory, say) leaves its clients reconnecting for ever: give up after this long.
  const timeout = Number(process.env.TIMEOUT_MS ?? 180_000);
  const room = `r${Date.now()}`;
  const t0 = performance.now();
  let subscribed = 0;
  let allSubscribed!: () => void;
  const subscribedAll = new Promise<void>((r) => (allSubscribed = r));
  const reports: number[][] = [];
  let reported!: () => void;
  const reportedAll = new Promise<void>((r) => (reported = r));
  const workers = Array.from({ length: procs }, (_, i) =>
    Bun.spawn(["bun", import.meta.path], {
      env: {
        ...process.env,
        FANOUT_WORKER: "1",
        ROOM: room,
        COUNT: String(Math.floor(n / procs) + (i < n % procs ? 1 : 0)),
      },
      stdout: "inherit",
      stderr: "inherit",
      ipc(msg: { subscribed?: boolean; latencies?: number[] }) {
        if (msg.subscribed && ++subscribed === procs) allSubscribed();
        if (msg.latencies && reports.push(msg.latencies) === procs) reported();
      },
    }),
  );
  const exited = Promise.race(
    workers.map((w) => w.exited.then((code) => Promise.reject(new Error(`a worker exited with ${code}`)))),
  );
  const deadline = (what: string) =>
    Bun.sleep(timeout).then(() => {
      for (const w of workers) w.kill("SIGKILL");
      return Promise.reject(new Error(`${what} within ${timeout} ms`));
    });
  await Promise.race([subscribedAll, exited, deadline(`not every client subscribed`)]);
  const subscribeSeconds = (performance.now() - t0) / 1000;
  for (let i = 0; i < messages; i++) {
    const r = await fetch(`${url}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "bench:postMessage", args: { room, sentAt: Date.now() }, format: "json" }),
    });
    const body = (await r.json()) as { status?: string; errorMessage?: string };
    if (body.status !== "success") throw new Error(`postMessage: ${body.errorMessage ?? r.status}`);
    await Bun.sleep(interval);
  }
  await Bun.sleep(settle);
  for (const w of workers) w.send({ report: true });
  await Promise.race([reportedAll, exited, deadline("not every worker reported")]);
  const all = reports.flat().sort((a, b) => a - b);
  const at = (q: number) => all[Math.min(all.length - 1, Math.floor(q * all.length))] ?? null;
  console.log(
    JSON.stringify({
      client,
      n,
      messages,
      delivered: all.length / (n * messages),
      p50: at(0.5),
      p99: at(0.99),
      max: all.at(-1) ?? null,
      subscribeSeconds,
    }),
  );
  await Promise.all(workers.map((w) => w.exited));
  process.exit(0);
}

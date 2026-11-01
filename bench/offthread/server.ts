// STUDY-190 prototypes: bench/server.ts with work moved off the main thread. Nothing here is product code.
//   OFFTHREAD_WRITER=1     (a) SQLite commit writes and their fsync on a writer thread (sqlite-offthread.ts)
//   OFFTHREAD_READERS=N    (b) SQLite index scans and gets on N reader threads, on WAL snapshots
//   OFFTHREAD_FRONT=N      (d) HTTP on N front threads, each a Bun.serve on PORT with reusePort, handing each request
//                          to the main thread as strings; the bunvex server itself listens on PORT + 100
//   PERSISTENCE=sqlite OFFTHREAD_WRITER=1 bun bench/offthread/server.ts
// The rest of the environment is bench/server.ts's.
import { Engine } from "@bunvex/core";
import { createServer, Functions, openPersistence, persistenceConfigFromEnv } from "bunvex/server";
import { bench, benchSchema } from "../functions.ts";
import { OffThreadSqlite } from "./sqlite-offthread.ts";

process.env.MAX_BYTES_WRITTEN_PER_SECOND ||= String(Number.MAX_SAFE_INTEGER);
const config = persistenceConfigFromEnv();
const writer = process.env.OFFTHREAD_WRITER === "1";
const readers = Number(process.env.OFFTHREAD_READERS ?? 0);
const front = Number(process.env.OFFTHREAD_FRONT ?? 0);
const port = Number(process.env.PORT ?? 3210);
const hostname = process.env.BENCH_HOSTNAME;

const persistence =
  config.kind === "sqlite" && (writer || readers > 0)
    ? await OffThreadSqlite.open(`${config.dataDir}/bunvex.sqlite`, {
        durable: config.durable ?? true,
        writer,
        readers,
      })
    : await openPersistence(config);
const engine = await new Engine(benchSchema, persistence, {
  instanceSecret: process.env.INSTANCE_SECRET,
  instanceName: process.env.INSTANCE_NAME,
  lease: { ttlMs: Number(process.env.LEASE_TTL_MS ?? 5000), waitMs: Number(process.env.LEASE_WAIT_MS ?? 0) },
}).init();
const functions = new Functions(engine).register("bench", bench);
// SPIKE (STUDY-194 2b): OFFTHREAD_QUERIES=N runs every query on N workers (query-worker.ts), each reading the store.
const queryWorkers = Number(process.env.OFFTHREAD_QUERIES ?? 0);
if (queryWorkers > 0) {
  if (config.kind !== "sqlite") throw new Error("OFFTHREAD_QUERIES needs PERSISTENCE=sqlite");
  const pending = new Map<number, { resolve: (outcome: string) => void; reject: (e: Error) => void }>();
  const load: number[] = [];
  const workers: Worker[] = [];
  let ids = 0;
  await Promise.all(
    Array.from({ length: queryWorkers }, (_, i) => {
      const w = new Worker(new URL("./query-worker.ts", import.meta.url).href);
      workers.push(w);
      load.push(0);
      return new Promise<void>((resolve) => {
        w.onerror = (e) => console.error("query worker error:", e.message);
        w.onmessage = (e: MessageEvent<"ready" | [number, string | null, string?]>) => {
          if (e.data === "ready") return resolve();
          const [id, outcome, error] = e.data;
          load[i]!--;
          const p = pending.get(id)!;
          pending.delete(id);
          if (outcome === null) p.reject(new Error(`query worker failed: ${error}`));
          else p.resolve(outcome);
        };
        w.postMessage({
          path: `${config.dataDir}/bunvex.sqlite`,
          ...engine.spikeIdentity,
          cacheBytes: Number(process.env.OFFTHREAD_QUERY_CACHE_BYTES ?? 64 * 1024 * 1024),
        });
      });
    }),
  );
  engine.queryWorkers = (request, ts) =>
    new Promise<string>((resolve, reject) => {
      let best = 0;
      for (let i = 1; i < load.length; i++) if (load[i]! < load[best]!) best = i;
      load[best]!++;
      const id = ++ids;
      pending.set(id, { resolve, reject });
      workers[best]!.postMessage([id, request, ts]);
    });
  // Each commit's writes to every worker, before any request at its ts (a port delivers in order).
  (engine as any).committer.onCommit((entries: { ts: bigint; writes: { index: string; key: Uint8Array }[] }[]) => {
    const sent = entries.map((e) => ({ ts: e.ts, writes: e.writes.map((w) => ({ index: w.index, key: w.key })) }));
    for (const w of workers) w.postMessage(["c", sent]);
  }, "spike query workers");
  console.log(`bunvex: ${queryWorkers} query workers`);
}
// (d) needs the API server's handler itself: `server.fetch(req)` passes it no server object, and the handler uses
// the server's per-request methods (timeout, requestIP). Bun.serve is wrapped while createServer runs.
const served: { fetch: (req: Request, srv: unknown) => Response | Promise<Response> }[] = [];
const realServe = Bun.serve;
(Bun as any).serve = (opts: any) => {
  served.push(opts);
  return realServe(opts);
};
const app = createServer({
  engine,
  functions,
  port: front ? port + 100 : port,
  ...(hostname ? { hostname } : {}),
  label: config.kind,
});
(Bun as any).serve = realServe;
// Write batches: how many commits each flush carried and how long it took (printed to stderr on exit).
const batches = { n: 0, commits: 0, seconds: 0 };
const committer = (engine as any).committer;
const metricsHook = committer.onBatch;
committer.onBatch = (commits: number, seconds: number) => {
  metricsHook?.(commits, seconds);
  batches.n++;
  batches.commits += commits;
  batches.seconds += seconds;
};
const api = served[0]!;
// What the handler asks of the server for a request that did not come from it: the front thread owns the socket.
const frontServer = new Proxy(app.server, {
  get(target, key) {
    if (key === "timeout") return () => {};
    if (key === "requestIP") return () => ({ address: "127.0.0.1", family: "IPv4", port: 0 });
    if (key === "upgrade") return () => false;
    const v = Reflect.get(target, key);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

const fronts: Worker[] = [];
for (let i = 0; i < front; i++) {
  const w = new Worker(new URL("./front-worker.ts", import.meta.url).href);
  w.postMessage({ port, hostname: hostname ?? "0.0.0.0" });
  // One string each way (front-worker.ts has the format).
  w.onmessage = async (e: MessageEvent<string>) => {
    const m = e.data;
    const cut = m.indexOf("\u0001");
    const parts = m.slice(0, cut).split("\0");
    const [id, method, url] = parts as [string, string, string];
    const headers: [string, string][] = [];
    for (let i = 3; i + 1 < parts.length; i += 2) headers.push([parts[i]!, parts[i + 1]!]);
    const body = m.slice(cut + 1);
    const req = new Request(url, {
      method,
      headers,
      ...(body && method !== "GET" && method !== "HEAD" ? { body } : {}),
    });
    const res = await api.fetch(req, frontServer);
    const text = await res.text();
    let head = `${id}\0${res.status}`;
    for (const [k, v] of res.headers) head += `\0${k}\0${v}`;
    w.postMessage(`${head}\u0001${text}`);
  };
  fronts.push(w);
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    if (batches.n)
      console.error(
        `write batches: ${batches.n}, ${(batches.commits / batches.n).toFixed(1)} commits each, ` +
          `${((batches.seconds / batches.n) * 1000).toFixed(2)} ms per flush`,
      );
    for (const w of fronts) w.terminate();
    await app.shutdown();
    process.exit(0);
  });
console.log(
  `bunvex offthread: persistence=${config.kind} writer=${writer} readers=${readers} front=${front} port=${port}`,
);

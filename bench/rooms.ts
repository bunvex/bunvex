// Rooms against cursors in a table (AD-42, STUDY-164 §5, §7): N raw sync clients, each moving a cursor at 20/s
// for SECS seconds, through (a) a room's presence and (b) one mutation per move into a `cursors` table that every
// client watches with a `list` query. Reported per N: p50 and p99 of the time from a send to its receipt at
// another client, and the server's CPU (a separate process; `process.cpuUsage()` deltas over the send window, as a
// share of one core).
//
// Every client sends and holds its socket open, but only SAMPLE of them parse what they receive: parsing 500
// frames of 500 members in this one process would measure the client, not the server. The server sends to all N
// as it would. A coalesced update (a later one replaced it before the tick) is not a sample in either mode.
//   bun bench/rooms.ts            Env: NS (default 10,100,500), SECS (default 10), RATE (default 20), SAMPLE (default 20)
import { Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { createServer, defineSchema, defineTable, Functions, mutation, presence, query, room } from "bunvex/server";
import { v } from "bunvex/values";

const NS = (process.env.NS ?? "10,100,500").split(",").map(Number);
const SECS = Number(process.env.SECS ?? 10);
const RATE = Number(process.env.RATE ?? 20);
const SAMPLE = Number(process.env.SAMPLE ?? 20);

/** The server process: both kinds of cursors, and its CPU on request. */
async function runServer() {
  const engine = await new Engine(
    defineSchema({ cursors: defineTable({ c: v.number(), seq: v.number(), t: v.number() }) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine).register("cursors", {
    join: mutation(async (ctx: any, a: { c: number }) => ctx.db.insert("cursors", { c: a.c, seq: -1, t: 0 })),
    move: mutation(async (ctx: any, a: { id: string; seq: number; t: number }) => {
      await ctx.db.patch(a.id, { seq: a.seq, t: a.t });
    }),
    list: query(async (ctx: any) => ctx.db.query("cursors").collect()),
  } as never);
  functions.register("rooms", {
    cursors: room({ args: { id: v.string() }, presence: { c: v.number(), seq: v.number(), t: v.number() } }),
    online: presence({ state: { c: v.number() } }),
  } as never);
  const { server } = createServer({ engine, functions, port: 0, label: "bench-rooms" });
  process.on("message", () => {
    const u = process.cpuUsage();
    process.send?.({ cpuMs: (u.user + u.system) / 1000 });
  });
  process.send?.({ port: server.port });
  await new Promise(() => {});
}

type Row = { mode: string; n: number; p50: number; p99: number; cpuPct: number; sent: number; samples: number };

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

async function runBench() {
  const rows: Row[] = [];
  for (const n of NS) {
    for (const mode of ["room", "table"] as const) {
      const row = await runOne(mode, n);
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  console.log(`\nN clients, ${RATE} moves/s each, ${SECS} s; latency in ms from send to receipt at another client`);
  console.log("| N | mode | moves sent | samples | p50 | p99 | server CPU (% of a core) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows)
    console.log(
      `| ${r.n} | ${r.mode === "room" ? "room" : "table"} | ${r.sent} | ${r.samples} | ${r.p50.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.cpuPct.toFixed(0)} |`,
    );
}

async function runOne(mode: "room" | "table", n: number): Promise<Row> {
  const port = Promise.withResolvers<number>();
  let cpu = Promise.withResolvers<number>();
  const child = Bun.spawn(["bun", import.meta.path, "server"], {
    stdout: "inherit",
    stderr: "inherit",
    ipc(m: { port?: number; cpuMs?: number }) {
      if (m.port !== undefined) port.resolve(m.port);
      if (m.cpuMs !== undefined) cpu.resolve(m.cpuMs);
    },
  });
  const cpuNow = async () => {
    cpu = Promise.withResolvers<number>();
    child.send({});
    return cpu.promise;
  };
  const url = `ws://127.0.0.1:${await port.promise}/api/1.0.0/sync`;
  const lat: number[] = [];
  let recording = false;
  let sent = 0;
  let nextReq = 1;

  type Client = { ws: WebSocket; send(m: unknown): void; ids: Map<number, (r: any) => void> };
  const connect = async (c: number): Promise<Client> => {
    const ws = new WebSocket(url);
    const ids = new Map<number, (r: any) => void>();
    const sampled = c < Math.min(SAMPLE, n);
    const lastSeq = new Map<number, number>();
    ws.onmessage = (e) => {
      const data = e.data as string;
      // Unsampled clients leave the frame unparsed, except for the answers to their own requests.
      if (!sampled && !data.startsWith('{"type":"MutationResponse"')) return;
      const m = JSON.parse(data);
      if (m.type === "MutationResponse") ids.get(m.requestId)?.(m);
      else if (m.type === "RoomMembers") {
        if (!recording) return;
        const now = performance.now();
        for (const x of m.set) if (x.presence?.c !== c && x.presence) lat.push(now - x.presence.t);
      } else if (m.type === "Transition") {
        const now = performance.now();
        for (const mod of m.modifications) {
          if (mod.type !== "QueryUpdated") continue;
          for (const d of mod.value as { c: number; seq: number; t: number }[]) {
            if (d.seq > (lastSeq.get(d.c) ?? -1)) {
              lastSeq.set(d.c, d.seq);
              if (recording && d.c !== c) lat.push(now - d.t);
            }
          }
        }
      }
    };
    await new Promise((r) => (ws.onopen = r));
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ type: "Connect", sessionId: crypto.randomUUID(), connectionCount: 0, lastCloseReason: null, clientTs: 0 });
    return { ws, send, ids };
  };
  const clients: Client[] = [];
  for (let c = 0; c < n; c++) clients.push(await connect(c));
  const call = (cl: Client, udfPath: string, args: object) =>
    new Promise<any>((resolve) => {
      const requestId = nextReq++;
      cl.ids.set(requestId, resolve);
      cl.send({ type: "Mutation", requestId, udfPath, args: [args] });
    });

  const docIds: string[] = [];
  if (mode === "table") {
    for (let c = 0; c < n; c++) docIds.push((await call(clients[0]!, "cursors:join", { c })).result);
    for (const [i, cl] of clients.entries()) {
      cl.send({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [{ type: "Add", queryId: 0, udfPath: "cursors:list", args: [{}] }],
      });
      if (i % 50 === 0) await Bun.sleep(10);
    }
  } else {
    for (const cl of clients)
      cl.send({ type: "RoomJoin", roomId: 0, kind: "room", name: "rooms:cursors", args: { id: "bench" } });
  }
  await Bun.sleep(1500); // joins, and the first snapshot to everyone

  const cpu0 = await cpuNow();
  const t0 = performance.now();
  recording = true;
  const timers = clients.map((cl, c) => {
    let seq = 0;
    return setTimeout(
      () => {
        const iv = setInterval(() => {
          const t = performance.now();
          sent++;
          if (mode === "room") cl.send({ type: "RoomPresence", roomId: 0, presence: { c, seq: seq++, t } });
          else
            cl.send({
              type: "Mutation",
              requestId: nextReq++,
              udfPath: "cursors:move",
              args: [{ id: docIds[c], seq: seq++, t }],
            });
        }, 1000 / RATE);
        (timers[c] as any) = iv;
      },
      Math.random() * (1000 / RATE),
    );
  });
  await Bun.sleep(SECS * 1000);
  const cpu1 = await cpuNow();
  const wall = performance.now() - t0;
  for (const t of timers) clearInterval(t as never), clearTimeout(t as never);
  await Bun.sleep(mode === "table" ? 4000 : 500); // what is in flight
  recording = false;
  for (const cl of clients) cl.ws.close();
  child.kill();
  await child.exited;
  return {
    mode,
    n,
    p50: pct(lat, 0.5),
    p99: pct(lat, 0.99),
    cpuPct: ((cpu1 - cpu0) / wall) * 100,
    sent,
    samples: lat.length,
  };
}

if (process.argv[2] === "server") await runServer();
else await runBench();

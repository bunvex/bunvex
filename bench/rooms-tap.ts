// The rooms event tap's cost to the hub (AD-43, STUDY-165 §4): events fanned out through a 100-member room, with no
// tap and with one, in events per second through `RoomHub.broadcast`. The sinks only count frames, so this measures
// the hub (the fan-out and the tap's recording), not sockets. Runs alternate (untapped, tapped, untapped, …) and the
// median of each is reported, so that a drift of the machine shows in both.
//   bun bench/rooms-tap.ts        Env: MEMBERS (default 100), EVENTS (per run, default 20000), RUNS (default 9),
//                                 HUB (a hub module to measure instead, e.g. main's copy; without `tapEvents` it
//                                 measures the untapped runs only)
import type { RoomHub as Hub } from "../packages/server/src/rooms/hub.ts";

const MEMBERS = Number(process.env.MEMBERS ?? 100);
const EVENTS = Number(process.env.EVENTS ?? 20_000);
const RUNS = Number(process.env.RUNS ?? 9);
const { RoomHub } = (await import(process.env.HUB ?? "../packages/server/src/rooms/hub.ts")) as {
  RoomHub: typeof Hub;
};

const LIMITS = {
  payloadBytes: 4096,
  argsBytes: 4096,
  roomsPerConnection: 64,
  presencePerSecond: 40,
  eventsPerSecond: 10,
  memberCap: 500,
  graceMs: 5000,
  tickMs: 30,
  maxBufferedBytes: 1 << 20,
};
const KEY = { kind: "room" as const, name: "rooms:doc", argsJson: '{"id":"bench"}' };
// a cursor-sized payload, as a game or a whiteboard sends
const DATA = { x: 512.5, y: 301.25, tool: "pen", color: "#ff8800" };

let frames = 0;
function hubWithRoom(): Hub {
  const hub = new RoomHub(LIMITS);
  for (let i = 0; i < MEMBERS; i++)
    hub.join(
      {
        sessionId: `s${i}`,
        send: () => void frames++,
        behind: () => 0,
        resync() {},
      },
      1,
      KEY,
      { userId: null, canPublish: true },
    );
  return hub;
}

async function run(tapped: boolean): Promise<number> {
  const hub = hubWithRoom();
  if (tapped) await hub.tapEvents(KEY, null, 0);
  const t0 = performance.now();
  for (let i = 0; i < EVENTS; i++) hub.broadcast(KEY, "move", DATA);
  const ms = performance.now() - t0;
  return EVENTS / (ms / 1000);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const canTap = typeof (RoomHub.prototype as { tapEvents?: unknown }).tapEvents === "function";

// warm up both paths
for (let i = 0; i < 2; i++) {
  await run(false);
  if (canTap) await run(true);
}
const untapped: number[] = [];
const tapped: number[] = [];
for (let r = 0; r < RUNS; r++) {
  untapped.push(await run(false));
  if (canTap) tapped.push(await run(true));
}
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
console.log(`members=${MEMBERS} events/run=${EVENTS} runs=${RUNS} (frames sent: ${fmt(frames)})`);
console.log(`untapped: median ${fmt(median(untapped))} events/s  [${untapped.map(fmt).join(", ")}]`);
if (canTap) {
  console.log(`tapped:   median ${fmt(median(tapped))} events/s  [${tapped.map(fmt).join(", ")}]`);
  console.log(`tapped / untapped: ${((median(tapped) / median(untapped)) * 100).toFixed(1)} %`);
}
process.exit(0);

// The large-transition warnings (STUDY-103), as Convex's `reportLargeTransition` in
// `browser/sync/web_socket_manager.ts`: for a Transition with `clientClockSkew` and `serverTs`, the client logs
// a frame over 20 MB, else a transit over 20 s. The size is the frame's: for a chunked transition, its last
// chunk. Differential: each case runs with BunvexClient and with the official ConvexClient against a sync server
// the test scripts, and both must log the same lines, but for the wording fix "more that" → "more than"
// (DV-349) and the transit time, which is measured. The server's clock is set ahead, so the skew matters.
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { v1 } from "@bunvex/protocol";
import { ConvexClient } from "convex/browser";
import { anyApi as oracleApi } from "convex/server";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** The scripted server's clock runs 10 minutes ahead of the client's: the transit must take the skew out. */
const serverNow = () => Date.now() + 600_000;

/** A sync server that waits for the client's query, then sends the frames the case builds. */
function server() {
  let ws: Bun.ServerWebSocket<unknown> | null = null;
  let clockSkew: number | undefined;
  let subscribed = false;
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      // A large transition's chunks are sent at once: more than Bun buffers by default (16 MiB) before dropping.
      backpressureLimit: 2 ** 30,
      open(socket) {
        ws = socket;
      },
      message(_ws, data) {
        const m = JSON.parse(String(data)) as { type: string; clientTs?: number };
        // As the server does (Convex's sync worker too): the client's clock minus the server's, at Connect.
        if (m.type === "Connect" && m.clientTs) clockSkew = m.clientTs - serverNow();
        if (m.type === "ModifyQuerySet") subscribed = true;
      },
    },
  });
  cleanup.push(() => s.stop(true));
  return {
    address: `http://127.0.0.1:${s.port}`,
    ready: async () => {
      for (let i = 0; i < 400 && !subscribed; i++) await Bun.sleep(5);
      expect(subscribed).toBe(true);
    },
    clockSkew: () => clockSkew,
    send: (frame: string) => ws!.send(frame),
  };
}

/** A Transition answering query 0, as text. */
function transition(value: string, timing: { clientClockSkew?: number; serverTs?: number }) {
  return v1.encodeServerMessage({
    type: "Transition",
    startVersion: { querySet: 0, identity: 0, ts: 0n },
    endVersion: { querySet: 1, identity: 0, ts: 1n },
    modifications: [{ type: "QueryUpdated", queryId: 0, value, logLines: [], journal: null }],
    ...timing,
  });
}

/** The frame cut into `parts` TransitionChunks, as the server splits a large transition. */
function chunks(frame: string, parts: number) {
  const size = Math.ceil(frame.length / parts);
  return Array.from({ length: parts }, (_, i) =>
    JSON.stringify({
      type: "TransitionChunk",
      chunk: frame.slice(i * size, (i + 1) * size),
      partNumber: i,
      totalParts: parts,
      transitionId: "t1",
    }),
  );
}

type Case = (s: ReturnType<typeof server>) => string[];
const nanos = (ms: number) => ms * 1_000_000;
const cases: [string, Case][] = [
  [
    "a transition sent 30 s ago",
    (s) => [transition("v", { clientClockSkew: s.clockSkew(), serverTs: nanos(serverNow() - 30_000) })],
  ],
  [
    "a frame over 20 MB",
    (s) => [transition("x".repeat(21_000_000), { clientClockSkew: s.clockSkew(), serverTs: nanos(serverNow()) })],
  ],
  [
    "a 25 MB transition in 5 chunks, sent 30 s ago: the last chunk's size",
    (s) =>
      chunks(
        transition("x".repeat(25_000_000), { clientClockSkew: s.clockSkew(), serverTs: nanos(serverNow() - 30_000) }),
        5,
      ),
  ],
  ["a transition without clientClockSkew and serverTs", () => [transition("x".repeat(21_000_000), {})]],
];

type Client = { onUpdate(query: unknown, args: object, cb: () => void): unknown; close(): Promise<void> };
type Make = (address: string, logger: object) => Client;
const clients: [string, Make, unknown][] = [
  [
    "BunvexClient",
    (a, logger) => new BunvexClient(a, { unsavedChangesWarning: false, logger } as never) as never,
    anyApi.q!.default,
  ],
  [
    "official ConvexClient",
    (a, logger) => new ConvexClient(a, { unsavedChangesWarning: false, logger } as never) as never,
    oracleApi.q!.default,
  ],
];

/** What a client logs for the case: its `log` lines, and its verbose line about the transition. */
async function run(make: Make, query: unknown, build: Case) {
  const logs: string[] = [];
  const verbose: string[] = [];
  const logger = {
    log: (...a: unknown[]) => logs.push(a.join(" ")),
    logVerbose: (...a: unknown[]) => verbose.push(a.join(" ")),
    warn: (...a: unknown[]) => logs.push(`warn: ${a.join(" ")}`),
    error: (...a: unknown[]) => logs.push(`error: ${a.join(" ")}`),
  };
  const s = server();
  const client = make(s.address, logger);
  cleanup.push(() => client.close());
  let updates = 0;
  client.onUpdate(query, {}, () => updates++);
  await s.ready();
  for (const frame of build(s)) s.send(frame);
  for (let i = 0; i < 2000 && updates === 0; i++) await Bun.sleep(5);
  expect(updates).toBe(1);
  return {
    // The transit is measured: its milliseconds and rate vary.
    logs: logs.map((l) => l.replace(/\(\d+ms\)/, "(Nms)")),
    verbose: verbose
      .filter((l) => /^received [\d.]+MB transition in/.test(l))
      .map((l) => l.replace(/in -?\d+ms at -?[\d.e+-]+MB per second/, "in Nms at RATE")),
    transitMs: logs
      .map((l) => /\((\d+)ms\)/.exec(l)?.[1])
      .filter((x) => x !== undefined)
      .map(Number),
  };
}

describe("large-transition warnings, as the official client", () => {
  for (const [name, build] of cases)
    test(name, async () => {
      const [ours, theirs] = [
        await run(clients[0]![1], clients[0]![2], build),
        await run(clients[1]![1], clients[1]![2], build),
      ];
      // DV-349: Convex's "more that" reads "more than" in bunvex.
      expect(ours.logs).toEqual(theirs.logs.map((l) => l.replace("more that 20MB", "more than 20MB")));
      expect(ours.verbose).toEqual(theirs.verbose);
      // 30 s plus the time to send and parse the frames (wide: a loaded machine parses 25 MB slowly).
      for (const ms of [...ours.transitMs, ...theirs.transitMs]) expect(ms).toBeWithin(30_000, 35_000);
      if (name.startsWith("a transition sent")) {
        expect(ours.logs).toEqual(["received query results totaling 0MB which took more than 20s to arrive (Nms)"]);
      } else if (name.startsWith("a frame over")) {
        expect(ours.logs).toEqual([
          "received query results totaling more than 20MB (21MB) which will take a long time to download on slower connections",
        ]);
      } else if (name.startsWith("a 25 MB")) {
        expect(ours.logs).toEqual(["received query results totaling 5MB which took more than 20s to arrive (Nms)"]);
      } else {
        expect(ours.logs).toEqual([]);
        expect(ours.verbose).toEqual([]);
      }
    }, 30_000);
});

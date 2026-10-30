// `function.runtime` on log stream events (Convex's `868554b`, DV-552), on Convex's backend (the oracle) and on
// bunvex's, for the app of `log-runtime-app/`: a webhook stream's `console` and `function_execution` events for a
// query, a mutation, a V8 action, a "use node" action, and actions that fail before they run (no such function,
// arguments their validator refuses). Convex names its isolate "convex", bunvex its own "bunvex" (DV-552, rule 5), so
// that one value is mapped before comparing. Local only: skipped, with a note, when Convex's backend is not there
// (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`log-event-runtime: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../log-runtime-app");
let convex: Backend;
let bunvex: Backend;
const stops: (() => void)[] = [];
const seen = new Map<Backend, Record<string, unknown>[]>();

const authOf = (b: Backend) => `${b.name === "convex" ? "Convex" : "Bunvex"} ${b.adminKey}`;

/** A webhook stream on `b`, recording each event it sends. */
async function stream(b: Backend) {
  const events: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(r) {
      events.push(...((await r.json()) as Record<string, unknown>[]));
      return new Response(null, { status: 200 });
    },
  });
  stops.push(() => server.stop(true));
  const r = await fetch(`${b.url}/api/v1/create_log_stream`, {
    method: "POST",
    headers: { authorization: authOf(b), "content-type": "application/json" },
    body: JSON.stringify({ logStreamType: "webhook", url: `http://127.0.0.1:${server.port}/hook`, format: "json" }),
  });
  const { id } = (await r.json()) as { id: string };
  for (let i = 0; i < 500; i++) {
    const s = (await (
      await fetch(`${b.url}/api/v1/get_log_stream/${id}`, { headers: { authorization: authOf(b) } })
    ).json()) as { status: { type: string } };
    if (s.status.type === "active") break;
    await Bun.sleep(10);
  }
  return events;
}

const CALLS: [kind: "query" | "mutation" | "action", path: string, args: unknown][] = [
  ["query", "fns:q", {}],
  ["mutation", "fns:m", {}],
  ["action", "fns:a", { n: 1 }],
  ["action", "node:a", {}],
  ["action", "fns:missing", {}],
  ["action", "fns:a", { n: "not a number" }],
];

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) {
    const events = await stream(b);
    for (const [kind, path, args] of CALLS) await b.call(kind, path, args);
    // Every call's function_execution has arrived.
    for (let i = 0; i < 1000; i++) {
      if (events.filter((e) => e.topic === "function_execution").length >= CALLS.length) break;
      await Bun.sleep(10);
    }
    seen.set(b, events);
  }
}, 300_000);

afterAll(async () => {
  for (const s of stops.splice(0)) s();
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** Each console and function_execution event: its topic, its function's path, and its runtime (Convex's mapped). */
function runtimes(b: Backend) {
  return seen
    .get(b)!
    .filter((e) => e.topic === "console" || e.topic === "function_execution")
    .map((e) => {
      const f = e.function as { path: string; runtime?: unknown };
      const runtime = b.name === "convex" && f.runtime === "convex" ? "bunvex" : f.runtime;
      // The path's form differs apart from this (`fns:a` on Convex, `fns.js:a` on bunvex): its own item.
      return { topic: e.topic, path: f.path.replace(/\.js:/, ":"), has: "runtime" in f, runtime };
    })
    .sort((x, y) => `${x.path}${x.topic}`.localeCompare(`${y.path}${y.topic}`));
}

describe.skipIf(!ready)("function.runtime on log stream events, against Convex's backend", () => {
  test("console and function_execution events name the runtime as Convex's, isolate mapped to bunvex", () => {
    const [c, b] = [runtimes(convex), runtimes(bunvex)];
    expect(c.length).toBeGreaterThan(0);
    expect(b).toEqual(c);
  });
});

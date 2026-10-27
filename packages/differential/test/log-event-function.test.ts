// The `function` object of log stream events (Convex's `FunctionEventSource`), on Convex's backend (the oracle) and on
// bunvex's, for the app of `log-function-app/`: a webhook stream's `console` and `function_execution` events for a
// query, a mutation, an action, a default export, a function in a nested module and an HTTP action. `path` is
// Convex's stripped path (`identifier_str`: `fns:q`, a default export `dflt`) or an HTTP action's route; `cached` is a
// query's cache hit, false on an action's streamed line (`log_action_progress`), else null. Local only: skipped, with
// a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`log-event-function: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../log-function-app");
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

const CALLS: [kind: "query" | "mutation" | "action", path: string][] = [
  ["query", "fns:q"],
  ["mutation", "fns:m"],
  ["action", "fns:a"],
  ["query", "dflt"],
  ["mutation", "nested/deep:f"],
];

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await startAll([startConvex({ app: APP }), startBunvex({ app: APP })]);
  for (const b of [convex, bunvex]) {
    const events = await stream(b);
    for (const [kind, path] of CALLS) await b.call(kind, path, {});
    // The same query again: a cache hit.
    await b.call("query", "fns:q", {});
    await (await fetch(`${b.url}/http/hello`)).text();
    for (let i = 0; i < 1000; i++) {
      if (events.filter((e) => e.topic === "function_execution").length >= CALLS.length + 2) break;
      await Bun.sleep(10);
    }
    seen.set(b, events);
  }
}, 300_000);

afterAll(async () => {
  for (const s of stops.splice(0)) s();
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

/** Each console and function_execution event's topic and `function` path, type and cached, in a stable order. */
function functions(b: Backend) {
  return seen
    .get(b)!
    .filter((e) => e.topic === "console" || e.topic === "function_execution")
    .map((e) => {
      const f = e.function as { path: string; type: string; cached: unknown };
      return { topic: e.topic, path: f.path, type: f.type, cached: f.cached };
    })
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
}

describe.skipIf(!ready)("log stream events' function, against Convex's backend", () => {
  test("path and cached of console and function_execution events, as Convex's", () => {
    const [c, b] = [functions(convex), functions(bunvex)];
    expect(c.length).toBeGreaterThan(0);
    expect(b).toEqual(c);
  });
});

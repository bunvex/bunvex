// What an HTTP action leaves when its response's body ends, on Convex's backend (the oracle) and on bunvex's (owner,
// 2026-10-21; STUDY-77 §7): Convex's isolate runs until the body's stream ends and then shuts its tasks down
// (`crates/isolate/src/environment/action/mod.rs` `run_inner`, at 72ce13c), so a timer still pending, an interval and
// an operation's continuation write nothing after it; a body's own code, which runs after the handler returned, works
// while the body streams. What each route wrote is read back a while after its body ended. Local only: skipped, with a
// note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`http-action-end: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../http-end-app");

let convex: Backend;
let bunvex: Backend;

beforeAll(async () => {
  if (!ready) return;
  [convex, bunvex] = await Promise.all([startConvex({ app: APP }), startBunvex({ app: APP })]);
}, 300_000);

afterAll(async () => {
  await Promise.all([convex?.stop(), bunvex?.stop()]);
});

let nonce = 0;
const rows = async (b: Backend, tag: string) => {
  const { body } = await b.call("query", "ends:rows", { tag, nonce: ++nonce });
  const a = body as { status: string; value?: unknown; errorMessage?: string };
  expect({ status: a.status, error: a.errorMessage }).toEqual({ status: "success", error: undefined });
  return a.value as number;
};

/** `path` requested on `b`: its status and body, what it wrote by the body's end, and what it wrote in the 400 ms after. */
async function run(b: Backend, path: string) {
  const tag = `${path}-${Math.random()}`;
  const r = await fetch(`${b.url}/http${path}?tag=${encodeURIComponent(tag)}`);
  const response = [r.status, await r.text()];
  const atEnd = await rows(b, tag);
  await Bun.sleep(400);
  return { response, atEnd, wroteLater: (await rows(b, tag)) - atEnd };
}

describe.skipIf(!ready)("what an HTTP action leaves when its body ends, against Convex's backend", () => {
  test("a timer still pending when the handler answers never fires", async () => {
    const [c, b] = await Promise.all([run(convex, "/leftTimer"), run(bunvex, "/leftTimer")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ response: [200, "answered"], atEnd: 0, wroteLater: 0 });
  });

  test("an interval writes while the handler runs, and nothing after", async () => {
    const [c, b] = await Promise.all([run(convex, "/interval"), run(bunvex, "/interval")]);
    // How many ticks land before the answer is the scheduler's: at least one on each, none after.
    for (const x of [c, b]) {
      expect(x.response).toEqual([200, "answered"]);
      expect(x.wroteLater).toBe(0);
      expect(x.atEnd).toBeGreaterThan(0);
    }
  });

  test("an operation's continuation after the answer never runs", async () => {
    const [c, b] = await Promise.all([run(convex, "/continuation"), run(bunvex, "/continuation")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ response: [200, "answered"], atEnd: 0, wroteLater: 0 });
  });

  test("a streamed body's code runs (timers, ctx) until it ends; a timer it left then never fires", async () => {
    const [c, b] = await Promise.all([run(convex, "/stream"), run(bunvex, "/stream")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ response: [200, "xx"], atEnd: 2, wroteLater: 0 });
  });
});

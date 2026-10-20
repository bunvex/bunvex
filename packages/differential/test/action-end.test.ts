// What an action leaves behind when it answers, on Convex's backend (the oracle) and on bunvex's (STUDY-171 §12.11,
// owner 2026-10-21): Convex ends the isolate with the action (`crates/isolate/src/environment/action/mod.rs`, the task
// executor shut down once the result is in), so a timer still pending, an interval and an operation's continuation
// write nothing after the answer; a timer that fired while the action ran did. What each wrote is read back a while
// after the answer. Local only: skipped, with a note, when Convex's backend is not there.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Backend, ORACLE_BIN, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`action-end: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

const APP = resolve(import.meta.dir, "../action-end-app");

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
const value = async (b: Backend, kind: "action" | "query", path: string, args: object) => {
  const { body } = await b.call(kind, path, args);
  const a = body as { status: string; value?: unknown; errorMessage?: string };
  expect({ path, status: a.status, error: a.errorMessage }).toEqual({ path, status: "success", error: undefined });
  return a.value;
};
const rows = (b: Backend, tag: string) => value(b, "query", "ends:rows", { tag, nonce: ++nonce });

/** `path` run on `b`: its value, what it wrote by its answer, and what it wrote in the 400 ms after. */
async function run(b: Backend, path: string) {
  const tag = `${path}-${Math.random()}`;
  const answer = await value(b, "action", path, { tag });
  const atAnswer = await rows(b, tag);
  await Bun.sleep(400);
  return { answer, wroteLater: ((await rows(b, tag)) as number) - (atAnswer as number), atAnswer };
}

describe.skipIf(!ready)("what an action leaves when it answers, against Convex's backend", () => {
  test("a timer that fires while the action runs works", async () => {
    const [c, b] = await Promise.all([run(convex, "ends:timerBefore"), run(bunvex, "ends:timerBefore")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ answer: 1, wroteLater: 0, atAnswer: 1 });
  });

  test("a timer still pending when it answers never fires", async () => {
    const [c, b] = await Promise.all([run(convex, "ends:timerAfter"), run(bunvex, "ends:timerAfter")]);
    expect(b).toEqual(c);
    expect(c.wroteLater).toBe(0);
  });

  test("an interval writes while the action runs, and nothing after", async () => {
    const [c, b] = await Promise.all([run(convex, "ends:interval"), run(bunvex, "ends:interval")]);
    // How many ticks land before the answer is the scheduler's: at least one on each, none after.
    for (const x of [c, b]) {
      expect(x.wroteLater).toBe(0);
      expect(x.atAnswer as number).toBeGreaterThan(0);
    }
  });

  test("an operation's continuation after the answer never runs", async () => {
    const [c, b] = await Promise.all([run(convex, "ends:continuation"), run(bunvex, "ends:continuation")]);
    expect(b).toEqual(c);
    expect(c).toEqual({ answer: 1, wroteLater: 0, atAnswer: 0 });
  });
});

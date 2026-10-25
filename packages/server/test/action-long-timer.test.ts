// A V8 action's timer waits its whole delay, however long, as Convex's `sleep` op does: any finite delay becomes a
// tokio `Duration`, and only negative, infinite and NaN delays fire at once (`crates/isolate/src/ops/time.rs`,
// `sleep_request`, at precompiled-2026-10-24-bb31399; `85f9693`). Bun fires a timer past 2^31-1 ms after about 1 ms.
import { afterEach, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, Engine, LongTimer } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { v } from "@bunvex/values";
import { trackedActionTimers } from "../src/action-timeout.ts";
import { contextGlobals } from "../src/code-version.ts";
import { Functions } from "../src/functions.ts";
import { createServer } from "../src/server.ts";

const SERVER = JSON.stringify(["bunvex", "server"].join("/"));
const MODULE = `
import { action } from ${SERVER};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const longTimeout = action(async () => { let fired = false; setTimeout(() => { fired = true; }, 2 ** 31); await wait(50); return fired; });
export const longInterval = action(async () => { let ticks = 0; const t = setInterval(() => { ticks++; }, 3e9); await wait(50); clearInterval(t); return ticks; });
export const cleared = action(async () => { let fired = false; const t = setTimeout(() => { fired = true; }, 2 ** 40); clearTimeout(t); await wait(20); return fired; });
export const infinite = action(async () => { let fired = 0; setTimeout(() => { fired++; }, Infinity); setTimeout(() => { fired++; }, NaN); setTimeout(() => { fired++; }, -5); await wait(50); return fired; });
`;

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

async function deployment() {
  const engine = await new Engine(
    defineSchema({ items: defineTable(v.any()) }),
    await MemoryPersistence.open(null, { durable: false }),
  ).init();
  const functions = new Functions(engine);
  const s = createServer({ engine, functions, port: 0, deployable: true, fileStorage: null });
  stops.push(() => s.shutdown());
  await s.codeReady;
  await s.deployCode([{ path: "m.js", source: MODULE, environment: "isolate" }]);
  return functions;
}

describe("a V8 action's timers past 2^31-1 ms", () => {
  test("setTimeout waits its whole delay", async () => {
    expect(await (await deployment()).runAction("m:longTimeout", {})).toBe(false);
  });

  test("setInterval waits its whole period", async () => {
    expect(await (await deployment()).runAction("m:longInterval", {})).toBe(0);
  });

  test("clearTimeout cancels one", async () => {
    expect(await (await deployment()).runAction("m:cleared", {})).toBe(false);
  });

  test("infinite, NaN and negative delays still fire at once", async () => {
    expect(await (await deployment()).runAction("m:infinite", {})).toBe(3);
  });

  test("one still pending is cleared when the action ends", () => {
    const g = contextGlobals(false, {}) as { setTimeout: (fn: () => void, ms: number) => unknown };
    const run = trackedActionTimers(() => g.setTimeout(() => {}, 2 ** 31));
    expect(run.value).toBeInstanceOf(LongTimer);
    expect((run.value as LongTimer).hasRef()).toBe(true);
    run.end();
    expect((run.value as LongTimer).hasRef()).toBe(false);
  });

  test("clearTimeout and clearInterval cancel one", () => {
    const g = contextGlobals(false, {}) as Record<
      "setTimeout" | "setInterval",
      (fn: () => void, ms: number) => LongTimer
    > &
      Record<"clearTimeout" | "clearInterval", (t: unknown) => void>;
    const t = g.setTimeout(() => {}, 2 ** 31);
    const i = g.setInterval(() => {}, 2 ** 31);
    g.clearTimeout(t);
    g.clearInterval(i);
    expect([t.hasRef(), i.hasRef()]).toEqual([false, false]);
  });
});

// A delay taken straight from an operator's knob past 2^31−1 ms (24.8 days) (STUDY-174 S8). Convex's knobs are
// `Duration`s that tokio sleeps for whatever their length; a JS timer given more fires after about 1 ms instead, so
// the loop it paces spins. The storage usage gauges (USAGE_TRACKING_PERIOD_SECS, Convex's 1 h default) are one such
// loop: a period of 60 days should mean no run for at least 30 days, not a run every millisecond. Owner, 2026-10-21
// (Q8): such delays sleep their whole length, as Convex's; the loops below are some of the knobs' (rule 6 keeps the
// rest honest).
import { expect, test } from "bun:test";
import { defineSchema, Engine, realRuntime } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { withActionTimeout } from "../src/action-timeout.ts";
import { UsageGauges } from "../src/usage-gauges.ts";

const DAYS_30 = 30 * 86_400_000;

test("a 60-day gauge period (a first wait of 30 days) runs nothing in the next 200 ms", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const gauges = new UsageGauges(engine, () => {}, { periodMs: 60 * 86_400_000, random: () => 0 });
  let runs = 0;
  const run = gauges.run.bind(gauges);
  gauges.run = async () => {
    runs++;
    return run();
  };
  gauges.start();
  await Bun.sleep(200);
  gauges.stop();
  await engine.close();
  expect(runs).toBe(0);
});

test("an action timeout of 30 days (V8_ACTION_USER_TIMEOUT_SECS) lets a 100 ms action finish", async () => {
  const outcome = await withActionTimeout(
    DAYS_30,
    () => new Error("timed out"),
    async () => {
      await Bun.sleep(100);
      return "done";
    },
  ).catch((e: Error) => e.message);
  expect(outcome).toBe("done");
});

test("the real runtime's timers and sleep take 30 days too (the scheduler's and the crons' waits)", async () => {
  let fired = 0;
  const t = realRuntime.setTimeout(() => fired++, DAYS_30);
  const i = realRuntime.setInterval(() => fired++, DAYS_30);
  const stop = new AbortController();
  const slept = await Promise.race([
    realRuntime.sleep(DAYS_30, stop.signal).then(
      () => "woke",
      () => "aborted",
    ),
    Bun.sleep(150).then(() => "asleep"),
  ]);
  stop.abort();
  realRuntime.clearTimeout(t);
  realRuntime.clearInterval(i);
  expect([fired, slept]).toEqual([0, "asleep"]);
});

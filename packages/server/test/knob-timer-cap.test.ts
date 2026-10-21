// A delay taken straight from an operator's knob past 2^31−1 ms (24.8 days) (STUDY-174 S8). Convex's knobs are
// `Duration`s that tokio sleeps for whatever their length; a JS timer given more fires after about 1 ms instead, so
// the loop it paces spins. The storage usage gauges (USAGE_TRACKING_PERIOD_SECS, Convex's 1 h default) are one such
// loop: a period of 60 days should mean no run for at least 30 days, not a run every millisecond.
import { expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { UsageGauges } from "../src/usage-gauges.ts";

// A todo until the owner decides S8 (STUDY-174 §11): run with `bun test --todo` to see it fail on main.
test.todo("a 60-day gauge period (a first wait of 30 days) runs nothing in the next 200 ms", async () => {
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

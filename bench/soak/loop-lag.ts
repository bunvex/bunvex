// The soak's event-loop stall recorder, preloaded into the backend by `soak.ts` (`bun --preload`; `--off looplag`
// leaves it out). A timer ticks every SOAK_LOOP_TICK_MS (default 20); a tick that runs at least that late means the
// main thread was held, and appends one line to SOAK_LOOP_OUT: the wall-clock time it ran (epoch ms) and how late it
// was (ms). The soak reads the lines of each sample window (./diagnostics.ts `loopWindow`). The backend's own gauge
// keeps only the last probe of every 500 ms, which misses most stalls between scrapes.
//
// Main thread only: a preload also runs in each worker, whose stalls hold no other thread's calls.

import { appendFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";

const out = process.env.SOAK_LOOP_OUT;
if (out && isMainThread) {
  const tick = Number(process.env.SOAK_LOOP_TICK_MS ?? 20);
  let expected = performance.now() + tick;
  setInterval(() => {
    const now = performance.now();
    const late = now - expected;
    expected = now + tick;
    if (late >= tick) appendFileSync(out, `${Date.now()} ${Math.round(late)}\n`);
  }, tick).unref();
}

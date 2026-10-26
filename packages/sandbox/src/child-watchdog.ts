// The child's memory watchdog (`child-memory.ts`): a thread of its own that measures the process's memory every
// millisecond while a call runs, and stops the child once it grew past the backstop, even while the calls' code never
// yields. Idle, it sleeps until a call starts.
import { BACKSTOP_BYTES, PEAK, processMemory, RUNNING, STARTS, TICK, trip, WATCH_EVERY_MS } from "./child-memory.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<SharedArrayBuffer>) => {
  const cells = new Int32Array(e.data);
  postMessage("watching");
  let starts = -1;
  let base = processMemory();
  for (;;) {
    if (Atomics.load(cells, RUNNING) === 0) {
      Atomics.wait(cells, RUNNING, 0);
      continue;
    }
    const now = processMemory();
    const started = Atomics.load(cells, STARTS);
    if (started !== starts) {
      // The calls running started since the last measure: theirs starts here.
      starts = started;
      base = now;
    }
    const grown = Math.max(now.resident - base.resident, now.committed - base.committed);
    if (grown > BACKSTOP_BYTES * Math.max(1, Atomics.load(cells, PEAK))) trip(cells);
    Atomics.wait(cells, TICK, 0, WATCH_EVERY_MS);
  }
};

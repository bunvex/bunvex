// The child's memory watchdog (`child-memory.ts`): a thread of its own that measures the process's memory every
// millisecond while a call runs, and stops the child once it grew past the backstop, even while the calls' code never
// yields. Idle, it sleeps until a call starts.
import {
  BACKSTOP_BYTES,
  BASE_COMMITTED,
  BASE_RESIDENT,
  PEAK,
  processMemory,
  RUNNING,
  TICK,
  trip,
  WATCH_EVERY_MS,
} from "./child-memory.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<SharedArrayBuffer>) => {
  const cells = new Int32Array(e.data);
  postMessage("watching");
  for (;;) {
    if (Atomics.load(cells, RUNNING) === 0) {
      Atomics.wait(cells, RUNNING, 0);
      continue;
    }
    const now = processMemory();
    // Measured from when the calls started (the thread that started them took it).
    const grown = Math.max(
      now.resident / 1024 - Atomics.load(cells, BASE_RESIDENT),
      now.committed / 1024 - Atomics.load(cells, BASE_COMMITTED),
    );
    if (grown > (BACKSTOP_BYTES / 1024) * Math.max(1, Atomics.load(cells, PEAK))) trip(cells);
    Atomics.wait(cells, TICK, 0, WATCH_EVERY_MS);
  }
};

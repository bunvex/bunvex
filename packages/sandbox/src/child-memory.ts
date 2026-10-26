// The memory cap of a child's calls (STUDY-188 R12, DV-553). Convex runs each function in an isolate whose heap may
// hold 64 MiB of the app's (`ISOLATE_MAX_USER_HEAP_SIZE`) plus 32 MiB (`ISOLATE_MAX_HEAP_EXTRA_SIZE`), and whose array
// buffers may hold 64 MiB (`ISOLATE_MAX_ARRAY_BUFFER_TOTAL_SIZE`; crates/common/src/knobs.rs,
// `crates/isolate/src/array_buffer_allocator.rs`), and terminates one past either: the function fails, whatever it
// catches, with "JavaScript execution ran out of memory (maximum memory usage: 64 MB)" (`crates/isolate/src/
// termination.rs`).
//
// JavaScriptCore has no such limit (Bun 1.4.4: `gcMaxHeapSize`, `maxHeapSizeAsRAMSizeMultiple` and `forceRAMSize` only
// steer its collector, and a heap grows past them), and nothing stops a function's code from inside the thread that
// runs it. So the child measures its own memory and dies past the cap, which no code of the app's can catch:
//
// - **The cap**, in the thread that runs the calls, as the engine counts (`process.memoryUsage()`, about 4 µs): its
//   `ArrayBuffer`s past 64 MiB more than when the calls started (Convex's array buffers, counted until collected as
//   Convex's allocator counts them); or its heap past 96 MiB more, once a full collection has freed what it could, as V8
//   collects before it gives up (Convex's heap). It is measured before the messages the child sends for its calls (the
//   first, then at most once a millisecond) and always as a call answers, so no call answers past it. The engine's
//   count of its heap leaves out what it was not told of (a typed array made without an `ArrayBuffer`, most strings'
//   bytes, measured): those only the backstop sees.
// - **The backstop**, for code that never yields and memory the engine does not count: a watchdog thread
//   (`child-watchdog.ts`, a `Worker`) cannot read the engine's counts (they are the calling thread's), so it reads the
//   process's (`bun:jsc`'s `memoryUsage()`, resident and committed memory) every millisecond while a call runs, and
//   stops the child once they grew 256 MiB. They count garbage not yet collected and memory the allocator keeps once
//   freed (measured: past 128 MiB for a call that holds a few MiB), so they cannot be the cap itself.
// - **Per call**: the calls a child runs at once share it (one child per code version, STUDY-171 §8.6): each limit is
//   multiplied by the most calls that ran at once since the child was last idle, measured from then.
// - **Past either**: the child writes one byte on its memory channel (fd 4) and kills itself (SIGKILL). The host reads
//   the byte once the child exited, and fails every call that was running in it with Convex's message (`host.ts`, reason
//   `oom`); the next call starts a new child, as after any death.
//
// How this differs from Convex's cap, measured, is STUDY-188 §X17b's.
import { memoryUsage } from "bun:jsc";
import { writeSync } from "node:fs";
import { join } from "node:path";

const MiB = 1024 * 1024;
/** Convex's heap: 64 MiB of the app's, plus 32 MiB. */
export const HEAP_CAP_BYTES = (64 + 32) * MiB;
/** Convex's array buffers. */
export const ARRAY_BUFFER_CAP_BYTES = 64 * MiB;
/** The engine's own count of a buffer's bytes runs a little over them (96 bytes for a 64 MiB `ArrayBuffer`). */
const ENGINE_SLACK_BYTES = 64 * 1024;
/** How much the process's memory may grow under code that never yields, before the watchdog stops it. */
export const BACKSTOP_BYTES = 256 * MiB;
/** The child's memory channel: one byte on it says the child stopped itself past the cap (`host.ts`). */
export const MEMORY_CHANNEL = 4;
/** How often the watchdog measures while a call runs, and the child at most before its messages. */
export const WATCH_EVERY_MS = 1;
const CHECK_EVERY_MS = 1;

/** The shared cells (an `Int32Array`): how many calls run, the most that ran since the child was last idle, … */
export const RUNNING = 0;
export const PEAK = 1;
/**
 * … the process's resident and committed memory then, in KiB (taken by the thread that starts the calls: a watchdog
 * that measured it as it woke would miss what the calls allocated before it ran, seen on Linux), …
 */
export const BASE_RESIDENT = 2;
export const BASE_COMMITTED = 3;
/** … and whether the child is stopping. */
const TRIPPED = 4;
/** A cell nothing changes: the watchdog sleeps on it between measures. */
export const TICK = 5;
const CELLS = 6;

/**
 * Past the cap: says so on the memory channel, and kills the child. Whichever thread saw it second waits for the death
 * instead of going on: the calling thread would otherwise send the host what the call does next (an operation the host
 * would then count as left unawaited, seen on Linux).
 */
export function trip(cells: Int32Array): void {
  if (Atomics.compareExchange(cells, TRIPPED, 0, 1) === 0) {
    try {
      writeSync(MEMORY_CHANNEL, "m");
    } catch {}
    process.kill(process.pid, "SIGKILL");
  }
  for (;;) Atomics.wait(cells, TICK, 0);
}

/** The process's memory as its allocator counts it, in bytes: resident, and committed (written or not). */
export function processMemory(): { resident: number; committed: number } {
  const u = memoryUsage();
  return { resident: u.current, committed: u.currentCommit };
}

/** The cells shared with the watchdog, once it runs. */
let cells: Int32Array | null = null;
/** The engine's counts when the calls running started. */
let startHeap = 0;
let startArrayBuffers = 0;
/** When the calls' memory was last measured in this thread. */
let lastCheck = Number.NEGATIVE_INFINITY;

/** Starts the watchdog thread; resolves once it watches. */
export async function startMemoryGuard(): Promise<void> {
  const shared = new Int32Array(new SharedArrayBuffer(CELLS * Int32Array.BYTES_PER_ELEMENT));
  const watchdog = new Worker(join(import.meta.dir, "child-watchdog.ts"));
  watchdog.unref();
  await new Promise<void>((resolve, reject) => {
    watchdog.onmessage = () => resolve();
    watchdog.onerror = (e) => reject(new Error(`the memory watchdog did not start: ${e.message}`));
    watchdog.postMessage(shared.buffer);
  });
  cells = shared;
}

/** `n` calls run now (`rejections.ts`, as calls start and answer). */
export function callsRunning(n: number): void {
  if (!cells) return;
  const before = Atomics.load(cells, RUNNING);
  if (before === 0 && n > 0) {
    // The child was idle: the calls' memory is measured from now.
    const u = process.memoryUsage();
    startHeap = u.heapUsed;
    startArrayBuffers = u.arrayBuffers;
    lastCheck = Number.NEGATIVE_INFINITY;
    const p = processMemory();
    Atomics.store(cells, BASE_RESIDENT, Math.floor(p.resident / 1024));
    Atomics.store(cells, BASE_COMMITTED, Math.floor(p.committed / 1024));
    Atomics.store(cells, PEAK, n);
  } else if (n > Atomics.load(cells, PEAK)) Atomics.store(cells, PEAK, n);
  Atomics.store(cells, RUNNING, n);
  if (before === 0 && n > 0) Atomics.notify(cells, RUNNING);
}

/**
 * Before a message of a call's (the first since the calls started, then at most once a millisecond: a measure costs
 * about 4 µs in a child), and always as a call answers (`answering`): past the cap, the child dies instead. The array
 * buffers made since the calls started count until the collector frees them, as Convex's allocator counts them; the
 * heap is collected first once it looks past its cap, as V8 collects before it gives up, so garbage alone never fails
 * a call.
 */
export function checkMemory(answering: boolean): void {
  if (!cells || Atomics.load(cells, RUNNING) === 0) return;
  const now = performance.now();
  if (!answering && now - lastCheck < CHECK_EVERY_MS) return;
  lastCheck = now;
  const calls = Math.max(1, Atomics.load(cells, PEAK));
  let u = process.memoryUsage();
  if (u.arrayBuffers - startArrayBuffers > ARRAY_BUFFER_CAP_BYTES * calls + ENGINE_SLACK_BYTES) {
    trip(cells);
    return;
  }
  if (u.heapUsed - startHeap <= HEAP_CAP_BYTES * calls) return;
  Bun.gc(true);
  u = process.memoryUsage();
  if (u.heapUsed - startHeap > HEAP_CAP_BYTES * calls) trip(cells);
}

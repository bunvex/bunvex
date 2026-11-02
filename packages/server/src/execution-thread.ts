// The execution worker's side of its protocol with the main thread (STUDY-194 §4.3, §4.12; the main thread's side
// is `execution-workers.ts`). A worker module calls `serveExecutionThread` with what it does at `init` and for each
// call; this runs the messages:
//
//   main → worker   [SharedArrayBuffer, init text]   once, first
//                   `c<id>:<request text>`           a call
//                   `a<id>:<text>`, `A<id>:<message>` the answer to an op, or its failure
//                   `x`                               close: finish, close the store, end
//                   any other                         the worker module's (`message`): code, metadata, commits
//   worker → main   `r`                               ready (init succeeded)
//                   `f<message>`                      failed (init threw); the main thread ends the worker
//                   `o<id>:<outcome text>`            a call's outcome
//                   `e<id>:<message>`                 a call that failed in the worker itself (a system error)
//                   `q<id>:<text>`                    an op: what only the main thread can answer (`ask`)
//
// Messages that come while `init` runs wait for it, in order: the main thread may send state (commits) to a worker
// that is still starting.
//
// The shared buffer is how the main thread tells a worker that runs JavaScript that never yields (`for (;;) {}`)
// from one that is busy: slot 0 counts progress, slot 1 holds the id of the call that last ran. The worker adds to
// slot 0 each time a call starts or resumes (`running`), and from a timer while it has calls, which fires only when
// its event loop is free. A message would not do: a query whose store reads are synchronous resumes on microtasks,
// and never lets a timer fire until it ends.

declare const self: Worker;

/** What a worker module does: open what it needs from the init text, then answer each call with its outcome. */
export type ExecutionThread = {
  /** Opens the worker's store and state from the main thread's init text. Throwing fails the worker's start. */
  init(text: string): void | Promise<void>;
  /** Runs one call: the request's text in, the outcome's text out. */
  call(id: number, text: string): Promise<string>;
  /** Any other message of the main thread's, in order (code versions, metadata, commits). */
  message?(text: string): void;
  /** Closes what `init` opened, before the worker ends. */
  close?(): void | Promise<void>;
};

const asked = new Map<number, { resolve: (text: string) => void; reject: (e: Error) => void }>();
let nextOp = 1;

/** Asks the main thread an op (a table count, a search): its answer's text. */
export function ask(text: string): Promise<string> {
  const id = nextOp++;
  return new Promise((resolve, reject) => {
    asked.set(id, { resolve, reject });
    self.postMessage(`q${id}:${text}`);
  });
}

/** Slot 0: progress; slot 1: the call that ran last. */
let shared: Int32Array | null = null;

/** How often an idle event loop shows progress while calls are in flight. */
const TICK_MS = 10;

/** Marks progress, by call `id`: call it when a call's JavaScript starts or resumes. */
export function running(id: number) {
  if (!shared) return;
  Atomics.add(shared, 0, 1);
  Atomics.store(shared, 1, id);
}

/** Runs this worker's side of the protocol with `thread`. */
export function serveExecutionThread(thread: ExecutionThread) {
  let inFlight = 0;
  let tick: ReturnType<typeof setInterval> | null = null;

  const run = async (id: number, text: string) => {
    if (inFlight++ === 0) tick = setInterval(() => shared && Atomics.add(shared, 0, 1), TICK_MS);
    running(id);
    try {
      self.postMessage(`o${id}:${await thread.call(id, text)}`);
    } catch (e) {
      self.postMessage(`e${id}:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (--inFlight === 0 && tick) {
        clearInterval(tick);
        tick = null;
      }
    }
  };

  /** Messages that came while `init` ran, run once it is done. */
  let waiting: string[] | null = null;
  const handle = async (m: string) => {
    const head = m[0];
    if (head === "a" || head === "A") {
      const colon = m.indexOf(":");
      const id = Number(m.slice(1, colon));
      const p = asked.get(id);
      if (!p) return;
      asked.delete(id);
      if (head === "a") p.resolve(m.slice(colon + 1));
      else p.reject(new Error(m.slice(colon + 1)));
      return;
    }
    if (head === "c") {
      const colon = m.indexOf(":");
      void run(Number(m.slice(1, colon)), m.slice(colon + 1));
      return;
    }
    if (m === "x") {
      await thread.close?.();
      process.exit(0);
    }
    thread.message?.(m);
  };

  self.onmessage = async (e: MessageEvent<string | [SharedArrayBuffer, string]>) => {
    const m = e.data;
    if (typeof m !== "string") {
      shared = new Int32Array(m[0]);
      waiting = [];
      try {
        await thread.init(m[1]);
      } catch (err) {
        self.postMessage(`f${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      const queued = waiting;
      waiting = null;
      for (const q of queued) await handle(q);
      self.postMessage("r");
      return;
    }
    if (waiting) waiting.push(m);
    else await handle(m);
  };
}

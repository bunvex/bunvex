// The execution workers (STUDY-194 §4.12, §4.13; STUDY-190 PR 2): Bun Workers that run calls off the main thread,
// started lazily up to a cap (`MAX_ISOLATE_WORKERS`, by default the core count: DV-574; 0 runs everything in-thread:
// AD-47). The main thread keeps the permits; a call goes to the ready worker with the fewest calls in flight, and
// another worker is started when every ready one has at least one. A call made while no worker is ready runs
// in-thread (`call` answers null), as the first calls after a start do (§10.4). The worker's side is
// `execution-thread.ts`, which documents the messages.
//
// Failures (Q3, owner 2026-10-26: replace, as Convex recreates an isolate and fails its request):
// - a worker that ends (an uncaught error ends a Bun Worker) fails its calls as system errors and is never used
//   again; the next call starts another. Nothing durable is in doubt: a mutation commits on the main thread.
// - a worker that shows no progress (its shared counter) for longer than the longest user time limit of its calls,
//   plus `BACKSTOP_SLACK_MS`, runs JavaScript that never yields: it is terminated, its running call fails with the
//   user time limit's message (Convex's timeout), its others as system errors.
// - a worker that fails its start, or does not answer it, is ended and logged (once a minute); the pool waits before
//   starting another, longer each time.
import { availableParallelism } from "node:os";
import { formatDuration, type KnobEnv, knob, threadEntry, timerDelay } from "@bunvex/core";

// Convex's knob (crates/common/src/knobs.rs), default 300 isolate threads; bunvex's default is the core count
// (DV-574), and 0 runs every call in-thread (AD-47).
/** The execution workers' cap from `MAX_ISOLATE_WORKERS`: by default the machine's core count; 0 starts none. */
export function maxExecutionWorkers(env: KnobEnv = process.env): number {
  return knob("MAX_ISOLATE_WORKERS", availableParallelism(), "uint", env);
}

/** The execution worker module bunvex ships. */
export const EXECUTION_WORKER_ENTRY = threadEntry(import.meta.url, "server/src", "execution-worker.ts");

// STUDY-171 §8.5's backstop slack, as the `process` sandbox's (STUDY-168 §13.1).
const SLACK_MS = 50;
/** How often the watchdog looks at the workers with calls in flight. */
const CHECK_MS = 25;
/** How long a worker may take to open its store and answer its start. */
const START_TIMEOUT_MS = 30_000;
/** How long `close` waits for a worker to close its store and end before terminating it. */
const CLOSE_WAIT_MS = 5_000;
/** The wait before starting a worker again after one failed its start: doubled each time, up to the maximum. */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A failed start is logged at most once per this long. */
const LOG_EVERY_MS = 60_000;

/** Why a call on an execution worker failed in the worker runtime, not in the function. */
export type ExecutionWorkerFailure = "timeout" | "died" | "stuck" | "failed" | "closed";

/**
 * A call that an execution worker did not answer: its worker ended (`died`), was terminated for another call that
 * never yielded (`stuck`), failed the call itself (`failed`), or was closed (`closed`). All are system errors;
 * `timeout` is the call that never yielded, whose message is the user time limit's.
 */
export class ExecutionWorkerError extends Error {
  constructor(
    readonly reason: ExecutionWorkerFailure,
    message: string,
  ) {
    super(message);
    this.name = "ExecutionWorkerError";
  }
}

/** A Bun Worker: `ref` and `unref` are Bun's (the DOM's `Worker` type, which an app's typecheck may load, lacks them). */
type ThreadWorker = Worker & { ref(): void; unref(): void };

type Pending = { resolve: (outcome: string) => void; reject: (e: Error) => void; timeoutMs: number };

/** One worker as a call's preparation sees it: what to post to it first, and what was posted to it before. */
export type WorkerLink = {
  post(text: string): void;
  /** The preparation's own record of this worker (what it holds), kept while the worker lives. */
  readonly memo: Map<unknown, unknown>;
};

type Thread = WorkerLink & {
  worker: ThreadWorker;
  state: "starting" | "ready" | "gone";
  /** Slot 0: progress; slot 1: the call that ran last (`execution-thread.ts`). */
  shared: Int32Array;
  calls: Map<number, Pending>;
  /** Slot 0 when last looked at, and since when it has not moved. */
  seen: number;
  quietSince: number;
  /** The uncaught error the worker reported before ending, if any. */
  detail?: string;
  startTimer?: ReturnType<typeof setTimeout>;
};

export type ExecutionWorkersOptions = {
  /** The most workers to start (`maxExecutionWorkers()`); 0 starts none. */
  max: number;
  /** The worker module's URL (`EXECUTION_WORKER_ENTRY`). */
  entry?: string;
  /** The text each worker starts with: what it needs to open its store. */
  init: () => string;
  /** Where the pool's own lines go (a failed start, a worker ended): the server's log. */
  log?: (line: string) => void;
  /** How long a worker may take to answer its start (`START_TIMEOUT_MS`). */
  startTimeoutMs?: number;
  /** Answers a worker's op (`q`): what only the main thread holds. A rejection fails the op in the worker. */
  answer?: (text: string) => Promise<string>;
};

/** What the pool has done, for `/metrics`. */
export type ExecutionWorkerCounts = {
  started: number;
  failedStarts: number;
  died: number;
  stuck: number;
};

/** The execution workers of one server. */
export class ExecutionWorkers {
  private threads: Thread[] = [];
  private next = 1;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private retryAt = 0;
  private retryMs = RETRY_MS;
  private loggedAt = Number.NEGATIVE_INFINITY;
  private readonly entry: string;
  private readonly log: (line: string) => void;
  readonly counts: ExecutionWorkerCounts = { started: 0, failedStarts: 0, died: 0, stuck: 0 };

  constructor(private readonly options: ExecutionWorkersOptions) {
    this.entry = options.entry ?? EXECUTION_WORKER_ENTRY;
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** The workers started and not ended: starting or ready. */
  get size(): number {
    return this.threads.length;
  }

  /** The workers ready for calls. */
  get ready(): number {
    return this.threads.filter((t) => t.state === "ready").length;
  }

  /**
   * Sends a call's request text to the ready worker with the fewest calls in flight, and resolves with its outcome
   * text. `timeoutMs` is the call's user time limit: a worker that shows no progress for longer (plus a slack) is
   * stuck. Null when no worker is ready (the caller runs it in-thread); a worker may be starting for the next.
   */
  call(text: string, timeoutMs: number, prepare?: (w: WorkerLink) => void): Promise<string> | null {
    if (this.closed) return null;
    let best: Thread | null = null;
    for (const t of this.threads) if (t.state === "ready" && (!best || t.calls.size < best.calls.size)) best = t;
    if (!best || best.calls.size > 0) this.maybeStart();
    if (!best) return null;
    const t = best;
    const id = this.next++;
    if (t.calls.size === 0) {
      t.worker.ref();
      t.seen = Atomics.load(t.shared, 0);
      t.quietSince = performance.now();
    }
    this.watch();
    return new Promise((resolve, reject) => {
      t.calls.set(id, { resolve, reject, timeoutMs });
      try {
        prepare?.(t);
      } catch (e) {
        t.calls.delete(id);
        if (t.calls.size === 0) t.worker.unref();
        reject(e);
        return;
      }
      t.worker.postMessage(`c${id}:${text}`);
    });
  }

  /** Posts `text` to every worker, starting or ready: state each must hear in order (the commits). */
  broadcast(text: string) {
    for (const t of this.threads) t.worker.postMessage(text);
  }

  /** Starts a worker if none is starting, the cap allows one, and no failed start asks to wait. */
  private maybeStart() {
    if (this.threads.length >= this.options.max) return;
    if (this.threads.some((t) => t.state === "starting")) return;
    if (performance.now() < this.retryAt) return;
    this.start();
  }

  private start() {
    const worker = new Worker(this.entry) as ThreadWorker;
    worker.unref();
    const shared = new Int32Array(new SharedArrayBuffer(8));
    const t: Thread = {
      worker,
      state: "starting",
      shared,
      calls: new Map(),
      seen: 0,
      quietSince: 0,
      memo: new Map(),
      post: (text) => worker.postMessage(text),
    };
    this.threads.push(t);
    this.counts.started++;
    worker.onmessage = (e: MessageEvent<string>) => this.heard(t, e.data);
    worker.addEventListener("error", (e) => {
      t.detail ??= (e as ErrorEvent).message;
    });
    worker.addEventListener("close", (e) => this.ended(t, (e as CloseEvent).code));
    const startMs = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
    t.startTimer = setTimeout(() => this.startFailed(t, `no answer within ${startMs} ms`), timerDelay(startMs));
    (t.startTimer as { unref?: () => void }).unref?.();
    worker.postMessage([shared.buffer, this.options.init()]);
  }

  private heard(t: Thread, m: string) {
    if (t.state === "gone") return;
    const head = m[0];
    if (head === "o" || head === "e") {
      const colon = m.indexOf(":");
      const id = Number(m.slice(1, colon));
      const p = t.calls.get(id);
      if (!p) return this.malformed(t, `an answer to call ${id}, which it does not have`);
      t.calls.delete(id);
      if (t.calls.size === 0) t.worker.unref();
      if (head === "o") p.resolve(m.slice(colon + 1));
      else p.reject(new ExecutionWorkerError("failed", `the execution worker failed the call: ${m.slice(colon + 1)}`));
      return;
    }
    if (head === "q") {
      const colon = m.indexOf(":");
      const id = m.slice(1, colon);
      const answer = this.options.answer;
      if (!answer) return this.malformed(t, "an op, which this pool does not answer");
      answer(m.slice(colon + 1)).then(
        (a) => t.state !== "gone" && t.worker.postMessage(`a${id}:${a}`),
        (e) => t.state !== "gone" && t.worker.postMessage(`A${id}:${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    if (head === "r" && t.state === "starting") {
      clearTimeout(t.startTimer);
      t.state = "ready";
      this.retryMs = RETRY_MS;
      return;
    }
    if (head === "f" && t.state === "starting") return this.startFailed(t, m.slice(1));
    this.malformed(t, `a message it cannot use (${JSON.stringify(m.slice(0, 40))})`);
  }

  private startFailed(t: Thread, why: string) {
    if (t.state !== "starting") return;
    this.counts.failedStarts++;
    this.retryAt = performance.now() + this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    const now = performance.now();
    if (now - this.loggedAt >= LOG_EVERY_MS) {
      this.loggedAt = now;
      this.log(`An execution worker could not start: ${why}. Calls run on the main thread until one starts.`);
    }
    this.end(t, "failed", "the execution worker could not start");
  }

  private malformed(t: Thread, what: string) {
    this.log(`An execution worker sent ${what}; it is replaced.`);
    this.end(t, "died", "the execution worker running this call sent a message it cannot use");
  }

  /** The worker ended on its own: its calls fail, and it is replaced at the next call. */
  private ended(t: Thread, code: number) {
    if (t.state === "gone") return;
    if (this.closed) return this.end(t, "closed", "the server closed");
    if (t.state === "starting") {
      this.startFailed(t, `it ended (exit code ${code}${t.detail ? `: ${t.detail}` : ""})`);
      return;
    }
    this.counts.died++;
    this.log(`An execution worker ended (exit code ${code}${t.detail ? `: ${t.detail}` : ""}); it is replaced.`);
    this.end(
      t,
      "died",
      `the execution worker running this call ended (exit code ${code}${t.detail ? `: ${t.detail}` : ""})`,
    );
  }

  /** Forgets `t`, terminates it, and fails what it had in flight with `reason`. */
  private end(t: Thread, reason: ExecutionWorkerFailure, message: string, blame?: { id: number; error: Error }) {
    if (t.state === "gone") return;
    t.state = "gone";
    clearTimeout(t.startTimer);
    this.threads = this.threads.filter((x) => x !== t);
    t.worker.terminate();
    const calls = [...t.calls];
    t.calls.clear();
    for (const [id, p] of calls) p.reject(blame?.id === id ? blame.error : new ExecutionWorkerError(reason, message));
  }

  /** Runs the watchdog while any worker has calls in flight. */
  private watch() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.check(), CHECK_MS);
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  private check() {
    const now = performance.now();
    let busy = false;
    for (const t of [...this.threads]) {
      if (t.calls.size === 0) continue;
      busy = true;
      const progress = Atomics.load(t.shared, 0);
      if (progress !== t.seen) {
        t.seen = progress;
        t.quietSince = now;
        continue;
      }
      let limit = 0;
      for (const p of t.calls.values()) limit = Math.max(limit, p.timeoutMs);
      if (now - t.quietSince > limit + SLACK_MS) this.stuck(t);
    }
    if (!busy && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private stuck(t: Thread) {
    this.counts.stuck++;
    const id = Atomics.load(t.shared, 1);
    const p = t.calls.get(id);
    this.log(
      `An execution worker ran JavaScript that never yields${p ? ` (call ${id})` : ""}; it is terminated and replaced.`,
    );
    const blame = p
      ? {
          id,
          error: new ExecutionWorkerError(
            "timeout",
            `Function execution timed out (maximum duration: ${formatDuration(p.timeoutMs)})`,
          ),
        }
      : undefined;
    this.end(t, "stuck", "another call on the execution worker running this call never yielded", blame);
  }

  /**
   * Stops every worker: each closes its store and ends, or is terminated after `CLOSE_WAIT_MS`. Calls still in
   * flight then fail; later calls answer null.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await Promise.all(
      this.threads.map(
        (t) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.end(t, "closed", "the server closed");
              resolve();
            }, CLOSE_WAIT_MS);
            t.worker.addEventListener("close", () => {
              clearTimeout(timer);
              this.end(t, "closed", "the server closed");
              resolve();
            });
            t.worker.ref();
            t.worker.postMessage("x");
          }),
      ),
    );
  }
}

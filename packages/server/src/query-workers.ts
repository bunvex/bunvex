// Queries on execution workers (STUDY-194 2b, step iv): the main thread's side, which ties the pool
// (`execution-workers.ts`) to the engine and the code. A query whose code has sources goes to a worker when one is
// ready, preceded by what that worker lacks: the request's metadata epoch (the engine's) and its code epoch
// (`execution-code.ts`). Every commit's written keys go to every worker. The worker's module is
// `execution-worker.ts`.
//
// Workers start only where they can read the store themselves (`Persistence.reader`: a SQLite file, a Postgres or MySQL database), under the `vm`
// executor and the process's own clock; the server checks those (§10.4).
import { availableParallelism } from "node:os";
import type { CallOutcome, Engine, Persistence, StoreReader } from "@bunvex/core";
import { decodeCallOutcome, formatDuration, inExecutable, threadEntry, workerOutcomesChecked } from "@bunvex/core";
import { type CodeHeld, CodeShipper, newCodeHeld } from "./execution-code.ts";
import { ExecutionWorkerError, ExecutionWorkers } from "./execution-workers.ts";
import { type CodeSources, checkDeadline, type Deadline, type Functions } from "./functions.ts";

/** What a worker starts from: the store to read, the engine's identity and visible ts, the server's settings. */
export type QueryWorkerInit = {
  store: StoreReader;
  cacheBytes: number;
  /** A database server's store: how many connections its pool opens at most. */
  connections: number;
  /** Its index cache's budget: the main thread's, shared by the workers. */
  indexCacheBytes: number;
  start: ReturnType<Engine["followerStart"]>;
  /**
   * Inside `bunvex-local-backend`, on a database server's store: the module that registers the drivers embedded
   * there (`@bunvex/persistence/executable`), which a worker imports before it opens the store. Null elsewhere: a
   * worker imports the drivers as the main thread does.
   */
  drivers: string | null;
  /** The file storage's origin, when the server has file storage (`ctx.storage.getUrl`). */
  filesOrigin: string | null;
  builtinEnv: Record<string, string>;
  userTimeoutMs: number;
  systemTimeoutMs: number;
};

// `scripts/build-binary.ts` embeds it as an entry point of its own; the main thread's `import.meta.url` is the
// executable's there, where `threadEntry` finds it (a worker's is its own module's).
const EMBEDDED_DRIVERS = threadEntry(import.meta.url, "persistence/src", "executable.ts");

/** How many code epochs a worker keeps: older ones are forgotten (a call naming one fails as a system error). */
const CODE_EPOCHS_KEPT = 4;
const CODE_HELD = Symbol("code held");

/** The code epochs a worker was sent, oldest first, and what it holds. */
type WorkerCodeMemo = { held: CodeHeld; order: number[] };

/**
 * Starts the query workers of a server: up to `max` (0: none), reading `persistence` through its reader. Null when it
 * has none.
 */
export function startQueryWorkers(o: {
  engine: Engine;
  functions: Functions;
  persistence: Persistence;
  max: number;
  filesOrigin: string | null;
  builtinEnv: Record<string, string>;
  log?: (line: string) => void;
  entry?: string;
}): ExecutionWorkers | null {
  const store = o.persistence.reader?.();
  if (!store || o.max <= 0) return null;
  const { engine, functions } = o;
  // Q6/Q8: a database server's connections are the deployment's, split between the main thread and the workers.
  const pooled = o.persistence as { connections?: number; setPoolSize?(n: number): void };
  let max = o.max;
  let connections = 0;
  if (pooled.connections !== undefined && pooled.setPoolSize) {
    const split = connectionSplit(pooled.connections, max, availableParallelism());
    if (!split) return null;
    pooled.setPoolSize(split.main);
    max = split.workers;
    connections = split.each;
  }
  // AD-46's page cache is the deployment's: the store's own connection keeps half, the workers share the rest.
  const cacheBytes = (o.persistence as { cacheBytes?: number }).cacheBytes ?? 0;
  const workerCache = Math.max(1, Math.floor(cacheBytes / 2 / max));
  (o.persistence as { setCacheBytes?(bytes: number): void }).setCacheBytes?.(Math.floor(cacheBytes / 2));
  const indexCacheBytes = Math.floor((engine.indexCache?.maxBytes ?? 0) / max);
  const pool = new ExecutionWorkers({
    max,
    ...(o.entry ? { entry: o.entry } : {}),
    ...(o.log ? { log: o.log } : {}),
    init: () =>
      JSON.stringify({
        store,
        cacheBytes: workerCache,
        connections,
        drivers: store.driver !== "sqlite" && inExecutable(import.meta.url) ? EMBEDDED_DRIVERS : null,
        indexCacheBytes,
        start: engine.followerStart(),
        filesOrigin: o.filesOrigin,
        builtinEnv: o.builtinEnv,
        userTimeoutMs: functions.userTimeoutMs,
        systemTimeoutMs: functions.systemTimeoutMs,
      } satisfies QueryWorkerInit),
    answer: async (text) => engine.answerOp(text),
  });
  engine.postCommits(
    (text) => pool.broadcast(text),
    () => pool.size > 0,
  );
  const shipper = new CodeShipper();
  functions.offloadQueries = true;
  engine.queryWorkers = {
    wants: (local) => (local as { code?: unknown } | undefined)?.code !== undefined && pool.readyOrStart(),
    run(text, local, prepare, inThread) {
      const { code, deadline } = (local ?? {}) as {
        code?: { epoch: number; sources: CodeSources };
        deadline?: Deadline;
      };
      if (!code) return null;
      // A WebSocket mutation's deadline is checked here, where the in-thread run checks it: before it runs, and once
      // its handler returned (its outcome came back), before the commit.
      try {
        checkDeadline(deadline);
      } catch (e) {
        return Promise.reject(e);
      }
      const timeoutMs = functions.userTimeoutMs;
      const sent = pool.call(`${code.epoch}:${text}`, timeoutMs, (w) => {
        prepare(w);
        let memo = w.memo.get(CODE_HELD) as WorkerCodeMemo | undefined;
        if (!memo) {
          memo = { held: newCodeHeld(), order: [] };
          w.memo.set(CODE_HELD, memo);
        }
        const messages = shipper.prepare(code.epoch, code.sources, memo.held);
        if (!messages) throw new Error("a code version that cannot be sent to an execution worker");
        if (messages.length) {
          memo.order.push(code.epoch);
          while (memo.order.length > CODE_EPOCHS_KEPT) {
            const f = shipper.forget(memo.order.shift()!, memo.held);
            if (f) messages.push(f);
          }
        }
        for (const m of messages) w.post(m);
      });
      if (!sent) return null;
      // The call that never yielded fails as the function's own timeout; the others as system errors.
      const answered = sent.then(
        (outcome) => {
          checkDeadline(deadline);
          return outcome;
        },
        (e) => {
          if (e instanceof ExecutionWorkerError && e.reason === "timeout")
            throw new Error(`Function execution timed out (maximum duration: ${formatDuration(timeoutMs)})`);
          throw e;
        },
      );
      if (!workerOutcomesChecked()) return answered;
      return answered.then(async (there) => {
        const mismatch = outcomeMismatch(await inThread(), there);
        if (mismatch) throw new Error(`an execution worker's outcome differs from the in-thread one: ${mismatch}`);
        return there;
      });
    },
  };
  return pool;
}

/**
 * How a pool of `total` connections is shared (STUDY-194 Q6, Q8): the main thread keeps a quarter, at least 8, for its
 * commits and the calls it runs; the workers share the rest, at least 2 each, so there are at most `max`, one per core
 * and half the rest. Null when no worker would get 2: the pool stays whole.
 */
export function connectionSplit(
  total: number,
  max: number,
  cores: number,
): { main: number; workers: number; each: number } | null {
  const main = Math.max(8, Math.floor(total / 4));
  const rest = total - main;
  const workers = Math.min(max, cores, Math.floor(rest / 2));
  if (workers <= 0) return null;
  return { main, workers, each: Math.floor(rest / workers) };
}

/**
 * Where a worker's outcome differs from the in-thread one for the same request, or null (STUDY-194 2b's differential
 * check): every field, the report's lines and figures included, but what measures time (the user time, each line's
 * timestamp) and the ids a mutation's inserts drew (random on each run): the worker's are read as the in-thread
 * run's, matched by the position of their document among the writes.
 */
export function outcomeMismatch(here: string, there: string): string | null {
  const view = (text: string) => {
    const o = decodeCallOutcome(text);
    const report =
      o.report === null
        ? null
        : (JSON.parse(o.report) as { lines: { timestamp?: number }[]; figures: { userMs?: unknown } | null });
    if (report) {
      for (const l of report.lines) delete l.timestamp;
      if (report.figures) delete report.figures.userMs;
    }
    return { ...o, id: 0, report, error: o.error === null ? null : hostPositionsOut(o.error) };
  };
  const a = view(here);
  const b = view(there);
  const drawn = drawnIds(a.writes, b.writes);
  const asInThread = (text: string) => {
    for (const [worker, inThread] of drawn) text = text.replaceAll(worker, inThread);
    return text;
  };
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const x = stringify(a[k]);
    const y = asInThread(stringify(b[k]));
    if (x === y) continue;
    const xs = a[k];
    const ys = b[k];
    if (Array.isArray(xs) && Array.isArray(ys)) {
      let i = 0;
      while (i < xs.length && i < ys.length && stringify(xs[i]) === asInThread(stringify(ys[i]))) i++;
      return `${k} [${i}] (of ${xs.length} in-thread, ${ys.length} on the worker): in-thread ${stringify(xs[i])}, worker ${stringify(ys[i])}`;
    }
    return `${k}: in-thread ${x.slice(0, 400)}, worker ${y.slice(0, 400)}`;
  }
  return null;
}

/**
 * The ids two runs of one mutation drew for the same inserted documents, as the worker's text and the in-thread one's:
 * the internal id, the document id, and the document id as an index key holds it (its characters, which `stringify`
 * shows in hex).
 */
function drawnIds(a: CallOutcome["writes"], b: CallOutcome["writes"]): [string, string][] {
  const out: [string, string][] = [];
  if (!a || !b) return out;
  for (let i = 0; i < a.docs.length && i < b.docs.length; i++) {
    const x = a.docs[i]!;
    const y = b.docs[i]!;
    if (x.id === y.id || x.json === null || y.json === null || a.olds[i] !== null || b.olds[i] !== null) continue;
    const xId = (JSON.parse(x.json) as { _id: string })._id;
    const yId = (JSON.parse(y.json) as { _id: string })._id;
    const hex = (id: string) => Buffer.from(id).toString("hex");
    out.push([y.id, x.id], [yId, xId], [hex(yId), hex(xId)]);
  }
  return out;
}

/** The fields the runtime gives an error thrown in the server's own code: where in that code it was thrown. */
const HOST_POSITIONS = new Set(["line", "column", "originalLine", "originalColumn", "sourceURL"]);

/**
 * An error's text without where in the server's code it was thrown: its position fields, and the line and column of
 * each frame of its stack in a server file (an absolute path). The server's modules are not the same code on both
 * sides when one is instrumented (`bun test --coverage` instruments the main thread's), and the position is not the
 * outcome's. The app's own frames (`app.js:12:79`) are kept.
 */
function hostPositionsOut(error: string): string {
  const out = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const fields = v.filter(
        (f) => !(Array.isArray(f) && f.length === 3 && typeof f[0] === "string" && HOST_POSITIONS.has(f[0])),
      );
      return fields.map((f) =>
        Array.isArray(f) && f.length === 3 && f[0] === "stack" && typeof f[1] === "string"
          ? [f[0], f[1].replace(/(\/[^\s():]+):\d+:\d+/g, "$1"), f[2]]
          : out(f),
      );
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, out(x)]));
    return v;
  };
  return JSON.stringify(out(JSON.parse(error)));
}

const stringify = (v: unknown) =>
  JSON.stringify(v, (_, x) =>
    typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x,
  ) ?? "undefined";

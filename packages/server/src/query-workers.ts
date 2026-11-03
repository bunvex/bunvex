// Queries on execution workers (STUDY-194 2b, step iv): the main thread's side, which ties the pool
// (`execution-workers.ts`) to the engine and the code. A query whose code has sources goes to a worker when one is
// ready, preceded by what that worker lacks: the request's metadata epoch (the engine's) and its code epoch
// (`execution-code.ts`). Every commit's written keys go to every worker. The worker's module is
// `execution-worker.ts`.
//
// Workers start only where they can read the store themselves (`Persistence.reader`: a SQLite file), under the `vm`
// executor and the process's own clock; the server checks those (§10.4).
import type { Engine, Persistence, StoreReader } from "@bunvex/core";
import { decodeCallOutcome, formatDuration, workerOutcomesChecked } from "@bunvex/core";
import { type CodeHeld, CodeShipper, newCodeHeld } from "./execution-code.ts";
import { ExecutionWorkerError, ExecutionWorkers } from "./execution-workers.ts";
import type { CodeSources, Functions } from "./functions.ts";

/** What a worker starts from: the store to read, the engine's identity and visible ts, the server's settings. */
export type QueryWorkerInit = {
  store: StoreReader;
  cacheBytes: number;
  /** Its index cache's budget: the main thread's, shared by the workers. */
  indexCacheBytes: number;
  start: ReturnType<Engine["followerStart"]>;
  /** The file storage's origin, when the server has file storage (`ctx.storage.getUrl`). */
  filesOrigin: string | null;
  builtinEnv: Record<string, string>;
  userTimeoutMs: number;
  systemTimeoutMs: number;
};

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
  // AD-46's page cache is the deployment's: the store's own connection keeps half, the workers share the rest.
  const cacheBytes = (o.persistence as { cacheBytes?: number }).cacheBytes ?? 0;
  const workerCache = Math.max(1, Math.floor(cacheBytes / 2 / o.max));
  (o.persistence as { setCacheBytes?(bytes: number): void }).setCacheBytes?.(Math.floor(cacheBytes / 2));
  const indexCacheBytes = Math.floor((engine.indexCache?.maxBytes ?? 0) / o.max);
  const pool = new ExecutionWorkers({
    max: o.max,
    ...(o.entry ? { entry: o.entry } : {}),
    ...(o.log ? { log: o.log } : {}),
    init: () =>
      JSON.stringify({
        store,
        cacheBytes: workerCache,
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
      const code = (local as { code?: { epoch: number; sources: CodeSources } } | undefined)?.code;
      if (!code) return null;
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
      const answered = sent.catch((e) => {
        if (e instanceof ExecutionWorkerError && e.reason === "timeout")
          throw new Error(`Function execution timed out (maximum duration: ${formatDuration(timeoutMs)})`);
        throw e;
      });
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
 * Where a worker's outcome differs from the in-thread one for the same request, or null (STUDY-194 2b's differential
 * check): every field, the report's lines and figures included, but what measures time (the user time, each line's
 * timestamp).
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
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    const x = stringify(a[k]);
    const y = stringify(b[k]);
    if (x === y) continue;
    const xs = a[k];
    const ys = b[k];
    if (Array.isArray(xs) && Array.isArray(ys)) {
      let i = 0;
      while (i < xs.length && i < ys.length && stringify(xs[i]) === stringify(ys[i])) i++;
      return `${k} [${i}] (of ${xs.length} in-thread, ${ys.length} on the worker): in-thread ${stringify(xs[i])}, worker ${stringify(ys[i])}`;
    }
    return `${k}: in-thread ${x.slice(0, 400)}, worker ${y.slice(0, 400)}`;
  }
  return null;
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

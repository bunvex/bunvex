// A query's or mutation's call in the child (STUDY-171 §8): the function's own handler, run as the `vm` executor
// runs it, with a `ctx` whose every operation is the host's.
//
// - **Determinism.** The call runs in an execution made from the host's (`executionFromClock`): the same frozen
//   time, `performance.now()` from the same start, its own seeded `Math.random` and `crypto.getRandomValues`
//   drawn on first use, timers and `fetch` refused, by core's own code (`determinism.ts`). A nested call of the
//   same host execution joins the same one, so a mutation and the query it runs share their clock and random
//   stream as under `vm`. What the host must know comes back with every message: whether the function read the
//   time (`ctx.meta.getSnapshotTs()`, `Date.now()`).
// - **User time** is counted here, by core's timer (`withUserTimer`), each operation's wait paused as a store call
//   is (`pausingUserTime`): the 1 s limit counts the function's JavaScript, not the round trips (STUDY-168 §13.1).
//   Its timeout and its refusals (a timer in a query) throw here, at the next operation or when the handler ends,
//   as under `vm`; each message reports the time run since the last (`ran`), which the host charges to its own
//   timer.
// - **`process.env`** reads the variables the call carries, after checking the name as the engine's reader does;
//   the names read are reported, and the host reads them on its transaction (the read set).
// - **Errors.** An operation's error is rebuilt here with its class, name and message, and remembered: if it
//   leaves the handler as it came, the host throws its own original. One the engine threw before its call returned
//   (a value that is not one, written) gets the frames of the app's call, as under `vm` it is thrown there.
// - **Logs** (STUDY-171 §11). The console is the server's own capture (`captureLines`): each line rendered, cut and
//   stamped here exactly as in-process, then sent with the call's next message, so the host logs it in order with
//   the operations around it (a nested call's lines after the ones before it). `log.audit` is an operation: the
//   host holds the lines, shared with the nested calls, and checks their limits.
import { AsyncLocalStorage } from "node:async_hooks";
import {
  checkEnvVarName,
  checkUserTime,
  type ExecutionClock,
  executionFromClock,
  newUserTimer,
  observeTime,
  pausingUserTime,
  runInExecution,
  type UserTimer,
  userTimeMs,
  withUserTimer,
} from "@bunvex/core";
import {
  appContext,
  type CodeVersion,
  captureLines,
  inHandleScope,
  type LogLine,
  MAX_LOG_LINES,
  setAuditScope,
  withEnv,
} from "@bunvex/server/executor";
import { BunvexError, isBunvexError } from "@bunvex/values";
import { type DbHost, QueryImpl, readerOf, Tx, VirtualQuery } from "./child-db.ts";
import {
  EPOCHS_KEPT,
  type ToHost,
  type WireCall,
  type WireLink,
  type WireLogLine,
  type WireReply,
  type WireReport,
  type WireTable,
  type WireThrown,
} from "./protocol.ts";
import { checkpoint, checkpointOf, drain, type Rejectable, track, untrack } from "./rejections.ts";
import { decode, encode } from "./wire.ts";

export type Send = (m: ToHost) => void;

/** The call whose handler runs (a query's, a mutation's or an action's): its `log.audit` lines go to the host. */
export const running = new AsyncLocalStorage<ChildCallBase>();
setAuditScope(() => {
  const call = running.getStore();
  // An action has no audit lines (null), as in-process: `log.audit` refuses there with the server's own words.
  if (call && !(call instanceof ChildCall)) return null;
  return call ? (json: string) => call.op("log.audit", [json]).then(() => {}) : undefined;
});

/** What a child keeps between calls: the catalogs and variables by epoch, the executions by the host's id. */
export class CallRuntime {
  private readonly catalogs = new Map<number, Map<string, WireTable>>();
  private readonly envs = new Map<number, Map<string, string>>();
  private readonly executions = new Map<number, { execution: object; observed: { time: boolean }; calls: number }>();
  private readonly calls = new Map<number, ChildCall>();

  constructor(
    private readonly send: Send,
    private readonly versions: Map<number, CodeVersion>,
  ) {}

  /** A call from the host: run it, and answer with `done`. */
  async call(m: WireCall) {
    // The last `EPOCHS_KEPT` of each, as the host counts them (`host-call.ts`, `EpochWindow`): it sends again one
    // that fell out.
    if (m.catalog.tables) {
      this.catalogs.set(m.catalog.epoch, new Map(m.catalog.tables.map((t) => [t.name, t])));
      if (this.catalogs.size > EPOCHS_KEPT) this.catalogs.delete(this.catalogs.keys().next().value!);
    }
    if (m.env?.vars) {
      this.envs.set(m.env.epoch, new Map(m.env.vars));
      if (this.envs.size > EPOCHS_KEPT) this.envs.delete(this.envs.keys().next().value!);
    }
    let exec = this.executions.get(m.exec.id);
    if (!exec) {
      const observed = { time: false };
      exec = { execution: executionFromClock(m.exec as ExecutionClock, observed), observed, calls: 0 };
      this.executions.set(m.exec.id, exec);
    }
    exec.calls++;
    const theExec = exec;
    // Once: when the handler settles, or when an unhandled rejection ends the call first (its code then waits
    // forever, and its `run` never settles).
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      // The answers to operations it did not await still reach it, and are dropped once it was failed.
      call.whenAnswered(() => this.calls.delete(m.id));
      if (--theExec.calls === 0) this.executions.delete(m.exec.id);
    };
    const call = new ChildCall(m, this.send, this.catalogs.get(m.catalog.epoch)!, exec.observed, end);
    this.calls.set(m.id, call);
    try {
      const version = this.versions.get(m.version);
      const handler = version ? handlerOf(version, m.fn) : null;
      if (!handler) throw new Error(`the function ${m.fn} is not a query or mutation of this version`);
      const env = m.env ? this.envs.get(m.env.epoch)! : null;
      await call.run(handler, env, exec.execution);
    } finally {
      end();
    }
  }

  /** The host's answer to an operation; one for a call that has ended is dropped. */
  reply(m: WireReply) {
    this.calls.get(m.id)?.reply(m);
  }
}

/**
 * What a call names: a query or mutation (`dir/file:name`), or a room's gate (`dir/file:name#canJoin`, AD-42), run
 * as a query.
 */
function handlerOf(version: CodeVersion, fn: string): ((ctx: unknown, args: unknown) => unknown) | null {
  const gate = /^(.*)#(canJoin|canPublish)$/.exec(fn);
  if (gate) {
    const def = version.rooms.get(gate[1]!) as Record<string, unknown> | undefined;
    const g = def?.[gate[2]!];
    return typeof g === "function" ? (ctx, args) => (g as (c: unknown, a: unknown) => unknown)(ctx, args) : null;
  }
  const f = version.functions.get(fn);
  if (!f || (f.kind !== "query" && f.kind !== "mutation")) return null;
  return f.handler as (ctx: unknown, args: unknown) => unknown;
}

/** The error classes an operation's error is rebuilt with (the engine's are these, or `BunvexError`). */
const ERRORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
};

/** Which call's operation an error came from, and which operation. */
const fromOp = new WeakMap<object, { call: number; op: number }>();

const stackOf = (e: Error): string | null => {
  try {
    const s = e.stack;
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
};

/**
 * What a call of either kind (`ChildCall`, `ChildActionCall`) does with its operations: each sent to the host with
 * what the call reported since its last message, its answer awaited, its error made again with the engine's class
 * and words; and how a thrown value leaves the handler.
 */
export abstract class ChildCallBase implements Rejectable {
  private seq = 0;
  /**
   * Set once an unhandled rejection failed the call (`unhandled`): it has answered, and its code is left waiting
   * forever at its next operation, as Convex's terminated context runs no more of it.
   */
  protected terminated = false;
  protected readonly waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; site: Error }
  >();
  private answered: (() => void) | null = null;

  constructor(
    readonly id: number,
    protected readonly send: Send,
  ) {}

  /** What the host charges, records and logs since the last message. */
  protected abstract report(): WireReport;

  /** The app left `reason` rejected with no handler once its microtasks drained (`rejections.ts`). */
  abstract unhandled(reason: unknown): void;

  /** A checkpoint of this call ended (`rejections.ts`). */
  abstract checkpointed(): void;

  /** Before an operation: a query's or mutation's budget checked. */
  protected before() {}

  /** Around an operation's wait: a query's or mutation's paused, its budget checked after. */
  protected around<T>(wait: () => Promise<T>): Promise<T> {
    return wait();
  }

  /** The frames of an error the engine made at the app's call: where the app called (or made a chain's link). */
  protected siteOf(m: WireReply & { ok: false }, opSite: Error): Error | null {
    return m.sync ? opSite : null;
  }

  /** Runs `then` once no operation of the call waits for its answer. */
  whenAnswered(then: () => void) {
    if (this.waiting.size === 0) then();
    else this.answered = then;
  }

  /** An operation, run by the host: its answer, or its error made again with the engine's class and words. */
  op(name: string, args: unknown[]): Promise<unknown> {
    if (this.terminated) return new Promise<never>(() => {});
    this.before();
    // Where the app called it, for an error the engine throws at once (a stack is cheap to take: about 0.1 µs).
    const site = new Error();
    // Serialized here, at the call, as the engine copies what it is given (a getter's throw is the app's).
    const encoded = args.map(encode);
    const op = ++this.seq;
    return this.around(
      () =>
        new Promise<unknown>((resolve, reject) => {
          this.waiting.set(op, { resolve, reject, site });
          this.sendOp(op, name, encoded);
        }),
    );
  }

  /** Sends operation `op` (an action cut off sends nothing). */
  protected sendOp(op: number, name: string, args: unknown[]) {
    this.send({ t: "op", id: this.id, op, name, args, report: this.report() });
  }

  /** What the reply's value stands for (an action's `fetch` and `storage.get` make a `Response` and a `Blob`). */
  protected value(_op: number, v: unknown): unknown {
    return v;
  }

  reply(m: WireReply) {
    const w = this.waiting.get(m.op);
    if (!w) return;
    this.waiting.delete(m.op);
    if (this.terminated) {
      // Its code runs no more: the answer is not given to it.
      if (this.waiting.size === 0 && this.answered) this.answered();
      return;
    }
    this.replied(m);
    if (m.ok) {
      try {
        w.resolve(this.value(m.op, decode(m.value, false)));
      } catch (e) {
        w.reject(e);
      }
    } else {
      const e = this.rebuilt(m.error, m.op);
      // Thrown at the app's call under `vm`: the error holds the frames of that call (or of the link that failed),
      // which the app's context maps (`installAppErrors`), and no `at async` frame.
      const site = this.siteOf(m, w.site);
      if (site && e instanceof Error) {
        const stack = stackOf(site) ?? "";
        const frames = stack.includes("\n") ? stack.slice(stack.indexOf("\n")) : "";
        const header = e.message ? `${e.name}: ${e.message}` : e.name;
        Object.defineProperty(e, "stack", { value: header + frames, writable: true, configurable: true });
      }
      w.reject(e);
    }
    if (this.waiting.size === 0 && this.answered) this.answered();
  }

  /** What else a reply tells the call (the transaction's created tables). */
  protected replied(_m: WireReply) {}

  /** An operation's error as the app sees it: the engine's class and words. */
  protected rebuilt(w: WireThrown, op: number): unknown {
    if (w.k === "value") return decode(w.v, false);
    if (w.k !== "error") return new Error("the host answered with an error the child cannot read");
    const e = rebuiltError(w);
    fromOp.set(e, { call: this.id, op });
    return e;
  }

  /**
   * How a value rejected with no handler fails the call: as a thrown one, except that an application error is a plain
   * error, its data gone. Convex's runtime marks an application error as one where the handler's throw leaves it
   * (`serializeConvexErrorData`, npm-packages/convex/src/server/impl/registration_impl.ts), which a rejection nothing
   * handled never passes: the isolate sees an error like any other (`extract_source_mapped_error`, error.rs).
   */
  protected rejected(e: unknown): WireThrown {
    const w = this.thrown(e);
    if (w.k === "op" && isBunvexError(e)) return plain(thrownValue(e));
    return plain(w);
  }

  /** How a thrown value leaves the handler. */
  protected thrown(e: unknown): WireThrown {
    if (e !== null && typeof e === "object") {
      const origin = fromOp.get(e);
      if (origin?.call === this.id) return { k: "op", op: origin.op, stack: stackOf(e as Error) };
    }
    return thrownValue(e);
  }
}

/** `w` with an application error made a plain one: its class and name, its message, no data. */
function plain(w: WireThrown): WireThrown {
  if (w.k !== "error" || !w.bunvex) return w;
  const { data: _data, ...rest } = w;
  return { ...rest, bunvex: false };
}

/** An error the host described, made again here with its class (the engine's, a `DOMException`, a `BunvexError`). */
export function rebuiltError(w: Extract<WireThrown, { k: "error" }>): Error {
  let e: Error;
  if (w.bunvex) {
    e = new BunvexError(decode(w.data ?? null, false) as never);
    Object.defineProperty(e, "message", { value: w.message, writable: true, configurable: true });
  } else if (w.cls === "DOMException") e = new DOMException(w.message, w.name);
  else e = new (ERRORS[w.cls] ?? Error)(w.message);
  if (e.name !== w.name) Object.defineProperty(e, "name", { value: w.name, writable: true, configurable: true });
  return e;
}

/** A thrown value for the host: an error with its class, name, message, stack and a `BunvexError`'s data. */
export function thrownValue(e: unknown): WireThrown {
  const isError = e instanceof Error || Object.prototype.toString.call(e) === "[object Error]";
  if (!isError) return { k: "value", v: encode(e) };
  const err = e as Error;
  const bunvex = isBunvexError(err);
  return {
    k: "error",
    cls: Object.getPrototypeOf(err)?.constructor?.name ?? "Error",
    name: String(err.name),
    message: String(err.message),
    stack: stackOf(err),
    bunvex,
    ...(bunvex ? { data: encode((err as BunvexError<never>).data) } : {}),
  };
}

/** What a query's or mutation's `done` says: its value, or what it threw. */
type Outcome = { ok: true; value: unknown } | { ok: false; error: WireThrown };

/** Convex's `MAX_SYSCALL_BATCH_SIZE` (crates/common/src/knobs.rs): the most syscalls one batch runs. */
const MAX_BATCH = 16;

/**
 * Which batch of Convex's an operation joins (`AsyncSyscallBatch`, environment/udf/async_syscall.rs): reads
 * (`1.0/get`, `1.0/queryStreamNext`) together, `1.0/storageGetUrl`s together, every other one alone (null).
 */
function batchOf(name: string, args: unknown[]): "read" | "url" | null {
  if (name === "db.get" || name === "db.system.get" || name === "db.query" || name === "db.next") return "read";
  if (name === "storage" && args[0] === "getUrl") return "url";
  return null;
}

/** An operation in flight, in the order the app started it, and its answer once it came. */
type InFlight = { op: number; batch: "read" | "url" | null; answer?: WireReply };

class ChildCall extends ChildCallBase implements DbHost {
  /** Where the app made each link of its chains: an error the engine throws making one is thrown there. */
  private readonly linkSites = new Map<number, Error>();
  private readonly lines: WireLogLine[] = [];
  private logged = 0;
  private created: Map<string, WireTable>;
  /** Each read, in order: the engine records an interval per read, the same name's included. */
  private readonly envReads: string[] = [];
  private readonly links: WireLink[] = [];
  private nextLink = 0;
  private reported = 0;
  private timer!: UserTimer;
  /** The call's answer once its handler settled, sent when no operation of it waits (`checkpointed`). */
  private outcome: Outcome | null = null;
  /** Its operations in flight, in the order it started them; the batch whose answers it waits for. */
  private readonly fifo: InFlight[] = [];
  private batch: InFlight[] | null = null;
  private answeredHost = false;
  readonly snapshot: bigint;

  constructor(
    private readonly m: WireCall,
    send: Send,
    private readonly catalog: Map<string, WireTable>,
    private readonly observed: { time: boolean },
    private readonly end: () => void,
  ) {
    super(m.id, send);
    this.snapshot = BigInt(m.snapshot);
    this.created = new Map(m.created.map((t) => [t.name, t]));
    track(m.id, this);
  }

  /**
   * The handler settled: the answer waits for every operation it started to be answered, and for the microtasks those
   * answers resume to drain, as Convex runs a query's or mutation's syscalls to the end before it answers
   * (`environment/udf/mod.rs`, the loop ends when no syscall is pending): a rejection nothing handles there still
   * fails the call. Settled outside a checkpoint of its own (resumed by Bun, not by the host), it checks in a
   * checkpoint of its own next.
   */
  private settled(outcome: Outcome) {
    if (this.terminated) return;
    this.outcome = outcome;
    if (checkpointOf() !== this.id) setImmediate(() => checkpoint(this.id, () => {}, false));
  }

  checkpointed() {
    if (this.outcome === null || this.answeredHost || this.waiting.size) return;
    this.answer(this.outcome);
  }

  protected override sendOp(op: number, name: string, args: unknown[]) {
    this.fifo.push({ op, batch: batchOf(name, args) });
    super.sendOp(op, name, args);
  }

  /**
   * An operation's answer, given to the app's code as Convex gives a syscall's: in the order the operations were
   * started, a batch at a time (the first one waiting and the ones after it of its batch, as they stood when it was
   * formed), each batch's microtasks drained before the next (environment/udf/mod.rs: one batch per turn of the
   * loop, a microtask checkpoint between). So a rejection handled by code that one of its batch's answers resumes is
   * handled in time, as there; one handled after a later batch is not. The host runs them as they come, at once.
   */
  override reply(m: WireReply) {
    if (this.terminated) return super.reply(m);
    const entry = this.fifo.find((e) => e.op === m.op);
    if (!entry || entry.answer) return;
    entry.answer = m;
    for (;;) {
      if (this.batch === null) {
        const head = this.fifo[0];
        if (!head) return;
        let n = 1;
        if (head.batch !== null)
          while (n < this.fifo.length && n < MAX_BATCH && this.fifo[n]!.batch === head.batch) n++;
        this.batch = this.fifo.slice(0, n);
      }
      if (this.batch.some((e) => !e.answer)) return;
      const batch = this.batch;
      this.fifo.splice(0, batch.length);
      this.batch = null;
      for (const e of batch) super.reply(e.answer!);
      // What the batch's answers resume runs to the end, and what it leaves rejected is reported, before the next.
      drain();
      if (this.terminated) return;
    }
  }

  /** The call's `done`, with what it reported since its last message (the lines its last answers' code logged). */
  private answer(outcome: Outcome) {
    this.answeredHost = true;
    this.outcome = null;
    untrack(this.id);
    this.send({ t: "done", id: this.m.id, ...outcome, report: this.report() } as ToHost);
  }

  unhandled(reason: unknown) {
    if (this.answeredHost) return;
    // Convex terminates the context there: the call answers with that error now (its other operations still run
    // to their end on the host, as the engine's would), and runs no more of its code.
    this.terminated = true;
    this.answer({ ok: false, error: this.rejected(reason) });
    this.end();
  }

  table(name: string): WireTable | undefined {
    return this.catalog.get(name) ?? this.created.get(name);
  }

  link(kind: string, from: number | null, args: unknown[]): number {
    const id = ++this.nextLink;
    // Serialized at the call, as an operation's arguments are.
    this.links.push([kind, id, from, encode(args)]);
    this.linkSites.set(id, new Error());
    return id;
  }

  /** What the host charges, records and opens since the last message. */
  protected report() {
    const ran = userTimeMs(this.timer);
    const out = {
      ran: Math.max(0, ran - this.reported),
      time: this.observed.time,
      env: this.envReads.splice(0),
      links: this.links.splice(0),
      lines: this.lines.splice(0),
    };
    this.reported = ran;
    return out;
  }

  /**
   * A console line, for the host. Past `MAX_LOG_LINES` of one call none can be shown: the host keeps the first ones
   * of the invocation, which this call's first `MAX_LOG_LINES` come before (a query's or mutation's lines are not
   * streamed, STUDY-20).
   */
  logLine(l: LogLine) {
    if (this.logged++ < MAX_LOG_LINES) this.lines.push([l.level, l.messages, l.isTruncated, l.timestamp]);
  }

  protected override before() {
    checkUserTime();
  }

  protected override around<T>(wait: () => Promise<T>): Promise<T> {
    return pausingUserTime(wait).then(
      (v) => {
        checkUserTime();
        return v;
      },
      (e) => {
        throw e;
      },
    );
  }

  protected override siteOf(m: WireReply & { ok: false }, opSite: Error): Error | null {
    if (!m.sync) return null;
    return (m.link !== undefined && this.linkSites.get(m.link)) || opSite;
  }

  protected override replied(m: WireReply) {
    if (m.created) this.created = new Map(m.created.map((t) => [t.name, t]));
  }

  private ctx(kind: "query" | "mutation") {
    const tx = new Tx(this, this.m.db);
    const db = this.m.db === "reader" ? readerOf(tx) : tx;
    const auth = { getUserIdentity: async () => this.op("auth.getUserIdentity", []) };
    const methods = (prefix: string, names: string[]) =>
      Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => this.op(prefix, [n, ...args])]));
    const nested =
      (name: "runQuery" | "runMutation") => (ref: unknown, args?: unknown, opts?: { useStaleSnapshot?: boolean }) => {
        if (opts?.useStaleSnapshot && kind === "query")
          throw new Error("`useStaleSnapshot` is only supported in mutations, not queries.");
        return this.op(name, [ref, args, opts]);
      };
    const snapshot = this.snapshot;
    const meta = {
      getFunctionMetadata: () => this.op("meta", ["getFunctionMetadata"]),
      getTransactionMetrics: () => this.op("meta", ["getTransactionMetrics"]),
      getDeploymentMetadata: () => this.op("meta", ["getDeploymentMetadata"]),
      // The snapshot the call carries; reading it makes the result time-dependent, as `Date.now()` does.
      getSnapshotTs: () => {
        observeTime();
        return snapshot;
      },
    };
    if (kind === "query")
      return {
        db,
        auth,
        storage: methods("storage", this.m.storage),
        runQuery: nested("runQuery"),
        meta,
      };
    return {
      db,
      auth,
      scheduler: methods("scheduler", ["runAfter", "runAt", "cancel"]),
      // Rooms (AD-42): a broadcast is sent once the mutation commits, by the host.
      rooms: methods("rooms", ["broadcast"]),
      storage: methods("storage", this.m.storage),
      runQuery: nested("runQuery"),
      runMutation: nested("runMutation"),
      meta: { ...meta, getRequestMetadata: () => this.op("meta", ["getRequestMetadata"]) },
    };
  }

  async run(handler: (ctx: unknown, args: unknown) => unknown, env: Map<string, string> | null, execution: object) {
    const kind = this.m.kind;
    this.timer = newUserTimer(this.m.userMs, this.m.systemMs);
    const args = decode(this.m.args, false);
    const ctx = this.ctx(kind);
    const read = env
      ? (name: string) => {
          checkEnvVarName(name);
          this.envReads.push(name);
          return env.get(name);
        }
      : null;
    const body = () =>
      withUserTimer(this.timer, async () => {
        const call = () => handler(appContext(handler, ctx), args);
        return read ? withEnv(read, call) : call();
      });
    const logged = () =>
      running.run(this, () =>
        captureLines(
          (line) => this.logLine(line),
          () => inHandleScope({ create: (ref: unknown) => this.op("createFunctionHandle", [ref]) } as never, body),
        ),
      );
    let outcome: Outcome;
    try {
      const value = await runInExecution(execution, logged);
      // The engine checks this on what the handler returned (`notAQuery`); the object cannot cross.
      if (value instanceof QueryImpl || value instanceof VirtualQuery)
        outcome = { ok: false, error: { k: "host", message: RETURNED_A_QUERY } };
      else outcome = { ok: true, value: encode(value) };
    } catch (e) {
      outcome = { ok: false, error: this.thrown(e) };
    }
    this.settled(outcome);
  }
}

/** The engine's error for a query or mutation that returns a query object (`notAQuery`, functions.ts). */
const RETURNED_A_QUERY =
  "Return value is a Query. Results must be retrieved with `.collect()`, `.take(n), `.unique()`, or `.first()`.";

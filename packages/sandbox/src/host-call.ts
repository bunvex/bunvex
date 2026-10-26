// A query's or mutation's call on the host (STUDY-171 §8): the stand-in the engine runs in the child's function's
// place, and the operations it answers with the function's real `ctx`.
//
// The engine runs the stand-in as it runs any function (`Functions.invoke`): in the function's transaction, under its
// user timer, its deterministic execution, its environment, its handle scope. So each operation the child sends runs
// on the real `ctx` in that same async context (the call's messages are read in a loop the stand-in itself awaits),
// and the read set, OCC, the commit, the query cache, the limits and the scheduler stay the engine's.
//
// Every message is checked: the call must be running, the operation allowed for the function's kind and for the
// `db` it was given (a query run from a mutation has no writes at all; a query's own transaction has them, and
// refuses them itself, as under `vm`), its arguments a short list of wire values. A message that breaks this is the
// child's, not the app's: the child is killed.
import vm from "node:vm";
import {
  chargeUserTime,
  currentExecution,
  currentUserTimer,
  expressionFromJson,
  failExecution,
  formatDuration,
  observeTime,
  realRuntime,
  type TableDef,
  type Tx,
  userTimeMs,
} from "@bunvex/core";
import {
  addAuditLine,
  createFunctionHandle,
  currentEnvReader,
  ExecutorFailure,
  isCallerError,
  type LogLevel,
  type LogLine,
  logChildLine,
  MAX_LOG_LINE_LENGTH,
  makeLogLine,
  type SandboxCall,
} from "@bunvex/server/executor";
import { BunvexError, isBunvexError, type JSONValue } from "@bunvex/values";
import { type SandboxError, type SandboxProcess, streamErrors } from "./host.ts";
import {
  BadMessageError,
  EPOCHS_KEPT,
  type ToHost,
  type WireCall,
  type WireLink,
  type WireLogLine,
  type WireReport,
  type WireTable,
  type WireTerminal,
  type WireThrown,
} from "./protocol.ts";
import { decode, encode } from "./wire.ts";

/**
 * How long past its remaining user time a call may go without a word before the host kills its child: the round
 * trip's slack (STUDY-168 §13.1). A child that under-reports its time gains at most this per stretch of JavaScript.
 */
export const BACKSTOP_SLACK_MS = 50;

/**
 * The most arguments an operation takes (`db.patch(table, id, value)`, `scheduler.runAfter`'s three, `storage`'s
 * method and two, `rooms.broadcast`'s method and four).
 */
const MAX_OP_ARGS = 5;

type Kind = "query" | "mutation";

/** Each operation: which kinds may send it, and whether it writes (refused to a reader's `db`). */
const OPS: Record<string, { kinds: readonly Kind[]; writes?: boolean }> = {
  "db.get": { kinds: ["query", "mutation"] },
  "db.query": { kinds: ["query", "mutation"] },
  "db.next": { kinds: ["query", "mutation"] },
  "db.return": { kinds: ["query", "mutation"] },
  "db.system.get": { kinds: ["query", "mutation"] },
  "db.insert": { kinds: ["query", "mutation"], writes: true },
  "db.patch": { kinds: ["query", "mutation"], writes: true },
  "db.replace": { kinds: ["query", "mutation"], writes: true },
  "db.delete": { kinds: ["query", "mutation"], writes: true },
  "auth.getUserIdentity": { kinds: ["query", "mutation"] },
  storage: { kinds: ["query", "mutation"] },
  scheduler: { kinds: ["mutation"] },
  runQuery: { kinds: ["query", "mutation"] },
  runMutation: { kinds: ["mutation"] },
  meta: { kinds: ["query", "mutation"] },
  createFunctionHandle: { kinds: ["query", "mutation"] },
  "log.audit": { kinds: ["query", "mutation"] },
  rooms: { kinds: ["mutation"] },
};
/** A mutation's `ctx.rooms` (AD-42): its broadcasts are sent once it commits. */
const ROOMS_METHODS = ["broadcast"];

/** `ctx.storage`'s methods (`FileStorage.reader` / `.writer`), `ctx.meta`'s and `ctx.scheduler`'s, by kind. */
export const STORAGE_METHODS: Record<Kind, readonly string[]> = {
  query: ["getUrl", "getMetadata"],
  mutation: ["getUrl", "getMetadata", "generateUploadUrl", "delete"],
};
const META_METHODS: Record<Kind, readonly string[]> = {
  query: ["getFunctionMetadata", "getTransactionMetrics", "getDeploymentMetadata"],
  mutation: ["getFunctionMetadata", "getTransactionMetrics", "getDeploymentMetadata", "getRequestMetadata"],
};
const SCHEDULER_METHODS = ["runAfter", "runAt", "cancel"];
const RANGE_OPS = new Set(["eq", "gt", "gte", "lt", "lte"]);

const bad = (what: string): never => {
  throw new BadMessageError(what);
};

/**
 * The realm the app's errors are rebuilt in: not this one, as under `vm` (a function's code runs in its own
 * context, whose `Error` is not the server's).
 */
let appRealm: ((cls: string, message: string) => Error) | null = null;
function appRealmError(cls: string, message: string): Error {
  appRealm ??= vm.runInContext(
    `(cls, message) => {
  const C = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"].includes(cls)
    ? globalThis[cls]
    : Error;
  return new C(message);
}`,
    vm.createContext({}),
    { filename: "bunvex-runtime:sandbox-errors.js" },
  ) as (cls: string, message: string) => Error;
  return appRealm(cls, message);
}

const define = (o: object, key: string, value: unknown) => {
  try {
    Object.defineProperty(o, key, { value, writable: true, configurable: true });
  } catch {}
};

/** An operation's error for the child: its class, name, message, and a `BunvexError`'s data. */
export function thrownToChild(e: unknown): WireThrown {
  const isError = e instanceof Error || Object.prototype.toString.call(e) === "[object Error]";
  if (!isError) return { k: "value", v: encode(e) };
  const err = e as Error;
  const bunvex = isBunvexError(err);
  const cls = Object.getPrototypeOf(err)?.constructor?.name;
  return {
    k: "error",
    cls: typeof cls === "string" ? cls : "Error",
    name: String(err.name),
    message: String(err.message),
    stack: null,
    bunvex,
    ...(bunvex ? { data: encode((err as BunvexError<never>).data) } : {}),
    ...(isCallerError(err) ? { caller: true as const } : {}),
  };
}

type OpMessage = Extract<ToHost, { t: "op" }>;
type DoneMessage = Extract<ToHost, { t: "done" }>;
/** What a call's inbox holds: the child's messages for it, its child's death, its backstop or its cut-off. */
export type Inbox =
  | OpMessage
  | DoneMessage
  | Extract<ToHost, { t: "lines" } | { t: "cancelled" } | { t: "response" }>
  | { t: "gone"; e: SandboxError }
  | { t: "timeout" }
  | { t: "cutOff"; error: unknown };

/**
 * The epochs a child still has: the last `EPOCHS_KEPT` it was sent, in the order it was sent them, as the child keeps
 * them (`CallRuntime`). One outside it is sent again, with a new epoch.
 */
class EpochWindow {
  private readonly sent: number[] = [];
  has(epoch: number) {
    return this.sent.includes(epoch);
  }
  add(epoch: number) {
    this.sent.push(epoch);
    if (this.sent.length > EPOCHS_KEPT) this.sent.shift();
  }
}

/** What the host keeps per child: the epochs it sent, and its ids for the executions it has seen. */
type ChildState = {
  /** Each catalog's epoch, and the text indexes' generation it was sent with (their names are in it). */
  catalogs: WeakMap<object, { epoch: number; search: number }>;
  catalogWindow: EpochWindow;
  envs: WeakMap<object, { builtin: string; epoch: number }[]>;
  envWindow: EpochWindow;
  executions: WeakMap<object, number>;
  next: number;
};
const states = new WeakMap<SandboxProcess, ChildState>();
const stateOf = (child: SandboxProcess): ChildState => {
  let st = states.get(child);
  if (!st) {
    st = {
      catalogs: new WeakMap(),
      catalogWindow: new EpochWindow(),
      envs: new WeakMap(),
      envWindow: new EpochWindow(),
      executions: new WeakMap(),
      next: 0,
    };
    states.set(child, st);
  }
  return st;
};

/**
 * What a call of either kind (a query's or mutation's, `HostCall`; an action's, `HostActionCall`) does with the
 * child's messages: queued as they come (outside the call's async context) and read by the call's own loop, each
 * operation answered on the real `ctx`, each thrown value made again as the engine or the app threw it.
 */
export abstract class HostCallBase {
  protected readonly opErrors = new Map<number, unknown>();
  protected readonly inFlight = new Set<Promise<void>>();
  private readonly queue: Inbox[] = [];
  private wake: (() => void) | null = null;
  readonly id: number;

  constructor(protected readonly child: SandboxProcess) {
    this.id = child.newCallId();
  }

  /** A message for this call from the child's reader (outside the call's async context: only queued here). */
  protected push(item: Inbox) {
    this.queue.push(item);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  protected async next(): Promise<Inbox> {
    while (!this.queue.length) await new Promise<void>((resolve) => (this.wake = resolve));
    return this.queue.shift()!;
  }

  /** The sink the child's reader hands this call's messages to. */
  protected sink() {
    return {
      message: (m: Extract<Inbox, { t: "op" | "done" | "lines" | "cancelled" | "response" }>) => this.push(m),
      gone: (e: SandboxError) => this.push({ t: "gone", e }),
    };
  }

  /**
   * `fn`, where a message the host cannot use (`BadMessageError`) is the child's fault: it is killed, and the call
   * fails as a system error. Any other error is the call's.
   */
  protected checked<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof BadMessageError)) throw e;
      this.child.kill("badMessage", `sent a message that is not valid: ${e.message}`);
      throw new ExecutorFailure(`the function sandbox's process sent a message that is not valid: ${e.message}`);
    }
  }

  /**
   * A console line the child logged, logged here where the console would have logged it in-process: in the call's
   * execution, after the operations before it. The child made it as the console does (rendered, cut, stamped); one
   * that may be past the cut (only a broken child sends one) is cut again.
   */
  protected logLine([level, messages, isTruncated, timestamp]: WireLogLine) {
    let units = messages.length;
    for (const m of messages) units += m.length;
    // A UTF-16 unit is at most 3 bytes of UTF-8: a line that short is within the cut.
    const line: LogLine =
      units * 3 <= MAX_LOG_LINE_LENGTH
        ? { level: level as LogLevel, messages, isTruncated, timestamp }
        : makeLogLine(level as LogLevel, messages, timestamp);
    if (isTruncated) line.isTruncated = true;
    logChildLine(line);
  }

  /** What the function's `done` stands for: its value, or what it threw. */
  protected result(m: DoneMessage): unknown {
    if (m.ok) return decode(m.value as JSONValue, true);
    const w = m.error;
    switch (w.k) {
      case "value":
        throw decode(w.v as JSONValue, true);
      case "op": {
        if (!this.opErrors.has(w.op)) bad(`an error of no operation (${w.op})`);
        const original = this.opErrors.get(w.op);
        // The app's frames, as the child's context gave them (its `appContext` view): as under `vm`, the engine's
        // error carries the app's call.
        if (w.stack !== null && original !== null && typeof original === "object") define(original, "stack", w.stack);
        throw original;
      }
      case "host":
        throw new Error(w.message);
      case "system":
        throw new ExecutorFailure(w.message);
      case "error":
        throw appError(w);
    }
  }

  /** Why the child may not send operation `name` (it is then killed), or null when it may. */
  protected abstract refused(name: string): string | null;

  /** Operation `name`, run on the real `ctx` (`atTheAppsCall`). */
  abstract dispatch(name: string, args: unknown[], op: number): unknown;

  /** What the reply carries besides the value (the transaction's created tables). */
  protected extra(_reply: Record<string, unknown>) {}

  protected async answer(m: OpMessage): Promise<void> {
    const why = this.refused(m.name);
    if (why !== null) {
      this.child.kill("badMessage", why);
      return;
    }
    if (m.args.length > MAX_OP_ARGS) {
      this.child.kill("badMessage", `sent an operation with too many arguments (${m.name})`);
      return;
    }
    let reply: Record<string, unknown>;
    try {
      const args = m.args.map((a) => decode(a as JSONValue, true));
      const value = await atTheAppsCall(this, m.name, args, m.op);
      reply = { t: "reply", id: this.id, op: m.op, ok: true, value: encode(value) };
    } catch (e) {
      if (e instanceof BadMessageError) {
        this.child.kill("badMessage", `sent a message that is not valid: ${e.message}`);
        return;
      }
      this.opErrors.set(m.op, e);
      reply = { t: "reply", id: this.id, op: m.op, ok: false, error: thrownToChild(e) };
      const made = madeAt(e);
      if (made !== null) {
        reply.sync = true;
        if (made > 0) reply.link = made;
      }
    }
    this.extra(reply);
    this.child.send(reply as never);
  }

  /** Starts answering an operation; the call's loop goes on reading. */
  protected start(m: OpMessage, settled?: () => void) {
    const op = this.answer(m);
    this.inFlight.add(op);
    void op.finally(() => {
      this.inFlight.delete(op);
      settled?.();
    });
  }

  protected method(args: unknown[], allowed: readonly string[], what: string): string {
    const name = args[0];
    if (typeof name !== "string" || !allowed.includes(name)) bad(`${what} has no method ${String(name)}`);
    return name as string;
  }
}

/** An app's error, as the child described it: made again with its class's name, a `BunvexError` with its data. */
export function appError(w: Extract<WireThrown, { k: "error" }>): Error {
  let e: Error;
  if (w.bunvex) {
    e = new BunvexError(decode((w.data ?? null) as JSONValue, true) as never);
    define(e, "message", w.message);
  } else e = appRealmError(w.cls, w.message);
  if (e.name !== w.name) define(e, "name", w.name);
  if (w.stack !== null) define(e, "stack", w.stack);
  return e;
}

/** A query's or mutation's call in progress: the child's messages, in order, and how the host answers them. */
export class HostCall extends HostCallBase {
  private readonly streams = new Map<number, AsyncIterator<unknown>>();
  /**
   * Each link of each query chain the function made, made again on its `ctx.db` (`WireReport.links`), by id: the
   * engine's query object, or the error making it threw (the child checked what throws at the app's call).
   */
  private readonly links = new Map<number, { q: Chain } | { error: unknown }>();
  private nextStream = 0;
  private backstop: ReturnType<typeof realRuntime.setTimeout> | null = null;
  private createdSent = 0;
  private readonly env = currentEnvReader();
  private readonly timer = currentUserTimer();

  constructor(
    child: SandboxProcess,
    private readonly kind: Kind,
    private readonly ctx: Record<string, unknown>,
    private readonly call: SandboxCall,
  ) {
    super(child);
  }

  private get db(): Tx {
    return this.call.db as Tx;
  }

  /** The user time the engine's timer has counted (the child's, charged). */
  private userMs(): number {
    return this.timer ? userTimeMs(this.timer) : 0;
  }

  /** The call as the child gets it: what it runs, its transaction's clock, snapshot, variables and catalog. */
  private message(fn: string, version: number, args: unknown): WireCall {
    const st = stateOf(this.child);
    const exec = currentExecution();
    if (!exec) throw new Error("a sandboxed function runs only inside an execution");
    let execId = st.executions.get(exec.key);
    if (execId === undefined) {
      execId = ++st.next;
      st.executions.set(exec.key, execId);
    }
    const catalog = this.db.namespaceCatalog;
    const search = this.db.searchIndexes;
    const generation = search?.generation ?? -1;
    const sent = st.catalogs.get(catalog);
    let catalogEpoch = sent?.epoch;
    let tables: WireTable[] | undefined;
    if (catalogEpoch === undefined || sent!.search !== generation || !st.catalogWindow.has(catalogEpoch)) {
      catalogEpoch = ++st.next;
      st.catalogs.set(catalog, { epoch: catalogEpoch, search: generation });
      st.catalogWindow.add(catalogEpoch);
      tables = [...catalog.tables.values()].map((t) => wireTable(t, search));
    }
    let env: WireCall["env"] = null;
    const vars = this.env?.variables;
    if (vars) {
      // The deployment's variables are the same object while none changes; the built-ins are a few URLs.
      const builtin = JSON.stringify(vars.builtin);
      const seen = (st.envs.get(vars.deployment) ?? []).filter((e) => st.envWindow.has(e.epoch));
      const known = seen.find((e) => e.builtin === builtin);
      if (known) env = { epoch: known.epoch };
      else {
        const epoch = ++st.next;
        st.envWindow.add(epoch);
        seen.push({ builtin, epoch });
        st.envs.set(vars.deployment, seen);
        // The deployment's win over the built-ins, as the engine's reader reads them.
        env = { epoch, vars: [...Object.entries(vars.builtin), ...vars.deployment] };
      }
    }
    const created = this.db.createdTableDefs();
    this.createdSent = created.length;
    return {
      t: "call",
      id: this.id,
      version,
      fn,
      kind: this.kind,
      args: encode(args),
      exec: { id: execId, ...exec.clock },
      snapshot: this.db.snapshot.toString(),
      userMs: this.timer?.userMs ?? Number.POSITIVE_INFINITY,
      systemMs: this.timer?.systemMs ?? Number.POSITIVE_INFINITY,
      db: this.call.shape,
      storage: [...STORAGE_METHODS[this.kind]],
      env,
      catalog: tables ? { epoch: catalogEpoch, tables } : { epoch: catalogEpoch },
      created: created.map((t) => wireTable(t)),
    };
  }

  /** The created tables this transaction has, when they changed since the child last heard. */
  private createdTables(): WireTable[] | undefined {
    const created = this.db.createdTableDefs();
    if (created.length === this.createdSent) return undefined;
    this.createdSent = created.length;
    return created.map((t) => wireTable(t));
  }

  /** Arms the backstop: the call's remaining user time, plus the slack, with no word from the child. */
  private arm() {
    this.disarm();
    if (this.inFlight.size || !this.timer) return;
    const remaining = Math.max(0, this.timer.userMs - this.userMs());
    this.backstop = realRuntime.setTimeout(() => this.push({ t: "timeout" }), remaining + BACKSTOP_SLACK_MS);
  }

  private disarm() {
    if (this.backstop !== null) realRuntime.clearTimeout(this.backstop);
    this.backstop = null;
  }

  /** Runs `fn` of version `version` to its end: the child's `done`, or its failure. In the stand-in's async context. */
  async run(fn: string, version: number, args: unknown): Promise<unknown> {
    const message = this.message(fn, version, args);
    this.child.openCall(this.id, this.sink());
    this.child.send(message);
    this.arm();
    try {
      for (;;) {
        const item = await this.next();
        if (item.t === "timeout") {
          // Convex's words for a function past its user time (its isolate terminated; here, its process).
          const ms = this.timer!.userMs;
          const error = new Error(`Function execution timed out (maximum duration: ${formatDuration(ms)})`);
          failExecution(error);
          this.child.kill("timeout", `ran past a call's user time (${ms} ms) without a word`);
          throw error;
        }
        if (item.t === "gone") throw new ExecutorFailure(item.e.message);
        if (item.t === "lines" || item.t === "cancelled" || item.t === "cutOff" || item.t === "response") {
          this.child.kill("badMessage", `sent an action's message (${item.t}) for a ${this.kind}`);
          throw new ExecutorFailure(`the function sandbox's process sent a message that is not valid: ${item.t}`);
        }
        this.disarm();
        this.checked(() => this.charge(item.report));
        if (item.t === "op") {
          this.start(item, () => {
            if (!this.inFlight.size) this.arm();
          });
          continue;
        }
        // An operation the function did not await still runs to its end, as the engine's would (its synchronous part
        // already ran at the app's call).
        await Promise.allSettled([...this.inFlight]);
        return this.checked(() => this.result(item));
      }
    } finally {
      this.disarm();
      for (const it of this.streams.values()) void Promise.resolve(it.return?.()).catch(() => {});
    }
  }

  /** What the child ran, read and observed since its last message: charged to the engine's timer, recorded. */
  private charge(r: WireReport) {
    chargeUserTime(r.ran);
    if (r.time) observeTime();
    for (const line of r.lines) this.logLine(line);
    for (const link of r.links) this.link(link);
    if (r.env.length) {
      if (!this.env) bad("an environment read without variables");
      // The engine's reader: each name in the read set (the child checked it as this reader does: a name it refuses
      // is a lie).
      for (const name of r.env)
        try {
          this.env!(name);
        } catch {
          bad(`an environment variable name the child should have refused (${name})`);
        }
    }
  }

  /** A link of a chain, made on the engine's chain as the app made it on the child's. */
  private link([kind, id, from, wire]: WireLink) {
    if (this.links.has(id)) bad(`the link ${id} made twice`);
    const args = decode(wire, true);
    if (!Array.isArray(args)) bad(`a link with arguments that are not a list (${kind})`);
    const a = args as unknown[];
    let source: Chain | null = null;
    if (kind !== "open") {
      const prev = from === null ? undefined : this.links.get(from);
      if (!prev) bad(`a link from no link (${kind} from ${String(from)})`);
      if ("error" in prev!) {
        this.links.set(id, prev!);
        return;
      }
      source = prev!.q;
    }
    try {
      this.links.set(id, { q: atTheAppsLink(id, () => makeLink(this.ctx.db as Chain, source, kind, a)) });
    } catch (error) {
      if (error instanceof BadMessageError) throw error;
      this.links.set(id, { error });
    }
  }

  protected refused(name: string): string | null {
    const spec = OPS[name];
    if (!spec?.kinds.includes(this.kind) || (spec.writes && this.call.shape === "reader"))
      return `sent an operation its function may not run (${name} in a ${this.kind})`;
    return null;
  }

  protected override extra(reply: Record<string, unknown>) {
    const created = this.createdTables();
    if (created) reply.created = created;
  }

  dispatch(name: string, args: unknown[]): unknown {
    const ctx = this.ctx as Record<string, Record<string, (...a: unknown[]) => unknown>>;
    const db = ctx.db as unknown as Record<string, (...a: unknown[]) => unknown> & {
      system: Record<string, (...a: unknown[]) => unknown>;
    };
    switch (name) {
      case "db.get":
        return db.get!(...args);
      case "db.insert":
        return db.insert!(...args);
      case "db.patch":
        return db.patch!(...args);
      case "db.replace":
        return db.replace!(...args);
      case "db.delete":
        return db.delete!(...args);
      case "db.system.get":
        return db.system.get!(...args);
      case "db.query":
        return this.query(args[0], args[1] as WireTerminal);
      case "db.next": {
        const it = this.streams.get(args[0] as number) ?? bad(`no stream ${String(args[0])}`);
        return it.next();
      }
      case "db.return": {
        const it = this.streams.get(args[0] as number) ?? bad(`no stream ${String(args[0])}`);
        this.streams.delete(args[0] as number);
        return Promise.resolve(it.return?.()).then(() => null);
      }
      case "auth.getUserIdentity":
        return ctx.auth!.getUserIdentity!();
      case "storage": {
        const method = this.method(args, STORAGE_METHODS[this.kind], "ctx.storage");
        return ctx.storage![method]!(...args.slice(1));
      }
      case "scheduler": {
        const method = this.method(args, SCHEDULER_METHODS, "ctx.scheduler");
        return ctx.scheduler![method]!(...args.slice(1));
      }
      case "meta": {
        const method = this.method(args, META_METHODS[this.kind], "ctx.meta");
        return ctx.meta![method]!();
      }
      case "runQuery":
        return (ctx.runQuery as unknown as (...a: unknown[]) => unknown)(...args);
      case "runMutation":
        return (ctx.runMutation as unknown as (...a: unknown[]) => unknown)(...args);
      case "createFunctionHandle":
        return createFunctionHandle(args[0]);
      case "log.audit":
        return auditLine(args[0]);
      case "rooms": {
        const method = this.method(args, ROOMS_METHODS, "ctx.rooms");
        return (ctx.rooms as Record<string, (...a: unknown[]) => unknown>)[method]!(...args.slice(1));
      }
    }
    return bad(`no operation ${name}`);
  }

  /** A chain's terminal, run on the engine's chain (from here, every check and every error is the engine's). */
  private query(id: unknown, terminal: WireTerminal): unknown {
    const link = (typeof id === "number" && this.links.get(id)) || bad(`no query link ${String(id)}`);
    if ("error" in link) throw link.error;
    const q = link.q;
    switch (terminal?.k) {
      case "collect":
        return q.collect();
      case "take":
        return q.take(terminal.n);
      case "first":
        return q.first();
      case "unique":
        return q.unique();
      case "paginate":
        return q.paginate(terminal.opts);
      case "count":
        return q.count();
      case "iterate": {
        const it = q[Symbol.asyncIterator]() as AsyncIterator<unknown>;
        const sid = ++this.nextStream;
        this.streams.set(sid, it);
        return sid;
      }
    }
    return bad("a query terminal that is not one");
  }
}

// A stream's failure crosses as an operation's error does: the host's own errors to the child, the app's back.
streamErrors.thrown = (e) => thrownToChild(e);
streamErrors.error = (w) =>
  w.k === "error"
    ? appError(w)
    : w.k === "value"
      ? decode(w.v as JSONValue, true)
      : w.k === "system"
        ? new ExecutorFailure(w.message)
        : new Error("a stream failed");

/** A `log.audit` line the child checked, checked again (only a broken child sends one that is not a JSON object). */
export function auditLine(json: unknown): unknown {
  if (typeof json !== "string") return bad("an audit line that is not text");
  try {
    const body = JSON.parse(json);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return bad("an audit line that is not a JSON object");
  }
  return addAuditLine(json);
}

/**
 * An operation run on the engine, by a function of its own name: an error made while it is on the stack (the
 * synchronous part of an engine's method, before its first `await`) was, under `vm`, made while the app's call was,
 * and holds the app's frames, which the app sees (`installAppErrors` keeps them, with no `at async` frame). Under
 * `process` the child gives such an error the frames of its own call (`sync`).
 */
function atTheAppsCall(call: HostCallBase, name: string, args: unknown[], op: number): unknown {
  // Not in a tail position, where JavaScriptCore takes the frame off the stack (a module is strict code).
  try {
    return call.dispatch(name, args, op);
  } finally {
  }
}

/**
 * A query chain's link made on the engine, by a function named for it (`atTheAppsLink<id>`): an error made while
 * making it (an index not found, thrown when the query starts) was, under `vm`, made at the app's call of that link.
 */
function atTheAppsLink<T>(id: number, make: () => T): T {
  const name = `atTheAppsLink${id}`;
  const named = {
    [name]: () => {
      try {
        return make();
      } finally {
      }
    },
  }[name]!;
  return named();
}

const MADE_AT = /\n\s+at atTheApps(?:Call|Link(\d+)) \(/;

/** Where `e` was made: at an operation's call (0), at a link's (its id), or neither (null, after an `await`). */
function madeAt(e: unknown): number | null {
  if (!(e instanceof Error)) return null;
  let stack: string;
  try {
    stack = String(e.stack);
  } catch {
    return null;
  }
  const m = MADE_AT.exec(stack);
  return m ? Number(m[1] ?? 0) : null;
}

// biome-ignore lint/suspicious/noExplicitAny: the engine's query builders and its `db`, driven as the app drove the child's
type Chain = any;

/** One link of the engine's chain: `kind` on `source` (or `db.query` for `open`), as the child's link was made. */
function makeLink(db: Chain, source: Chain | null, kind: string, a: unknown[]): Chain {
  switch (kind) {
    case "open": {
      const [table, system] = a;
      if (typeof system !== "boolean") bad("an open link that is not one");
      return system ? db.system.query(table) : db.query(table);
    }
    case "withIndex": {
      const [name, range, exprs] = a;
      if (!Array.isArray(exprs) || !exprs.every((e) => Array.isArray(e) && e.length === 3 && RANGE_OPS.has(e[0])))
        bad("an index range that is not one");
      return source.withIndex(
        name,
        range
          ? (b: Chain) => {
              for (const [op, field, value] of exprs as [string, unknown, unknown][]) b = b[op](field, value);
              return b;
            }
          : undefined,
      );
    }
    case "withSearchIndex": {
      const [name, filters] = a;
      if (!Array.isArray(filters) || !filters.every((f) => Array.isArray(f) && f.length === 3))
        bad("a search filter that is not one");
      return source.withSearchIndex(name, (b: Chain) => {
        for (const [type, field, value] of filters as [string, unknown, unknown][])
          b = type === "Search" ? b.search(field, value) : b.eq(field, value);
        return b;
      });
    }
    case "fullTableScan":
      return source.fullTableScan();
    case "order":
      return source.order(a[0]);
    case "filter": {
      const p = a[0] as { expr?: unknown; literal?: unknown } | null;
      if (p === null || typeof p !== "object" || !("expr" in p || "literal" in p))
        return bad("a filter that is not one");
      const value = "expr" in p ? expressionFromJson(p.expr as JSONValue) : p.literal;
      return source.filter(() => value);
    }
    case "limit":
      return source.limit(a[0]);
  }
  return bad(`no link ${kind}`);
}

/**
 * A table as the child's `normalizeId` and `withIndex` need it: its number, each index's fields and readiness, the
 * ones being built and its text indexes (`search`, the registry's: a table this transaction created has none).
 */
export function wireTable(t: TableDef, search?: Tx["searchIndexes"]): WireTable {
  const w: WireTable = {
    name: t.name,
    number: t.number,
    indexes: [...t.indexes].map(([name, ix]) => [name, ix.fields, ix.readyTs == null ? null : ix.readyTs.toString()]),
  };
  if (t.pending.length) w.pending = t.pending.map((ix) => [ix.name, ix.staged === true]);
  const text = search?.forTablet(t.id);
  if (text?.length) w.search = text.map((e) => e.name);
  return w;
}

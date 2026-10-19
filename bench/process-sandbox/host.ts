// STUDY-168 prototype: the host side of a sandboxed executor. A `SandboxedDeployment` owns one child process
// (child.ts) running a deployment's functions, and gives the real `Functions` registry stand-ins for them: each
// stand-in runs on the host in the real transaction and forwards the handler to the child, answering the child's
// ops with the real `ctx` (so read sets, OCC, the commit, the scheduler and the query cache are the engine's own).
//
// Linux: the child runs in bubblewrap (new user, mount, pid, net, ipc, uts and cgroup namespaces, no capabilities,
// a seccomp deny list, only the bun binary, its libraries and the app's files visible) inside a cgroup v2 leaf with
// memory.max, pids.max and cpu.max. Elsewhere (macOS dev) `sandbox: "none"` runs it as a plain child process.
//
// Never on a default code path: the bench and tests in this directory construct it explicitly.
import { AsyncResource } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pausingUserTime, realRuntime } from "@bunvex/core";
import type { Subprocess } from "bun";
import { action, mutation, query } from "bunvex/server";
import { decode, encode, replay, type Step, type ToChild, type ToHost, type Wire, type WireError } from "./wire.ts";

// The host's own clock and timers: inside an execution the globals are the deterministic ones (frozen, refused).
const clock = realRuntime.monotonicNow;
/**
 * Env SANDBOX_SABOTAGE (tests only): drop one protection, to check that a test catches it. Round 1:
 * net, fs, env, seccomp, cgroup, timeout, memory; the no-namespace mode adds landlock and uid; round 2's fixes:
 * accounting (host-measured user time), pool (no pool), slack (a backstop that never fires in time).
 */
const sabotage = new Set((process.env.SANDBOX_SABOTAGE ?? "").split(",").filter(Boolean));

type Kind = "query" | "mutation" | "action";
// biome-ignore lint/suspicious/noExplicitAny: the engine's ctx, called by op name
type AnyCtx = Record<string, any>;

export type SandboxOptions = {
  /** The app module the child loads (its exports are `{ name: query(…) }` groups, as a bunvex module). */
  app: string;
  /** "bwrap": Linux namespaces + seccomp + cgroup; "none": a plain child process (macOS dev, baselines). */
  sandbox?: "bwrap" | "confine" | "seatbelt" | "none";
  /** "confine": the uid the child runs as (one per deployment, so RLIMIT_NPROC and signals are per deployment). */
  uid?: number;
  /** cgroup v2 limits (bwrap only). */
  memoryMiB?: number;
  pidsMax?: number;
  /** cpu.max as a fraction of one CPU (1 = one full core). */
  cpus?: number;
  /** A name for the cgroup leaf and logs. */
  name?: string;
  /** The user-time budget of a query or mutation (Convex's DATABASE_UDF_USER_TIMEOUT_SECONDS, 1 s). */
  userTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** The deployment's environment variables, as the app's `process.env` sees them. */
  env?: Record<string, string>;
  /** Called with each log line the app writes. */
  onLog?: (level: string, text: string) => void;
  /**
   * Who measures user time. "host" (the first round): the host's clock while the child runs, so IPC transit counts
   * as user time. "child": the child reports how long each stretch of the call's own JS ran (between an op's answer
   * and its next op), and the host's timer only backstops a child that stops talking (budget + `slackMs`).
   */
  accounting?: "host" | "child";
  /** The backstop's margin over the budget ("child" accounting): what IPC transit may add before a kill. */
  slackMs?: number;
  /**
   * 0 (the first round): one child per deployment runs every call concurrently, and a kill fails them all.
   * N > 0: a pool of N children, each running one call at a time (calls queue for a free one), so a timeout or an
   * OOM kills only the guilty call's process, and each process's cgroup cap is that call's cap.
   */
  poolSize?: number;
  /** `taskset -c` for the children (Linux): the CPUs they may run on. */
  cpuList?: string;
  /** Ops started in the same tick travel in one message each way. */
  batchOps?: boolean;
};

/** Convex's user-facing messages (crates/isolate/src/termination.rs), bunvex's words where they name the product. */
export const timeoutMessage = (ms: number) => `Function execution timed out (maximum duration: ${ms / 1000}s)`;
export const oomMessage = (mib: number) => `JavaScript execution ran out of memory (maximum memory usage: ${mib} MB)`;
export const INTERNAL_ERROR = "Your request couldn't be completed. Try again later.";

const RUNNER_DIR = import.meta.dir;
const VALUES_DIR = resolve(import.meta.dir, "../../packages/values");
/**
 * Env SANDBOX_CGROUP_ROOT: the cgroup subtree the children's leaves go in. "auto": `sandbox/` under this process's
 * own cgroup, which is what an unprivileged host uses (a systemd unit with Delegate=yes owns its cgroup).
 */
const CGROUP_ROOT =
  process.env.SANDBOX_CGROUP_ROOT === "auto"
    ? join("/sys/fs/cgroup", readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1] ?? "/", "sandbox")
    : (process.env.SANDBOX_CGROUP_ROOT ?? "/sys/fs/cgroup/bunvex-study");
/** Env SANDBOX_BWRAP: the bubblewrap binary (a copy only the service's group may run, with its AppArmor profile). */
const BWRAP = process.env.SANDBOX_BWRAP ?? "bwrap";
/** Env SANDBOX_NO_PROC=1: no /proc in the sandbox (Docker masks paths of its /proc, so a new one cannot be mounted). */
const NO_PROC = process.env.SANDBOX_NO_PROC === "1";
const SECCOMP_BPF = join(import.meta.dir, "seccomp.bpf");

type Call = {
  id: number;
  fn: string;
  kind: Kind;
  ctx: AnyCtx;
  scope: AsyncResource;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  /** User-time accounting: time inside host ops is paused, as Convex's timeout pauses in syscalls. */
  budgetMs: number;
  usedMs: number;
  runningSince: number | null;
  opsInFlight: number;
  timer: unknown;
};

type Child = {
  proc: Subprocess;
  ready: Promise<Record<string, Kind>>;
  calls: Map<number, Call>;
  cgroup: string | null;
  spawnedAt: number;
  readyAt: number | null;
  /** Why it died, once it did. */
  death: { reason: "timeout" | "oom" | "crash" | "stopped"; message: string } | null;
  exited: Promise<number>;
  /** A pool child running a call. */
  busy: boolean;
  /** batchOps: answers waiting for the end of the tick. */
  outbox: ToChild[];
};

let nextCall = 0;
let nextChild = 0;

export class SandboxedDeployment {
  private child: Child | null = null;
  /** poolSize > 0: the pool, and the calls waiting for a free child. */
  private pool: Child[] = [];
  private waiting: (() => void)[] = [];
  private stopped = false;
  private opts: Required<Omit<SandboxOptions, "onLog" | "env">> & Pick<SandboxOptions, "onLog" | "env">;
  /** Times of the last kill: the timeout firing → the process gone → a fresh child ready. */
  lastKill: { firedAt: number; exitedAt: number | null; respawnedAt: number | null } | null = null;
  /** How the last child ended, and its cgroup's peak memory (memory.peak). */
  lastDeath: { reason: string; peakMiB: number | null } | null = null;

  constructor(opts: SandboxOptions) {
    this.opts = {
      sandbox: "none",
      memoryMiB: 64,
      pidsMax: 64,
      cpus: 1,
      name: `dep${process.pid}-${++nextChild}`,
      userTimeoutMs: 1000,
      actionTimeoutMs: 600_000,
      uid: 60_000 + (nextChild % 5000),
      accounting: "child",
      slackMs: 50,
      poolSize: 0,
      cpuList: "",
      batchOps: false,
      ...opts,
    };
    // Round 2's sabotage: undo a fix, to check that its test catches it.
    if (sabotage.has("accounting")) this.opts.accounting = "host";
    if (sabotage.has("pool")) this.opts.poolSize = 0;
    if (sabotage.has("slack")) this.opts.slackMs = 60_000;
  }

  get pid(): number | undefined {
    return this.child?.proc.pid;
  }
  get cgroupPath(): string | null {
    return this.child?.cgroup ?? null;
  }

  /** Spawns the child and waits for its function list (Convex's analyze). */
  async start(): Promise<{ functions: Record<string, Kind>; spawnToReadyMs: number }> {
    if (this.opts.poolSize > 0) {
      this.pool = Array.from({ length: this.opts.poolSize }, () => this.spawn(this.opts.app));
      const lists = await Promise.all(this.pool.map((c) => c.ready));
      const first = this.pool[0] as Child;
      return {
        functions: lists[0] as Record<string, Kind>,
        spawnToReadyMs: (first.readyAt as number) - first.spawnedAt,
      };
    }
    const child = this.spawn(this.opts.app);
    this.child = child;
    const functions = await child.ready;
    return { functions, spawnToReadyMs: (child.readyAt as number) - child.spawnedAt };
  }

  /**
   * A push (hot swap): the new code starts in a new child while the old one keeps serving; once it is ready new
   * calls go to it, and the old child is stopped when its in-flight calls end. Returns the time until the switch.
   */
  async push(app: string): Promise<{ switchMs: number; functions: Record<string, Kind> }> {
    const t = clock();
    const next = this.spawn(app);
    const functions = await next.ready;
    const old = this.child;
    this.child = next;
    this.opts.app = app;
    if (old) void this.drain(old);
    return { switchMs: clock() - t, functions };
  }

  private async drain(old: Child) {
    while (old.calls.size > 0) await realRuntime.sleep(5);
    old.death ??= { reason: "stopped", message: "stopped" };
    old.proc.kill("SIGKILL");
    await old.exited;
  }

  async stop() {
    this.stopped = true;
    const all = [this.child, ...this.pool].filter((c): c is Child => c !== null);
    this.child = null;
    this.pool = [];
    for (const c of all) {
      c.death ??= { reason: "stopped", message: "stopped" };
      c.proc.kill("SIGKILL");
    }
    await Promise.all(all.map((c) => c.exited));
    if (this.opts.sandbox === "bwrap") removeCgroup(join(CGROUP_ROOT, this.opts.name));
  }

  /** The pids and cgroups of every live child (the pool's, or the one child's). */
  get children(): { pid: number; cgroup: string | null }[] {
    return [this.child, ...this.pool]
      .filter((c): c is Child => c !== null && !c.death)
      .map((c) => ({ pid: c.proc.pid, cgroup: c.cgroup }));
  }

  /** A pool child for one call: a free live one, else a replacement for a dead one, else wait for one to finish. */
  private async acquire(): Promise<Child> {
    for (;;) {
      if (this.stopped) throw new Error("deployment stopped");
      const i = this.pool.findIndex((c) => c.death !== null);
      if (i >= 0) {
        const dead = this.pool[i] as Child;
        const fresh = this.spawn(this.opts.app);
        this.pool[i] = fresh;
        void dead.exited.then(() => this.release());
      }
      const free = this.pool.find((c) => !c.death && !c.busy && c.readyAt !== null);
      if (free) {
        free.busy = true;
        return free;
      }
      const pending = this.pool.find((c) => !c.death && !c.busy && c.readyAt === null);
      if (pending) {
        await pending.ready.catch(() => {});
        continue;
      }
      await new Promise<void>((r) => this.waiting.push(r));
    }
  }
  private release() {
    this.waiting.shift()?.();
  }

  /** Stand-ins for the child's functions, to `register` on the real `Functions` (module → name → def). */
  stubs(functions: Record<string, Kind>): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [path, kind] of Object.entries(functions)) {
      const [mod, name] = path.split(":") as [string, string];
      const handler = ((ctx: AnyCtx, args: unknown) => this.call(path, kind, ctx, args)) as never;
      out[mod] ??= {};
      out[mod][name] = kind === "query" ? query(handler) : kind === "mutation" ? mutation(handler) : action(handler);
    }
    return out;
  }

  /** Runs `fn` in the child, answering its ops with `ctx` (the engine's real context for this execution). */
  async call(fn: string, kind: Kind, ctx: AnyCtx, args: unknown): Promise<unknown> {
    let child: Child;
    if (this.opts.poolSize > 0) {
      // Waiting for a free child is system time, not the call's own: the engine's timer is paused meanwhile.
      child = await pausingUserTime(() => this.acquire());
      try {
        return await this.callOn(child, fn, kind, ctx, args);
      } finally {
        child.busy = false;
        this.release();
      }
    }
    if (!this.child) throw new Error("deployment stopped");
    child = this.child.death ? await this.respawn() : this.child;
    await child.ready;
    return this.callOn(child, fn, kind, ctx, args);
  }

  private callOn(child: Child, fn: string, kind: Kind, ctx: AnyCtx, args: unknown): Promise<unknown> {
    // "child" accounting: the engine's own cooperative timer (STUDY-41) would count the whole wait, IPC included,
    // as user time; it is paused, and the budget is enforced here from the child's reports. A real executor would
    // charge the reported time to the engine's timer instead (see the study's plan, PR 3).
    if (this.opts.accounting === "child") return pausingUserTime(() => this.callOnce(child, fn, kind, ctx, args));
    return this.callOnce(child, fn, kind, ctx, args);
  }

  private callOnce(child: Child, fn: string, kind: Kind, ctx: AnyCtx, args: unknown): Promise<unknown> {
    // Inside a query or mutation these come from the engine's deterministic globals (seeded per execution).
    const seed = Math.floor(Math.random() * 2 ** 32);
    const now = Date.now();
    const id = ++nextCall;
    const budgetMs = kind === "action" ? this.opts.actionTimeoutMs : this.opts.userTimeoutMs;
    return new Promise((resolve, reject) => {
      const call: Call = {
        id,
        fn,
        kind,
        ctx,
        // Ops and log lines run back in this execution's async context (the engine's per-execution state).
        scope: new AsyncResource("bunvex.sandbox.call"),
        resolve,
        reject,
        budgetMs,
        usedMs: 0,
        runningSince: null,
        opsInFlight: 0,
        timer: null,
      };
      child.calls.set(id, call);
      this.resume(child, call);
      const m: ToChild = { t: "call", call: id, fn, kind, args: encode(args), seed, now, env: this.opts.env ?? {} };
      this.send(child, m);
    });
  }

  private resume(child: Child, call: Call) {
    call.runningSince = clock();
    if (sabotage.has("timeout")) return;
    const slack = this.opts.accounting === "child" ? this.opts.slackMs : 0;
    call.timer = realRuntime.setTimeout(
      () => this.timedOut(child, call),
      Math.max(0, call.budgetMs - call.usedMs + slack),
    );
  }
  private pause(call: Call) {
    if (call.runningSince !== null && this.opts.accounting === "host") call.usedMs += clock() - call.runningSince;
    call.runningSince = null;
    if (call.timer) realRuntime.clearTimeout(call.timer as never);
    call.timer = null;
  }

  /** The budget ran out while the child was running app code: only killing the process stops a loop. */
  private timedOut(child: Child, call: Call) {
    if (child.death) return;
    const firedAt = clock();
    this.lastKill = { firedAt, exitedAt: null, respawnedAt: null };
    child.death = { reason: "timeout", message: timeoutMessage(call.budgetMs) };
    this.finish(child, call, false, new Error(timeoutMessage(call.budgetMs)));
    child.proc.kill("SIGKILL");
  }

  private finish(child: Child, call: Call, ok: boolean, value: unknown) {
    if (!child.calls.delete(call.id)) return;
    this.pause(call);
    call.scope.emitDestroy();
    if (ok) call.resolve(value);
    else call.reject(value);
  }

  private async respawn(): Promise<Child> {
    const dead = this.child as Child;
    await dead.exited;
    if (this.child === dead) this.child = this.spawn(this.opts.app);
    const fresh = this.child as Child;
    await fresh.ready;
    if (this.lastKill && this.lastKill.respawnedAt === null) this.lastKill.respawnedAt = clock();
    return fresh;
  }

  private spawn(app: string): Child {
    const ready = Promise.withResolvers<Record<string, Kind>>();
    const batch: Record<string, string> = this.opts.batchOps ? { SANDBOX_BATCH: "1" } : {};
    const env = { APP: app, VALUES: join(VALUES_DIR, "src/index.ts"), ...batch };
    let cmd: string[];
    let cgroup: string | null = null;
    const name = `${this.opts.name}-${++nextChild}`;
    if (this.opts.sandbox === "bwrap") {
      cgroup = makeCgroup(this.opts.name, name, this.opts);
      cmd = bwrapCommand(app, cgroup, batch);
    } else if (this.opts.sandbox === "confine") cmd = confineCommand(app, this.opts.uid, this.opts.pidsMax);
    else if (this.opts.sandbox === "seatbelt") cmd = seatbeltCommand(app);
    else cmd = [process.execPath, join(RUNNER_DIR, "child.ts")];
    const child: Child = {
      proc: undefined as unknown as Subprocess,
      ready: ready.promise,
      calls: new Map(),
      cgroup,
      spawnedAt: clock(),
      readyAt: null,
      death: null,
      exited: undefined as unknown as Promise<number>,
      busy: false,
      outbox: [],
    };
    if (this.opts.cpuList) cmd = ["/usr/bin/taskset", "-c", this.opts.cpuList, ...cmd];
    child.proc = Bun.spawn(cmd, {
      env:
        this.opts.sandbox === "confine"
          ? { ...(sabotage.has("env") ? process.env : {}), ...env, HOME: "/nonexistent" }
          : this.opts.sandbox !== "bwrap"
            ? { ...env, PATH: process.env.PATH ?? "" }
            : sabotage.has("env")
              ? { ...process.env }
              : { PATH: "/usr/bin:/bin" },
      ipc: (m) => this.onMessage(child, m as ToHost, ready.resolve),
      serialization: "json",
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.exited = child.proc.exited.then((code) => {
      const exitedAt = clock();
      if (this.lastKill && this.lastKill.exitedAt === null && child.death?.reason === "timeout")
        this.lastKill.exitedAt = exitedAt;
      const peak = cgroup ? readNumber(join(cgroup, "memory.peak")) : null;
      if (!child.death) {
        const oom = cgroup !== null && oomKills(cgroup) > 0;
        child.death = oom
          ? { reason: "oom", message: oomMessage(this.opts.memoryMiB) }
          : { reason: "crash", message: INTERNAL_ERROR };
      }
      this.lastDeath = { reason: child.death.reason, peakMiB: peak === null ? null : peak / 2 ** 20 };
      ready.reject(new Error(`sandbox exited before it was ready (${child.death.reason}, code ${code})`));
      for (const call of [...child.calls.values()]) this.finish(child, call, false, new Error(child.death.message));
      if (cgroup) removeCgroup(cgroup);
      return code;
    });
    ready.promise.catch(() => {});
    return child;
  }

  private onMessage(child: Child, m: ToHost, onReady: (f: Record<string, Kind>) => void) {
    if (m.t === "ready") {
      child.readyAt = clock();
      onReady(m.functions);
      return;
    }
    if (m.t === "ops") {
      if (Array.isArray(m.list)) for (const o of m.list) if (o?.t !== "ops") this.onMessage(child, o, onReady);
      return;
    }
    const call = child.calls.get(m.call);
    // A message for no running call (or a malformed one) is the child misbehaving: ignored, never trusted.
    if (!call) return;
    if (m.t === "log") {
      call.scope.runInAsyncScope(() => (this.opts.onLog ?? defaultLog)(m.level, m.text));
      return;
    }
    if (this.opts.accounting === "child" && (m.t === "op" || m.t === "done")) {
      call.usedMs += Math.max(0, Number(m.ran) || 0);
      if (call.usedMs > call.budgetMs) {
        // The call's own JS ran past its budget. Its process is waiting on this op or done: nothing to kill.
        if (m.t === "op")
          this.send(child, {
            t: "result",
            call: call.id,
            op: m.op,
            ok: false,
            error: { name: "Error", message: timeoutMessage(call.budgetMs) },
          });
        this.finish(child, call, false, new Error(timeoutMessage(call.budgetMs)));
        return;
      }
    }
    if (m.t === "done") {
      if (m.ok) this.finish(child, call, true, decode(m.value));
      else this.finish(child, call, false, toError(m.error));
      return;
    }
    if (m.t === "op") {
      if (call.opsInFlight++ === 0) this.pause(call);
      call.scope.runInAsyncScope(() =>
        runOp(call, m.name, m.args).then(
          (value) => this.answer(child, call, { t: "result", call: call.id, op: m.op, ok: true, value: encode(value) }),
          (e) =>
            this.answer(child, call, {
              t: "result",
              call: call.id,
              op: m.op,
              ok: false,
              error: { name: (e as Error)?.name ?? "Error", message: String((e as Error)?.message ?? e) },
            }),
        ),
      );
    }
  }

  private answer(child: Child, call: Call, m: ToChild) {
    if (!child.calls.has(call.id) || child.death) return;
    if (--call.opsInFlight === 0) this.resume(child, call);
    this.send(child, m);
  }

  /** With batchOps, the answers produced in one tick go out as one message. */
  private send(child: Child, m: ToChild) {
    if (!this.opts.batchOps) {
      child.proc.send(m);
      return;
    }
    child.outbox.push(m);
    if (child.outbox.length === 1)
      queueMicrotask(() => {
        const list = child.outbox;
        child.outbox = [];
        if (child.death) return;
        child.proc.send(list.length === 1 ? (list[0] as ToChild) : { t: "results", list });
      });
  }
}

const defaultLog = (level: string, text: string) =>
  (console as unknown as Record<string, (t: string) => void>)[level]?.(text);

function toError(e: WireError): Error {
  const err = new Error(e.message);
  err.name = e.name;
  if (e.data !== undefined && e.data !== null) Object.assign(err, { data: decode(e.data) });
  return err;
}

/** The ops a function of each kind may use: the host enforces it, whatever the child sends. */
const ALLOWED: Record<Kind, Set<string>> = {
  query: new Set(["get", "system.get", "query", "normalizeId", "auth.getUserIdentity", "runQuery"]),
  mutation: new Set([
    "get",
    "system.get",
    "query",
    "normalizeId",
    "insert",
    "patch",
    "replace",
    "delete",
    "auth.getUserIdentity",
    "scheduler.runAfter",
    "scheduler.runAt",
    "scheduler.cancel",
    "runQuery",
    "runMutation",
  ]),
  action: new Set([
    "auth.getUserIdentity",
    "scheduler.runAfter",
    "scheduler.runAt",
    "scheduler.cancel",
    "runQuery",
    "runMutation",
    "runAction",
    "fetch",
  ]),
};

type Plan = { table: string; system: boolean; steps: [string, Wire[]][]; terminal: string; args: Wire[] };
const isChain = (w: Wire): w is { $chain: Wire } =>
  w !== null && typeof w === "object" && !Array.isArray(w) && "$chain" in w;
const fromBuilder = (w: Wire) => (b: unknown) => (isChain(w) ? replay(b, w.$chain as unknown as Step[]) : decode(w));

async function runOp(call: Call, name: string, wireArgs: Wire[]): Promise<unknown> {
  if (!ALLOWED[call.kind].has(name)) throw new Error(`${name} is not available in a ${call.kind}`);
  // A query's plan holds recorded expressions, replayed below on the real builders; everything else is values.
  const args = name === "query" ? [] : wireArgs.map((a) => decode(a));
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  // `null` stands for an argument the app left out (JSON has no `undefined`).
  while (args.length > 0 && args[args.length - 1] === null && (name === "get" || name === "delete")) args.pop();
  const { ctx } = call;
  switch (name) {
    case "get":
      return ctx.db.get(...args);
    case "system.get":
      return ctx.db.system.get(...args);
    case "normalizeId":
      return ctx.db.normalizeId(...args);
    case "insert":
    case "patch":
    case "replace":
    case "delete":
      return ctx.db[name](...args.filter((a) => a !== null));
    case "query": {
      const plan = wireArgs[0] as unknown as Plan;
      let q = (plan.system ? ctx.db.system : ctx.db).query(plan.table);
      for (const [m, a] of plan.steps) {
        if (m === "withIndex" || m === "withSearchIndex")
          q = q[m](a[0], a[1] === null ? undefined : fromBuilder(a[1] as Wire));
        else if (m === "filter") q = q.filter(fromBuilder(a[0] as Wire));
        else if (m === "order" || m === "limit" || m === "fullTableScan") q = q[m](...a.map((x) => decode(x)));
        else throw new Error(`unknown query step ${m}`);
      }
      if (!["take", "first", "unique", "collect", "count", "paginate"].includes(plan.terminal))
        throw new Error(`unknown query terminal ${plan.terminal}`);
      return q[plan.terminal](...plan.args.map((x) => decode(x)));
    }
    case "auth.getUserIdentity":
      return ctx.auth.getUserIdentity();
    case "scheduler.runAfter":
      return ctx.scheduler.runAfter(...args);
    case "scheduler.runAt":
      return ctx.scheduler.runAt(...args);
    case "scheduler.cancel":
      return ctx.scheduler.cancel(...args);
    case "runQuery":
    case "runMutation":
    case "runAction":
      return ctx[name](args[0], args[1] ?? {});
    case "fetch": {
      // A prototype: the real executor sends this through the action fetch path (its SSRF screen, STUDY-80).
      const [url, init] = args as [string, { method: string; headers: Record<string, string>; body: string | null }];
      const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body ?? undefined });
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() };
    }
  }
  throw new Error(`unknown op ${name}`);
}

// --- Linux: cgroup v2 and bubblewrap ---

/**
 * `<root>/<deployment>/<child>`: the deployment's cgroup holds its CPU share (cpu.max, for all its children
 * together, so a pool cannot multiply it), each child's leaf its memory and pid caps (per process, so per call in a
 * pool of one-call processes).
 */
function makeCgroup(deployment: string, name: string, o: { memoryMiB: number; pidsMax: number; cpus: number }): string {
  if (!existsSync(CGROUP_ROOT)) {
    mkdirSync(CGROUP_ROOT);
  }
  const dep = join(CGROUP_ROOT, deployment);
  const fresh = !existsSync(dep);
  mkdirSync(dep, { recursive: true });
  // Controllers must be enabled for the children of the parent, of our subtree, and of the deployment.
  for (const dir of [dirname(CGROUP_ROOT), CGROUP_ROOT, dep]) enableControllers(dir);
  if (fresh) writeFileSync(join(dep, "cpu.max"), `${Math.round(o.cpus * 100_000)} 100000`);
  const dir = join(dep, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.max"), String((sabotage.has("memory") ? 2048 : o.memoryMiB) * 1024 * 1024));
  writeFileSync(join(dir, "memory.swap.max"), "0");
  writeFileSync(join(dir, "pids.max"), String(o.pidsMax));
  return dir;
}

/**
 * Enables memory, pids and cpu for `dir`'s children. A non-root cgroup that holds processes cannot (cgroup v2's
 * "no internal processes" rule): inside a container, or in a delegated systemd unit, its processes move to a leaf
 * `init` first, as container runtimes do.
 */
function enableControllers(dir: string) {
  const enabled = readFileSync(join(dir, "cgroup.subtree_control"), "utf8").split(/\s+/);
  const missing = ["memory", "pids", "cpu"].filter((c) => !enabled.includes(c));
  if (missing.length === 0) return;
  const write = () => writeFileSync(join(dir, "cgroup.subtree_control"), missing.map((c) => `+${c}`).join(" "));
  try {
    write();
  } catch (e) {
    if ((e as { code?: string }).code !== "EBUSY") throw e;
    const init = join(dir, "init");
    mkdirSync(init, { recursive: true });
    for (const pid of readFileSync(join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean))
      try {
        writeFileSync(join(init, "cgroup.procs"), pid);
      } catch {}
    write();
  }
}

function readNumber(path: string): number | null {
  try {
    return Number(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function oomKills(dir: string): number {
  try {
    const m = /oom_kill (\d+)/.exec(readFileSync(join(dir, "memory.events"), "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function removeCgroup(dir: string) {
  for (let i = 0; i < 50; i++) {
    try {
      rmdirSync(dir);
      return;
    } catch {
      Bun.sleepSync(2);
    }
  }
}

export function bwrapCommand(app: string, cgroup: string, extraEnv: Record<string, string> = {}): string[] {
  const appDir = dirname(app);
  const ns = sabotage.has("net")
    ? ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]
    : ["--unshare-all"];
  const args = [
    ...ns,
    "--uid",
    "65534",
    "--gid",
    "65534",
    "--hostname",
    "sandbox",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    ...(sabotage.has("env") ? [] : ["--clearenv"]),
    "--setenv",
    "NODE_CHANNEL_FD",
    "3",
    "--setenv",
    "NODE_CHANNEL_SERIALIZATION_MODE",
    "json",
    "--setenv",
    "APP",
    `/app/${app.slice(appDir.length + 1)}`,
    "--setenv",
    "VALUES",
    "/values/src/index.ts",
    "--setenv",
    "HOME",
    "/tmp",
    ...Object.entries(extraEnv).flatMap(([k, v]) => ["--setenv", k, v]),
    "--ro-bind",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/x86_64-linux-gnu",
    "--ro-bind",
    "/usr/lib64",
    "/usr/lib64",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--ro-bind",
    process.execPath,
    "/bun",
    "--ro-bind",
    RUNNER_DIR,
    "/runner",
    "--ro-bind",
    appDir,
    "/app",
    "--ro-bind",
    VALUES_DIR,
    "/values",
    "--dev",
    "/dev",
    ...(NO_PROC ? [] : ["--proc", "/proc"]),
    "--tmpfs",
    "/tmp",
  ];
  if (sabotage.has("fs")) args.push("--ro-bind", "/etc", "/etc", "--ro-bind", "/root", "/root");
  const seccomp = !sabotage.has("seccomp") && existsSync(SECCOMP_BPF);
  if (seccomp) args.push("--seccomp", "9");
  args.push("/bun", "/runner/child.ts");
  // The shell moves itself into the cgroup before exec, so the child never runs outside it.
  const intoCgroup = sabotage.has("cgroup") ? "" : 'echo $$ > "$CG/cgroup.procs" && ';
  const script = `${intoCgroup}exec "$BWRAP" "$@"${seccomp ? ` 9< "${SECCOMP_BPF}"` : ""}`;
  return ["/usr/bin/env", `CG=${cgroup}`, `BWRAP=${BWRAP}`, "/bin/sh", "-c", script, "sh", ...args];
}

// --- Linux without namespaces (a container with Docker's default options): uid, Landlock, seccomp, rlimits ---

const CONFINE = join(import.meta.dir, "confine");

/**
 * `setpriv` drops to the deployment's own uid with no capabilities (a container's root may do this by default),
 * then `confine` (confine.c) applies Landlock (reads only beneath the runtime, the runner and the app; no TCP at
 * all), the seccomp deny list and RLIMIT_NPROC before it execs bun. No pid, mount or network namespace, and no
 * cgroup: memory is capped only by the container's own limit.
 */
export function confineCommand(app: string, uid: number, pidsMax: number): string[] {
  const ro = ["/usr", "/lib", "/lib64", process.execPath, RUNNER_DIR, dirname(app), VALUES_DIR, "/proc/self"];
  const setpriv = sabotage.has("uid")
    ? []
    : [
        "/usr/bin/setpriv",
        `--reuid=${uid}`,
        `--regid=${uid}`,
        "--clear-groups",
        "--inh-caps=-all",
        "--bounding-set=-all",
        "--",
      ];
  return [
    ...setpriv,
    CONFINE,
    ...(sabotage.has("landlock") ? ["--no-landlock"] : []),
    ...(sabotage.has("seccomp") ? [] : ["--bpf", SECCOMP_BPF]),
    ...(sabotage.has("cgroup") ? [] : ["--nproc", String(pidsMax)]),
    ...ro.filter((p) => existsSync(p)).flatMap((p) => ["--ro", p]),
    "--ro",
    "/dev/urandom",
    "--rw",
    "/dev/null",
    ...(sabotage.has("fs") ? ["--ro", "/"] : []),
    "--",
    process.execPath,
    join(RUNNER_DIR, "child.ts"),
  ];
}

// --- macOS dev: Seatbelt (`sandbox-exec`, deprecated by Apple but still shipped) ---

/**
 * A Seatbelt profile for the child: no network, no writes, and no reads under the user's home except the bun
 * binary, the runner, the app and `bunvex/values`. System paths stay readable (the dyld cache, frameworks), so
 * this is a dev-mode guard, not a cloud boundary: no pid or memory limits, and the kernel surface is all there.
 */
export function seatbeltCommand(app: string): string[] {
  const home = process.env.HOME ?? "/Users";
  const allowRead = [process.execPath, RUNNER_DIR, dirname(app), VALUES_DIR];
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(allow network* (remote unix-socket))",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-read* (subpath ${JSON.stringify(home)}) (subpath "/private/tmp") (subpath "/private/var/folders"))`,
    `(allow file-read* ${allowRead.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ")})`,
    "(deny process-fork)",
    "(deny signal (target others))",
  ].join("\n");
  return ["/usr/bin/sandbox-exec", "-p", profile, process.execPath, join(RUNNER_DIR, "child.ts")];
}

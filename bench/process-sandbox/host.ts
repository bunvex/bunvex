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
import { realRuntime } from "@bunvex/core";
import type { Subprocess } from "bun";
import { action, mutation, query } from "bunvex/server";
import { decode, encode, replay, type Step, type ToChild, type ToHost, type Wire, type WireError } from "./wire.ts";

// The host's own clock and timers: inside an execution the globals are the deterministic ones (frozen, refused).
const clock = realRuntime.monotonicNow;
/** Env SANDBOX_SABOTAGE (tests only): drop one protection, to check that a test catches it. */
const sabotage = new Set((process.env.SANDBOX_SABOTAGE ?? "").split(",").filter(Boolean));

type Kind = "query" | "mutation" | "action";
// biome-ignore lint/suspicious/noExplicitAny: the engine's ctx, called by op name
type AnyCtx = Record<string, any>;

export type SandboxOptions = {
  /** The app module the child loads (its exports are `{ name: query(…) }` groups, as a bunvex module). */
  app: string;
  /** "bwrap": Linux namespaces + seccomp + cgroup; "none": a plain child process (macOS dev, baselines). */
  sandbox?: "bwrap" | "seatbelt" | "none";
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
};

/** Convex's user-facing messages (crates/isolate/src/termination.rs), bunvex's words where they name the product. */
export const timeoutMessage = (ms: number) => `Function execution timed out (maximum duration: ${ms / 1000}s)`;
export const oomMessage = (mib: number) => `JavaScript execution ran out of memory (maximum memory usage: ${mib} MB)`;
export const INTERNAL_ERROR = "Your request couldn't be completed. Try again later.";

const RUNNER_DIR = import.meta.dir;
const VALUES_DIR = resolve(import.meta.dir, "../../packages/values");
const CGROUP_ROOT = "/sys/fs/cgroup/bunvex-study";
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
};

let nextCall = 0;
let nextChild = 0;

export class SandboxedDeployment {
  private child: Child | null = null;
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
      ...opts,
    };
  }

  get pid(): number | undefined {
    return this.child?.proc.pid;
  }
  get cgroupPath(): string | null {
    return this.child?.cgroup ?? null;
  }

  /** Spawns the child and waits for its function list (Convex's analyze). */
  async start(): Promise<{ functions: Record<string, Kind>; spawnToReadyMs: number }> {
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
    const c = this.child;
    this.child = null;
    if (!c) return;
    c.death ??= { reason: "stopped", message: "stopped" };
    c.proc.kill("SIGKILL");
    await c.exited;
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
    let child = this.child;
    if (!child) throw new Error("deployment stopped");
    if (child.death) child = await this.respawn();
    await child.ready;
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
      child.proc.send(m);
    });
  }

  private resume(child: Child, call: Call) {
    call.runningSince = clock();
    if (sabotage.has("timeout")) return;
    call.timer = realRuntime.setTimeout(() => this.timedOut(child, call), Math.max(0, call.budgetMs - call.usedMs));
  }
  private pause(call: Call) {
    if (call.runningSince !== null) call.usedMs += clock() - call.runningSince;
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
    const env = { APP: app, VALUES: join(VALUES_DIR, "src/index.ts") };
    let cmd: string[];
    let cgroup: string | null = null;
    const name = `${this.opts.name}-${++nextChild}`;
    if (this.opts.sandbox === "bwrap") {
      cgroup = makeCgroup(name, this.opts);
      cmd = bwrapCommand(app, cgroup);
    } else if (this.opts.sandbox === "seatbelt") cmd = seatbeltCommand(app);
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
    };
    child.proc = Bun.spawn(cmd, {
      env:
        this.opts.sandbox !== "bwrap"
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
    const call = child.calls.get(m.call);
    // A message for no running call (or a malformed one) is the child misbehaving: ignored, never trusted.
    if (!call) return;
    if (m.t === "log") {
      call.scope.runInAsyncScope(() => (this.opts.onLog ?? defaultLog)(m.level, m.text));
      return;
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
    child.proc.send(m);
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

function makeCgroup(name: string, o: { memoryMiB: number; pidsMax: number; cpus: number }): string {
  if (!existsSync(CGROUP_ROOT)) {
    mkdirSync(CGROUP_ROOT);
  }
  // Controllers must be enabled for the children of the root and of our subtree.
  for (const dir of ["/sys/fs/cgroup", CGROUP_ROOT]) {
    const enabled = readFileSync(join(dir, "cgroup.subtree_control"), "utf8");
    for (const c of ["memory", "pids", "cpu"])
      if (!enabled.split(/\s+/).includes(c)) writeFileSync(join(dir, "cgroup.subtree_control"), `+${c}`);
  }
  const dir = join(CGROUP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory.max"), String((sabotage.has("memory") ? 2048 : o.memoryMiB) * 1024 * 1024));
  writeFileSync(join(dir, "memory.swap.max"), "0");
  writeFileSync(join(dir, "pids.max"), String(o.pidsMax));
  writeFileSync(join(dir, "cpu.max"), `${Math.round(o.cpus * 100_000)} 100000`);
  return dir;
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

export function bwrapCommand(app: string, cgroup: string): string[] {
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
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  if (sabotage.has("fs")) args.push("--ro-bind", "/etc", "/etc", "--ro-bind", "/root", "/root");
  const seccomp = !sabotage.has("seccomp") && existsSync(SECCOMP_BPF);
  if (seccomp) args.push("--seccomp", "9");
  args.push("/bun", "/runner/child.ts");
  // The shell moves itself into the cgroup before exec, so the child never runs outside it.
  const intoCgroup = sabotage.has("cgroup") ? "" : 'echo $$ > "$CG/cgroup.procs" && ';
  const script = `${intoCgroup}exec bwrap "$@"${seccomp ? ` 9< "${SECCOMP_BPF}"` : ""}`;
  return ["/usr/bin/env", `CG=${cgroup}`, "/bin/sh", "-c", script, "sh", ...args];
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

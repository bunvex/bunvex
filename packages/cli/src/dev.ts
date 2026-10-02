// `bunvex dev` (STUDY-37 PR 5): push the functions, then push again whenever they change, as Convex's
// `npx convex dev` (npm-packages/convex/src/cli/dev.ts, lib/dev.ts):
//
// - each push is `bunvex deploy`'s: codegen, bundle, start_push, codegen, typecheck, wait_for_schema,
//   finish_push; then `✔ HH:MM:SS bunvex functions ready! (Xs)`;
// - after the first success only, `--run <fn>` runs a function, or `--start <cmd>` starts a command;
// - the functions directory is watched (`_generated/` and dotfiles aside); a push follows a change once the
//   files are quiet for 500 ms, and a change during a push is pushed again after it;
// - a failed push waits for the next change (an app error) or retries with Convex's backoff (an unreachable
//   deployment, a push race): 500 ms, doubling to 16 s, ±50%;
// - `--once` pushes once; `--until-success` until one succeeds;
// - without a configured deployment, a local one runs in this process, its data in `.bunvex/` (E6).
// Log tailing needs log streaming (item 12): `--tail-logs` is accepted and off until then (E7).
import { type FSWatcher, watch } from "node:fs";
import { sep } from "node:path";
import { adminKeyCipherKey, issueAdminKey } from "@bunvex/server";
import type { TypecheckMode } from "./codegen.ts";
import { deploy, functionsDir } from "./deploy.ts";
import type { Io } from "./io.ts";
import { runCommand } from "./run.ts";
import { readCredentials, startServer } from "./start.ts";
import { resolveTarget, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const DEV_USAGE = `Usage: bunvex dev [options]

Push the functions to the deployment, then push again whenever they change. Without a configured
deployment, run a local one in this process (its data in .bunvex/).

Options:
${TARGET_OPTIONS}
  --once               push once, then exit
  --until-success      push until one succeeds, then exit
  --run <function>     after the first successful push, run this function
  --start <command>    after the first successful push, start this shell command
  --typecheck <mode>   enable, try (default) or disable
  --codegen <mode>     enable (default) or disable
  --tail-logs <mode>   always, pause-on-deploy or disable (logs come with log streaming; off until then)
  --local-port <n>     the local deployment's port (default 3210)`;

type Flags = {
  once: boolean;
  untilSuccess: boolean;
  run?: string;
  start?: string;
  typecheck: TypecheckMode;
  codegen: boolean;
  tailLogs: string;
  localPort: number;
};

function parseFlags(args: string[]): Flags | string {
  const f: Flags = {
    once: false,
    untilSuccess: false,
    typecheck: "try",
    codegen: true,
    tailLogs: "disable",
    localPort: 3210,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--once") f.once = true;
    else if (name === "--until-success") f.untilSuccess = true;
    else if (["--run", "--start", "--typecheck", "--codegen", "--tail-logs", "--local-port"].includes(name)) {
      const v = inline ?? args[++i];
      if (v === undefined) return `${name} needs a value`;
      if (name === "--run") f.run = v;
      else if (name === "--start") f.start = v;
      else if (name === "--typecheck") {
        if (v !== "enable" && v !== "try" && v !== "disable") return "--typecheck must be enable, try or disable";
        f.typecheck = v;
      } else if (name === "--codegen") {
        if (v !== "enable" && v !== "disable") return "--codegen must be enable or disable";
        f.codegen = v === "enable";
      } else if (name === "--tail-logs") {
        if (!["always", "pause-on-deploy", "disable"].includes(v))
          return "--tail-logs must be always, pause-on-deploy or disable";
        f.tailLogs = v;
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) return `--local-port must be a port number, got '${v}'`;
        f.localPort = n;
      }
    } else return `unknown option ${a}`;
  }
  if (f.run !== undefined && f.start !== undefined) return "--run and --start cannot be used together";
  return f;
}

/** The functions directory, watched: dirty when a file that matters changed, `quiet()` once it settles. */
class DirWatcher {
  dirty = false;
  private watcher: FSWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: (() => void) | null = null;
  constructor(
    dir: string,
    private quietMs = 500,
  ) {
    this.watcher = watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      const parts = String(file).split(sep);
      if (parts[0] === "_generated" || parts.some((p) => p.startsWith(".") || p === "node_modules")) return;
      this.dirty = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const w = this.waiting;
        this.waiting = null;
        w?.();
      }, this.quietMs);
    });
  }
  /** Resolves once a change has happened and the files have been quiet for a while (or on abort). */
  quiet(signal: AbortSignal): Promise<void> {
    return new Promise((done) => {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        done();
      };
      if (signal.aborted) return done();
      signal.addEventListener("abort", finish, { once: true });
      // A change already seen and settled: go at once.
      if (this.dirty && this.timer === undefined) return finish();
      this.waiting = finish;
    });
  }
  /** Start a push: forget what came before. */
  reset() {
    this.dirty = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  close() {
    clearTimeout(this.timer);
    this.watcher.close();
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        done();
      },
      { once: true },
    );
  });

const clock = () => new Date().toTimeString().slice(0, 8);

/** A local deployment in this process (E6): `bunvex start` with its data in `.bunvex/`, and its admin key. */
async function localDeployment(io: Io, port: number) {
  const started = await startServer(["--port", String(port), "--data-dir", ".bunvex"], io);
  if (typeof started === "number") return null;
  const { name, secret } = readCredentials(`${io.cwd}/.bunvex`);
  const adminKey = issueAdminKey({ instanceName: name!, cipherKey: adminKeyCipherKey(secret!) });
  return { target: { url: started.url, adminKey } satisfies Target, stop: started.stop };
}

export async function devCommand(args: string[], io: Io, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DEV_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  const flags = typeof taken === "string" ? taken : parseFlags(taken.rest);
  if (typeof taken === "string" || typeof flags === "string") {
    io.err(`bunvex dev: ${typeof taken === "string" ? taken : flags}\n\n${DEV_USAGE}`);
    return 2;
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onSignal, { once: true });
  else for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, onSignal);
  const cleanup: (() => unknown)[] = [];
  let exitCode = 0;
  try {
    let target = resolveTarget(taken.flags, io);
    if (!target) {
      const local = await localDeployment(io, flags.localPort);
      if (!local) return 1;
      cleanup.push(local.stop);
      target = local.target;
      io.err(`bunvex: no deployment configured; running a local one at ${target.url} (data in .bunvex/)`);
    }
    io.err(`Developing against deployment: ${target.url}`);
    if (flags.tailLogs !== "disable") io.err("Log tailing comes with log streaming; --tail-logs is off for now.");
    const dir = functionsDir(io.cwd);
    const watcher = flags.once ? null : new DirWatcher(dir);
    if (watcher) cleanup.push(() => watcher.close());
    // `deploy` prints its own success line; dev prints Convex's instead.
    const pushIo: Io = { ...io, out: (l) => (l.startsWith("✔ Deployed functions") ? undefined : io.out(l)) };
    let first = true;
    let backoff = 500;
    while (!stop.signal.aborted) {
      watcher?.reset();
      const t0 = performance.now();
      io.err("Preparing bunvex functions...");
      const r = await deploy(target, { dryRun: false, codegen: flags.codegen, typecheck: flags.typecheck }, pushIo);
      if (stop.signal.aborted) break;
      if (r.code === 0) {
        backoff = 500;
        io.err(`✔ ${clock()} bunvex functions ready! (${((performance.now() - t0) / 1000).toFixed(2)}s)`);
        if (first) {
          first = false;
          if (flags.run !== undefined) {
            const code = await runCommand([flags.run, "--url", target.url, "--admin-key", target.adminKey], io);
            if (code !== 0) {
              exitCode = 1;
              break;
            }
            io.err(`Finished running function "${flags.run}"`);
          }
          if (flags.start !== undefined) {
            const cmd = flags.start;
            const child = Bun.spawn(["sh", "-c", cmd], { cwd: io.cwd, stdio: ["inherit", "inherit", "inherit"] });
            cleanup.push(() => child.kill());
            void child.exited.then((code) => {
              if (code !== 0 && !stop.signal.aborted) {
                io.err(`Command \`${cmd}\` exited with code ${code}`);
                exitCode = 1;
                stop.abort();
              }
            });
          }
        }
        if (flags.once || flags.untilSuccess) break;
      } else if (r.transient) {
        if (flags.once) {
          exitCode = 1;
          break;
        }
        const wait = Math.round(backoff * (0.5 + Math.random()));
        io.err(`Failed due to network error, retrying in ${(wait / 1000).toFixed(2)}s...`);
        await sleep(wait, stop.signal);
        backoff = Math.min(backoff * 2, 16_000);
        continue;
      } else if (flags.once) {
        exitCode = 1;
        break;
      }
      // Wait for the next change (one during the push counts: it was not pushed).
      if (watcher?.dirty) io.err("Filesystem changed during push, retrying...");
      await watcher?.quiet(stop.signal);
    }
    return exitCode;
  } finally {
    if (!opts.signal) for (const s of ["SIGINT", "SIGTERM"] as const) process.off(s, onSignal);
    for (const c of cleanup.reverse()) await c();
  }
}

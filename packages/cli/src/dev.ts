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
// - without a configured deployment, the project's local deployment: `bunvex-local-backend` downloaded and
//   run as a child, its state in `.bunvex/local/default/`, `.env.local` naming it (STUDY-40, as Convex).
// - the deployment's function logs are tailed to stderr (`--tail-logs`, default `pause-on-deploy`: held back
//   while a push runs), as `bunvex logs` prints them (STUDY-47).
import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join, sep } from "node:path";
import type { TypecheckMode } from "./codegen.ts";
import { deploy, functionsDir } from "./deploy.ts";
import type { Io } from "./io.ts";
import {
  configuredDeployment,
  type LocalOptions,
  startLocalDeployment,
  urlVariables,
  writeEnvLocal,
} from "./local-deployment.ts";
import { COLORS, LogManager, type LogMode, NO_COLORS, watchLogs } from "./logs.ts";
import { runCommand } from "./run.ts";
import { resolveTarget, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const DEV_USAGE = `Usage: bunvex dev [options]

Push the functions to the deployment, then push again whenever they change. Without a configured
deployment, run the project's local deployment (bunvex-local-backend; its state in .bunvex/local/default/).

Options:
${TARGET_OPTIONS}
  --once               push once, then exit
  --until-success      push until one succeeds, then exit
  --run <function>     after the first successful push, run this function
  --start <command>    after the first successful push, start this shell command
  --typecheck <mode>   enable, try (default) or disable
  --codegen <mode>     enable (default) or disable
  --tail-logs <mode>   print the deployment's function logs: always, pause-on-deploy (the default: not during
                       a push) or disable
  --local-cloud-port <n>       the local deployment's API port (default: its saved one, else the first free from 3210)
  --local-site-port <n>        its HTTP actions' port (default: its saved one, else the next free)
  --local-backend-version <v>  run this bunvex-local-backend release (a precompiled-… tag) instead of the latest
  --local-force-upgrade        upgrade the local deployment's backend without asking`;

type Flags = {
  once: boolean;
  untilSuccess: boolean;
  run?: string;
  start?: string;
  typecheck: TypecheckMode;
  codegen: boolean;
  tailLogs: LogMode;
  local: LocalOptions;
};

function parseFlags(args: string[]): Flags | string {
  const f: Flags = {
    once: false,
    untilSuccess: false,
    typecheck: "try",
    codegen: true,
    tailLogs: "pause-on-deploy",
    local: {},
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--once") f.once = true;
    else if (name === "--until-success") f.untilSuccess = true;
    else if (name === "--local-force-upgrade") f.local.forceUpgrade = true;
    else if (
      [
        "--run",
        "--start",
        "--typecheck",
        "--codegen",
        "--tail-logs",
        "--local-cloud-port",
        "--local-site-port",
        "--local-backend-version",
      ].includes(name)
    ) {
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
        f.tailLogs = v as LogMode;
      } else if (name === "--local-backend-version") f.local.backendVersion = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return `${name} must be a port number, got '${v}'`;
        if (name === "--local-cloud-port") f.local.cloudPort = n;
        else f.local.sitePort = n;
      }
    } else return `unknown option ${a}`;
  }
  if (f.run !== undefined && f.start !== undefined) return "--run and --start cannot be used together";
  return f;
}

/** Every file's mtime under `dir` (`_generated/`, dotfiles and node_modules aside), by relative path. */
function mtimes(dir: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const walk = (d: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules" || (rel === "" && n === "_generated")) continue;
      const full = join(d, n);
      const r = rel ? `${rel}${sep}${n}` : n;
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full, r);
        else out.set(r, st.mtimeMs);
      } catch {
        // raced with a deletion
      }
    }
  };
  walk(dir, "");
  return out;
}

/** The functions directory, watched: dirty when a file that matters changed, `quiet()` once it settles. */
class DirWatcher {
  dirty = false;
  private watcher: FSWatcher;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: (() => void) | null = null;
  constructor(
    private readonly dir: string,
    private quietMs = 500,
  ) {
    this.snapshot = mtimes(dir);
    this.watcher = watch(dir, { recursive: true }, (_event, file) => {
      if (!file) return;
      const parts = String(file).split(sep);
      if (parts[0] === "_generated" || parts.some((p) => p.startsWith(".") || p === "node_modules")) return;
      // macOS can deliver, late, the events of writes made before: only a file that differs from what the
      // last push saw is a change.
      let mtime: number | null = null;
      try {
        mtime = statSync(join(dir, String(file))).mtimeMs;
      } catch {
        // gone: a deletion is a change (unless it was gone already)
      }
      if (this.snapshot.get(String(file)) === mtime) return;
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
  /** Each file's mtime when the last push began (null: absent). */
  private snapshot = new Map<string, number | null>();

  /** Start a push: forget what came before, and remember the files as the push sees them. */
  reset() {
    this.snapshot = mtimes(this.dir);
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
    const localFlags =
      flags.local.backendVersion !== undefined ||
      flags.local.forceUpgrade ||
      flags.local.cloudPort !== undefined ||
      flags.local.sitePort !== undefined;
    if (target && localFlags) {
      io.err("bunvex dev: the --local-* options are only for a local deployment");
      return 2;
    }
    if (!target) {
      const configured = configuredDeployment(io);
      if (configured && configured.type !== "local") {
        io.err(`bunvex dev: BUNVEX_DEPLOYMENT=${configured.type}:${configured.name} is not a deployment bunvex knows`);
        return 1;
      }
      // Convex's local deployment: the project's own, created on first use (L3).
      let local: Awaited<ReturnType<typeof startLocalDeployment>>;
      try {
        local = await startLocalDeployment(io, flags.local);
      } catch (e) {
        io.err(`bunvex dev: ${(e as Error).message}`);
        return 1;
      }
      cleanup.push(local.stop);
      target = local.target;
      const vars = urlVariables(io.cwd);
      writeEnvLocal(io.cwd, local.config.deploymentName, local.config.ports.cloud, local.config.ports.site);
      io.err(
        `✔ Started running a deployment locally at ${target.url} and saved its:\n    name as BUNVEX_DEPLOYMENT to .env.local\n    URLs as ${vars.url} and ${vars.site} to .env.local`,
      );
    }
    io.err(`Developing against deployment: ${target.url}`);
    // Convex's `watchLogs` to stderr, beside the pushes; a deployment that refuses it is reported once.
    const logManager = new LogManager(flags.tailLogs);
    if (flags.tailLogs !== "disable") {
      const t = target;
      void watchLogs(t, io.err, io.err, {
        success: false,
        colors: io.isTTY ? COLORS : NO_COLORS,
        logManager,
        signal: stop.signal,
      }).then((denied) => {
        if (denied !== null) io.err(`bunvex dev: cannot watch logs: ${denied}`);
      });
    }
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
      logManager.beginDeploy();
      const r = await deploy(target, { dryRun: false, codegen: flags.codegen, typecheck: flags.typecheck }, pushIo);
      logManager.endDeploy();
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
            const shell = process.platform === "win32" ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];
            const child = Bun.spawn(shell, { cwd: io.cwd, stdio: ["inherit", "inherit", "inherit"] });
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
    // Ends the log tailing too.
    stop.abort();
    if (!opts.signal) for (const s of ["SIGINT", "SIGTERM"] as const) process.off(s, onSignal);
    for (const c of cleanup.reverse()) await c();
  }
}

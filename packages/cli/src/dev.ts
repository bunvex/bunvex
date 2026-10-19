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
//   run as a child, its state in `.bunvex/local/default/`, `.env.local` naming it (STUDY-40, as Convex); unless
//   `--once` / `--until-success`, the local dashboard beside it, from 6790 (STUDY-149 PR 7, local-dashboard.ts).
// - the deployment's function logs are tailed to stderr (`--tail-logs`, default `pause-on-deploy`: held back
//   while a push runs), as `bunvex logs` prints them (STUDY-47).
import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { BunvexClient, makeFunctionReference } from "@bunvex/client";
import {
  argumentError,
  invalidArgument,
  invalidChoice,
  missingArgument,
  optionsIn,
  tooManyArguments,
  unknownOption,
} from "./args.ts";
import type { TypecheckMode } from "./codegen.ts";
import { type DashboardLink, NO_DASHBOARD, servedDashboard } from "./dashboard-links.ts";
import { deploy, functionsDir } from "./deploy.ts";
import type { Io } from "./io.ts";
import { startLocalDashboard } from "./local-dashboard.ts";
import {
  backendLogPath,
  configuredDeployment,
  type EnvLocalChanges,
  envLocalChanged,
  eraseDeploymentVar,
  type LocalOptions,
  LocalSetupDeclined,
  startLocalDeployment,
  writeEnvLocal,
  writeUrlsToEnvLocal,
} from "./local-deployment.ts";
import { COLORS, LogManager, type LogMode, NO_COLORS, watchLogs } from "./logs.ts";
import { formatDuration } from "./network-test.ts";
import { runCommand } from "./run.ts";
import { resolveTarget, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";
import { startVersionCheck } from "./version-check.ts";

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
  --typecheck-components
                       also typecheck the local components' directories with tsc
  --codegen <mode>     enable (default) or disable
  --tail-logs [mode]   print the deployment's function logs: always, pause-on-deploy (the default: not during
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
  liveComponentSources?: boolean;
  typecheckComponents?: boolean;
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
    // Hidden, as Convex's: packages resolve to their components' sources.
    else if (name === "--live-component-sources") f.liveComponentSources = true;
    else if (name === "--typecheck-components") f.typecheckComponents = true;
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
      // `--tail-logs [mode]` takes a value only when the next argument is not an option; alone, it is the default.
      const optional = name === "--tail-logs";
      const v =
        inline ??
        (optional && (args[i + 1] === undefined || args[i + 1]!.startsWith("-")) ? "pause-on-deploy" : args[++i]);
      // Convex's option specs (cli/dev.ts), for commander's messages.
      const spec = DEV_SPECS[name]!;
      if (v === undefined) return missingArgument(spec);
      if (name === "--run") f.run = v;
      else if (name === "--start") f.start = v;
      else if (name === "--typecheck") {
        if (v !== "enable" && v !== "try" && v !== "disable")
          return invalidChoice(spec, v, ["enable", "try", "disable"]);
        f.typecheck = v;
      } else if (name === "--codegen") {
        if (v !== "enable" && v !== "disable") return invalidChoice(spec, v, ["enable", "disable"]);
        f.codegen = v === "enable";
      } else if (name === "--tail-logs") {
        const modes = ["always", "pause-on-deploy", "disable"];
        if (!modes.includes(v)) return invalidChoice(spec, v, modes);
        f.tailLogs = v as LogMode;
      } else if (name === "--local-backend-version") f.local.backendVersion = v;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return invalidArgument(spec, v, "Not a port number.");
        if (name === "--local-cloud-port") f.local.cloudPort = n;
        else f.local.sitePort = n;
      }
    } else if (a.startsWith("-")) return unknownOption(a, optionsIn(DEV_USAGE));
    else return tooManyArguments("dev", 0, args.filter((x) => !x.startsWith("-")).length);
  }
  // Convex declares `--run` and `--start` as conflicting, but by their flags (`.conflicts(["--start"])`), which
  // commander compares with attribute names, so the check never fires: `--run` wins (cli/lib/command.ts).
  if (f.run !== undefined) f.start = undefined;
  return f;
}

const DEV_SPECS: Record<string, string> = {
  "--run": "--run <functionName>",
  "--start": "--start <command>",
  "--typecheck": "--typecheck <mode>",
  "--codegen": "--codegen <mode>",
  "--tail-logs": "--tail-logs [mode]",
  "--local-cloud-port": "--local-cloud-port <port>",
  "--local-site-port": "--local-site-port <port>",
  "--local-backend-version": "--local-backend-version <version>",
};

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

/**
 * The functions directory, watched: dirty when a file that matters changed, `quiet()` once it settles. The
 * directories of the app's local components are watched too, once a push has found them (STUDY-156).
 */
class DirWatcher {
  dirty = false;
  private watchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiting: (() => void) | null = null;
  /** Each watched directory's files' mtimes when the last push began (null: absent). */
  private snapshots = new Map<string, Map<string, number | null>>();
  constructor(
    dir: string,
    private quietMs = 500,
  ) {
    this.add(dir);
  }
  /** Watch `dir` too (a no-op for one already watched). */
  add(dir: string) {
    if (this.watchers.has(dir)) return;
    this.snapshots.set(dir, mtimes(dir));
    this.watchers.set(
      dir,
      watch(dir, { recursive: true }, (_event, file) => {
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
        if (this.snapshots.get(dir)?.get(String(file)) === mtime) return;
        this.dirty = true;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = undefined;
          const w = this.waiting;
          this.waiting = null;
          w?.();
        }, this.quietMs);
      }),
    );
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

  /** Start a push: forget what came before, and remember the files as the push sees them. */
  reset() {
    for (const dir of this.watchers.keys()) this.snapshots.set(dir, mtimes(dir));
    this.dirty = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  close() {
    clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
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

/** Where bunvex's users give feedback: the repository's issues (Convex names its community and support address). */
export const FEEDBACK_URL = "https://github.com/bunvex/bunvex/issues";

/**
 * Convex's `finalizeConfiguration` lines for a local deployment: what `.env.local` now holds, only what changed,
 * then the `.gitignore` line; nothing when nothing changed.
 */
export function configurationLines(url: string, c: EnvLocalChanges): string | null {
  const urls = [
    ...(c.url ? [`    client URL as ${c.url}\n`] : []),
    ...(c.site ? [`    HTTP actions URL as ${c.site}\n`] : []),
  ];
  const lines: string[] = [];
  if (urls.length > 0)
    lines.push(
      `✔ Configured a local deployment for ${url} and saved its:\n${c.deployment ? "    name as BUNVEX_DEPLOYMENT\n" : ""}${urls.join("")} to .env.local`,
    );
  else if (c.deployment)
    lines.push(`✔ Configured a local deployment for ${url} and saved its name as BUNVEX_DEPLOYMENT to .env.local`);
  if (c.gitignore) lines.push(`  Added ".env.local" to .gitignore`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Convex's closing lines after a changed configuration: where the functions go, where to give feedback, and the
 * dashboard (only while `dev` serves one, DV-477).
 */
export function nextSteps(functions: string, cwd: string, dashboard: string | null): string {
  const dir = `${relative(cwd, functions) || "."}/`;
  return (
    `\nWrite your bunvex functions in ${dir}\nGive us feedback at ${FEEDBACK_URL}\n` +
    (dashboard === null ? "" : `View the bunvex dashboard at ${dashboard}\n`)
  );
}

/**
 * The deployment `dev` works on, as Convex's `announceDeploymentTarget` prints it without colours: the header, a
 * local deployment's tag line (its port, and its dashboard: a link on a terminal, the URL otherwise), the URL.
 */
export function announceTarget(url: string, local: { port: number; dashboard: string | null } | null, io: Io): string {
  const link = (text: string, href: string) => `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`;
  const dashboard =
    local?.dashboard == null
      ? ""
      : io.isTTY
        ? ` (${link("dashboard", local.dashboard)})`
        : ` (dashboard: ${local.dashboard})`;
  return [
    "▌ Developing against deployment:",
    ...(local ? [`▌ [Local] Port ${local.port}${dashboard}`] : []),
    `▌ └─ ${io.isTTY ? link(url, url) : url}`,
  ].join("\n");
}

/**
 * A self-hosted `dev`'s configuration (Convex's `handleManuallySetUrlAndAdminKey`): `BUNVEX_DEPLOYMENT` out of
 * `.env.local`, and the deployment's canonical URLs in as the client's variables, each change said. URLs the
 * deployment does not give leave the file as it is.
 */
async function saveSelfHostedUrls(io: Io, target: Target) {
  if (eraseDeploymentVar(io.cwd)) io.err("Removed the BUNVEX_DEPLOYMENT environment variable from .env.local");
  let urls: { bunvexCloudUrl?: string; bunvexSiteUrl?: string | null };
  try {
    const r = await fetch(`${target.url}/api/v1/get_canonical_urls`, {
      headers: { authorization: `Bunvex ${target.adminKey}` },
    });
    if (!r.ok) return;
    urls = (await r.json()) as typeof urls;
  } catch {
    return; // unreachable: the push says so, and retries
  }
  if (!urls.bunvexCloudUrl) return;
  const saved = writeUrlsToEnvLocal(io.cwd, urls.bunvexCloudUrl, urls.bunvexSiteUrl ?? null);
  const names = [saved.url, saved.site].filter((n) => n !== null);
  if (names.length > 0) io.err(`Saved ${names.join(" and ")} to .env.local`);
}

/**
 * Resolves when a system query's result changes (Convex's `getFunctionWatch`): a subscription whose first
 * result is the current state, the next one a change. Used for the deployment's environment variables
 * (`_system/cli/queryEnvironmentVariables`, Convex's `getDeplymentEnvVarWatch`) and for the table a schema
 * validation failed on (`_system/cli/queryTable`, Convex's `getTableWatch`, STUDY-120). Never resolves if the
 * deployment cannot be watched (the file watch still runs); ends on abort.
 */
function resultChanged(target: Target, path: string, args: Record<string, string>, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const client = new BunvexClient(target.url, { logger: false });
    client.client.setAdminAuth(target.adminKey);
    let updates = 0;
    const finish = () => {
      sub.unsubscribe();
      void client.close();
      done();
    };
    const sub = client.onUpdate(
      makeFunctionReference<"query">(path),
      args,
      () => {
        if (++updates > 1) finish();
      },
      () => {},
    );
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

export async function devCommand(args: string[], io: Io, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(DEV_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  const flags = typeof taken === "string" ? taken : parseFlags(taken.rest);
  // Convex's `dev` shows its help after an argument error.
  if (typeof taken === "string" || typeof flags === "string")
    return argumentError(io, typeof taken === "string" ? taken : (flags as string), DEV_USAGE);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onSignal, { once: true });
  else for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, onSignal);
  const cleanup: (() => unknown)[] = [];
  let exitCode = 0;
  try {
    let target: Target | null;
    let localLog: string | null = null;
    // the local dashboard this `dev` serves, which its pushes link (DV-477); none on a self-hosted deployment
    let dashboardLink: DashboardLink = NO_DASHBOARD;
    // a local deployment's port and dashboard, for the line naming the deployment
    let localPort: number | null = null;
    let localDashboard: string | null = null;
    try {
      target = resolveTarget(taken.flags, io);
    } catch (e) {
      io.err(`bunvex dev: ${(e as Error).message}`);
      return 1;
    }
    const localFlags =
      flags.local.backendVersion !== undefined ||
      flags.local.forceUpgrade ||
      flags.local.cloudPort !== undefined ||
      flags.local.sitePort !== undefined;
    if (target && localFlags) {
      io.err("bunvex dev: the --local-* options are only for a local deployment");
      return 1;
    }
    if (!target) {
      const configured = configuredDeployment(io, taken.flags);
      if (configured && configured.type !== "local") {
        io.err(`bunvex dev: BUNVEX_DEPLOYMENT=${configured.type}:${configured.name} is not a deployment bunvex knows`);
        return 1;
      }
      // Convex's local deployment: the project's own, created on first use (L3).
      localLog = backendLogPath(io.cwd);
      let local: Awaited<ReturnType<typeof startLocalDeployment>>;
      try {
        local = await startLocalDeployment(io, flags.local);
      } catch (e) {
        io.err(e instanceof LocalSetupDeclined ? e.message : `bunvex dev: ${(e as Error).message}`);
        return 1;
      }
      cleanup.push(local.stop);
      target = local.target;
      const changes = writeEnvLocal(
        io.cwd,
        local.config.deploymentName,
        local.config.ports.cloud,
        local.config.ports.site,
      );
      const lines = configurationLines(target.url, changes);
      if (lines) io.err(lines);
      // Convex's local dashboard beside a long-running `dev` (`handleDashboard`, STUDY-149 PR 7); one that cannot be
      // downloaded is a warning, not Convex's stop (DV-486); one that cannot be served stops `dev`, as Convex's.
      if (!flags.once && !flags.untilSuccess) {
        try {
          const dashboard = await startLocalDashboard(
            io,
            { name: local.config.deploymentName, url: target.url, adminKey: target.adminKey },
            { backendVersion: flags.local.backendVersion, avoid: [local.config.ports.cloud, local.config.ports.site] },
          );
          cleanup.push(dashboard.stop);
          if (dashboard.server) dashboardLink = servedDashboard(`http://127.0.0.1:${dashboard.server.port}/`);
        } catch (e) {
          io.err(`bunvex dev: ${(e as Error).message}`);
          return 1;
        }
      }
      // Convex's `finalizeConfiguration` ends the lines about a changed `.env.local` with "View the … dashboard at"
      // its local dashboard's URL; bunvex prints it once the dashboard serves, and leaves it out without one (DV-477).
      if (envLocalChanged(changes)) io.err(nextSteps(functionsDir(io.cwd), io.cwd, await dashboardLink()));
      localDashboard = await dashboardLink();
      localPort = local.config.ports.cloud;
    } else {
      // A deployment named by its URL and admin key (self-hosted): its URLs into `.env.local`, as Convex's
      // `handleManuallySetUrlAndAdminKey`.
      await saveSelfHostedUrls(io, target);
    }
    io.err(announceTarget(target.url, localPort === null ? null : { port: localPort, dashboard: localDashboard }, io));
    // The version check (AD-29) beside the first push, as Convex's version message; its notice when it comes.
    void startVersionCheck(io).then((notice) => {
      if (notice && !stop.signal.aborted) io.err(notice);
    });
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
      const r = await deploy(
        target,
        {
          dryRun: false,
          codegen: flags.codegen,
          typecheck: flags.typecheck,
          dashboard: dashboardLink,
          liveComponentSources: flags.liveComponentSources,
          typecheckComponents: flags.typecheckComponents,
        },
        pushIo,
      );
      logManager.endDeploy();
      if (stop.signal.aborted) break;
      // The local components' directories, outside the functions directory or not (a watched one is skipped).
      for (const d of r.watch ?? []) if (!d.startsWith(`${dir}${sep}`)) watcher?.add(d);
      if (r.code === 0) {
        backoff = 500;
        io.err(`✔ ${clock()} bunvex functions ready! (${formatDuration(performance.now() - t0)})`);
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
        io.err(`Failed due to network error, retrying in ${formatDuration(wait)}...`);
        await sleep(wait, stop.signal);
        backoff = Math.min(backoff * 2, 16_000);
        continue;
      } else if (flags.once) {
        if (r.internal && localLog) io.err(`The local backend's log: ${localLog}`);
        exitCode = 1;
        break;
      }
      // The deployment failed on its own side: for a local one, where to read why.
      if (r.internal && localLog) io.err(`The local backend's log: ${localLog}`);
      // Wait for the next change (one during the push counts: it was not pushed); after a push that needs an
      // environment variable, or whose schema a table's documents fail, also for the deployment's variables or
      // that table to change (Convex's dev watches them too).
      if (watcher?.dirty) io.err("Filesystem changed during push, retrying...");
      if (watcher && (r.envVars || r.table !== undefined)) {
        const waiting = new AbortController();
        const abort = () => waiting.abort();
        stop.signal.addEventListener("abort", abort, { once: true });
        await Promise.race([
          watcher.quiet(waiting.signal),
          r.envVars
            ? resultChanged(target, "_system/cli/queryEnvironmentVariables", {}, waiting.signal)
            : resultChanged(target, "_system/cli/queryTable", { tableName: r.table! }, waiting.signal),
        ]);
        waiting.abort();
        stop.signal.removeEventListener("abort", abort);
      } else await watcher?.quiet(stop.signal);
    }
    return exitCode;
  } finally {
    // Ends the log tailing too.
    stop.abort();
    if (!opts.signal) for (const s of ["SIGINT", "SIGTERM"] as const) process.off(s, onSignal);
    for (const c of cleanup.reverse()) await c();
  }
}

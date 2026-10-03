// `bunvex logs` and `dev`'s log tailing (STUDY-47 PR 2), as Convex's `npx convex logs`
// (npm-packages/convex/src/cli/logs.ts, lib/logs.ts): poll `/api/stream_function_logs` from the head
// cursor, printing each line of each execution as `<local time> [BUNVEX <Q|M|A|H>(<path>)] [LEVEL] message`;
// with `--success`, a line for each successful execution; with `--jsonl`, each entry as JSON. Convex's prefix
// says CONVEX; bunvex's says BUNVEX (rule 5).
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const LOGS_USAGE = `Usage: bunvex logs [options]

Stream function logs from the deployment.

Options:
  --history [n]        show the \`n\` most recent logs first (all the server keeps, without \`n\`)
  --success            print a log line for every successful function execution
  --jsonl              print the raw log events as JSON Lines
${TARGET_OPTIONS}`;

/** When `dev` prints logs (Convex's `LogMode`). */
export type LogMode = "always" | "pause-on-deploy" | "disable";

/** Holds log output back while a push runs, in `pause-on-deploy` (Convex's `LogManager`). */
export class LogManager {
  private paused = false;
  constructor(private readonly mode: LogMode) {}
  async waitForUnpaused() {
    while (this.paused) await Bun.sleep(100);
  }
  beginDeploy() {
    if (this.mode === "pause-on-deploy") this.paused = true;
  }
  endDeploy() {
    if (this.mode === "pause-on-deploy") this.paused = false;
  }
}

type UdfType = "Query" | "Mutation" | "Action" | "HttpAction";
type StructuredLine = { messages: string[]; level: string; timestamp: number; isTruncated: boolean };
type LogLine = string | StructuredLine;
export type LogEntry = {
  kind: "Completion" | "Progress";
  udfType: UdfType;
  identifier: string;
  timestamp: number;
  logLines?: LogLine[];
  executionTime?: number;
  error?: string | null;
};

/** After this many failed polls in a row, each retry is announced (Convex's MAX_UDF_STREAM_FAILURE_COUNT). */
const MAX_FAILURES = 5;
/** Convex's `nextBackoff`: 500 ms doubling to 16 s, ±50%. */
const nextBackoff = (failures: number) => {
  const base = Math.min(500 * 2 ** failures, 16_000);
  return base + base * (Math.random() - 0.5);
};

const ansi = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[39m`;
const PLAIN = (s: string) => s;
export type Colors = { cyan: (s: string) => string; red: (s: string) => string; green: (s: string) => string };
export const COLORS: Colors = { cyan: ansi(36), red: ansi(31), green: ansi(32) };
export const NO_COLORS: Colors = { cyan: PLAIN, red: PLAIN, green: PLAIN };

const prefix = (timestampMs: number, udfType: UdfType, path: string) =>
  `${new Date(timestampMs).toLocaleString()} [BUNVEX ${udfType.charAt(0)}(${path})]`;

/** One log line as Convex's `formatLogLineMessage` prints it. */
export function formatLogLine(
  type: "info" | "error",
  timestampMs: number,
  udfType: UdfType,
  path: string,
  line: LogLine,
  c: Colors,
): string {
  if (typeof line !== "string") {
    const message = `${line.messages.join(" ")}${line.isTruncated ? " (truncated due to length)" : ""}`;
    return `${c.cyan(`${prefix(line.timestamp, udfType, path)} [${line.level}]`)} ${message}`;
  }
  if (type === "error") return c.red(`${prefix(timestampMs, udfType, path)} ${line}`);
  const match = /^\[.*?\] /.exec(line);
  if (match === null) return c.red(`[BUNVEX ${udfType.charAt(0)}(${path})] Could not parse console.log`);
  const level = line.slice(1, match[0].length - 2);
  return `${c.cyan(`${prefix(timestampMs, udfType, path)} [${level}]`)} ${line.slice(match[0].length)}`;
}

/** The lines to print for `entries` (Convex's `processLogs`). */
export function formatEntries(
  entries: LogEntry[],
  opts: { success: boolean; jsonl?: boolean; colors: Colors },
): string[] {
  if (opts.jsonl) return entries.map((e) => JSON.stringify(e));
  const out: string[] = [];
  for (const e of entries) {
    if (!e.logLines) continue;
    const ms = e.timestamp * 1000;
    for (const l of e.logLines) out.push(formatLogLine("info", ms, e.udfType, e.identifier, l, opts.colors));
    if (e.error) out.push(formatLogLine("error", ms, e.udfType, e.identifier, e.error, opts.colors));
    else if (e.kind === "Completion" && opts.success)
      out.push(
        opts.colors.green(
          `${prefix(ms, e.udfType, e.identifier)} Function executed in ${Math.ceil((e.executionTime ?? Number.NaN) * 1000)} ms`,
        ),
      );
  }
  return out;
}

/** The client header the server reads to send structured lines, as Convex's CLI's `npm-cli-<version>`. */
async function clientHeader(): Promise<string> {
  const pkg = (await import("../package.json")) as { version: string };
  return `npm-cli-${pkg.version}`;
}

class ForbiddenError extends Error {}

async function poll(target: Target, cursor: number, signal?: AbortSignal) {
  const r = await fetch(`${target.url}/api/stream_function_logs?cursor=${cursor}`, {
    headers: { authorization: `Bunvex ${target.adminKey}`, "bunvex-client": await clientHeader() },
    ...(signal ? { signal } : {}),
  });
  const body = (await r.json()) as { entries: LogEntry[]; newCursor: number; message?: string };
  if (r.status === 403) throw new ForbiddenError(body.message ?? "forbidden");
  if (!r.ok) throw new Error(body.message ?? `${r.status}`);
  return body;
}

/**
 * Poll the deployment's log stream until `signal` aborts (Convex's `watchLogs`). The first poll only finds
 * the head: its entries are printed only with `history` (all, or the last `n`). A 403 ends it with the
 * error; other failures retry with backoff, announced after 5 in a row.
 */
export async function watchLogs(
  target: Target,
  write: (line: string) => void,
  warn: (line: string) => void,
  opts: {
    success: boolean;
    history?: number | true;
    jsonl?: boolean;
    colors: Colors;
    logManager?: LogManager;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  let failures = 0;
  let first = true;
  let cursor = 0;
  while (!opts.signal?.aborted) {
    try {
      const { entries, newCursor } = await poll(target, cursor, opts.signal);
      cursor = newCursor;
      failures = 0;
      await opts.logManager?.waitForUnpaused();
      let shown = entries;
      if (first) {
        first = false;
        shown = opts.history === true ? entries : opts.history && opts.history > 0 ? entries.slice(-opts.history) : [];
      }
      for (const l of formatEntries(shown, opts)) write(l);
    } catch (e) {
      if (opts.signal?.aborted) break;
      if (e instanceof ForbiddenError) return e.message;
      failures++;
    }
    if (failures > 0) {
      const wait = nextBackoff(failures);
      if (failures > MAX_FAILURES)
        warn(`BUNVEX [WARN] Failed to fetch logs. Waiting ${Math.round(wait)}ms before next retry.`);
      await new Promise<void>((done) => {
        const t = setTimeout(done, wait);
        opts.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            done();
          },
          { once: true },
        );
      });
    }
  }
  return null;
}

export async function logsCommand(args: string[], io: Io, opts: { signal?: AbortSignal } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(LOGS_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") {
    io.err(`bunvex logs: ${taken}`);
    return 2;
  }
  let history: number | true | undefined;
  let success = false;
  let jsonl = false;
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    if (a === "--success") success = true;
    else if (a === "--jsonl") jsonl = true;
    else if (a === "--history" || a.startsWith("--history=") || a === "--tail" || a.startsWith("--tail=")) {
      const name = a.startsWith("--tail") ? "--tail" : "--history";
      if (name === "--tail")
        io.err("`--tail` is unnecessary: `bunvex logs` already tails by default. Treating it as `--history`.");
      const inline = a.includes("=") ? a.slice(a.indexOf("=") + 1) : undefined;
      const next = inline ?? (r[i + 1] !== undefined && /^\d+$/.test(r[i + 1]!) ? r[++i] : undefined);
      if (next === undefined) history = history ?? true;
      else if (!/^\d+$/.test(next)) {
        io.err(`bunvex logs: option '${name} [n]' argument '${next}' is invalid. Not a number.`);
        return 2;
      } else history = Number(next);
    } else {
      io.err(`bunvex logs: unknown option ${a}\n\n${LOGS_USAGE}`);
      return 2;
    }
  }
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex logs: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex logs: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onSignal, { once: true });
  else for (const s of ["SIGINT", "SIGTERM"] as const) process.once(s, onSignal);
  try {
    io.err(`${io.isTTY ? "\x1b[33m" : ""}Watching logs for dev deployment...${io.isTTY ? "\x1b[39m" : ""}`);
    const denied = await watchLogs(acquired.target, io.out, io.err, {
      success,
      ...(history === undefined ? {} : { history }),
      jsonl,
      colors: io.isTTY ? COLORS : NO_COLORS,
      signal: stop.signal,
    });
    if (denied !== null) {
      io.err(`bunvex logs: ${denied}`);
      return 1;
    }
    return 0;
  } finally {
    if (!opts.signal) for (const s of ["SIGINT", "SIGTERM"] as const) process.off(s, onSignal);
    await acquired.release();
  }
}

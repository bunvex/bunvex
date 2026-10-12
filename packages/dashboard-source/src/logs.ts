// The function logs, as Convex's dashboard reads them (`dashboard-common/src/lib/useLogs.ts`,
// `appMetrics.ts` `streamFunctionLogs`; STUDY-149 §1.3): one long-poll loop on
// `/api/app_metrics/stream_function_logs` from cursor 0 (so the first answer is whatever the server still
// holds), each answer's `newCursor` asked from next; errors back off from 500 ms, doubling up to 16 s with
// jitter, and are reported after 5 in a row; a 403 stops the loop; at most 10 000 entries are kept. Each
// execution becomes its lines and one outcome line, as Convex's `processLogs`.
import {
  DataSourceError,
  type ExecutionIdentity,
  type ExecutionLinks,
  type ExecutionUsage,
  type FunctionKind,
  type LogEntry,
  type LogFilter,
  type LogLevel,
  type LogQuery,
  type Page,
} from "@bunvex/dashboard/data-source";
import { type AdminHttp, ResponseError } from "./admin-http.ts";

/** Convex's `MAX_LOGS`. */
export const MAX_LOGS = 10_000;
/** Failures in a row before the watchers hear of it (Convex's `TOAST_AFTER_BACKOFF_COUNT`). */
export const REPORT_AFTER_FAILURES = 5;

/** Convex's `backoffWithJitter` (`dashboard-common/src/lib/utils.ts`): 500 ms doubling to 16 s, ±50 % jitter. */
export function backoffWithJitter(failures: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** (failures - 1), 16_000);
  return base + base * (random() - 0.5);
}

// ------------------------------------------------------------------ the server's entries

/** A log line as `stream_function_logs` sends it to the dashboard (Convex's `LogLineJson`), or the old text. */
type LogLineJson =
  | string
  | { messages: string[]; isTruncated: boolean; timestamp: number; level: string; systemMetadata?: unknown };

type UsageStatsJson = Partial<
  Record<
    | "databaseReadBytes"
    | "databaseWriteBytes"
    | "storageReadBytes"
    | "storageWriteBytes"
    | "memoryUsedMb"
    | "databaseReadDocuments",
    number
  >
>;

/** Convex's `FunctionExecutionJson`: a Completion (one per execution) or Progress (an action's lines so far). */
export type FunctionExecution =
  | {
      kind: "Progress";
      udfType: string;
      identifier: string;
      timestamp: number;
      logLines: LogLineJson[];
      requestId: string;
      executionId: string;
    }
  | {
      kind: "Completion";
      udfType: string;
      identifier: string;
      timestamp: number;
      logLines: LogLineJson[];
      executionTime: number;
      success: { status?: string } | unknown;
      error: string | null;
      requestId: string;
      executionId: string;
      parentExecutionId: string | null;
      usageStats?: UsageStatsJson;
      returnBytes?: number | null;
      identityType?: string;
      links?: ExecutionLinks;
    };

const KINDS: Record<string, FunctionKind> = {
  Query: "query",
  Mutation: "mutation",
  Action: "action",
  // an HTTP action is an action to the dashboard's types; its path is `METHOD /route`
  HttpAction: "action",
};

const LEVELS: Record<string, LogLevel> = { LOG: "info", INFO: "info", DEBUG: "debug", WARN: "warn", ERROR: "error" };

/** Convex's `Identity::tag()` → the contract's. */
const IDENTITIES: Record<string, ExecutionIdentity> = {
  instance_admin: "admin",
  user: "user",
  member_acting_user: "acting_as_user",
  team_acting_user: "acting_as_user",
  system: "system",
  unknown: "unknown",
};

/** A function's display path: `module.js:name` → `module:name`, as Convex's dashboard shows it. */
export const displayPath = (identifier: string) => identifier.replace(/\.js(?=:|$)/, "");

const UNESCAPES: Record<string, string> = { "\\\\": "\\", "\\n": "\n", "\\'": "'" };

/**
 * A structured line's text, as Convex's dashboard shows it (`LogOutput.tsx` `messagesToString`): each message
 * that is a quoted string loses its quotes and escapes, and they are joined by spaces.
 */
export function messageText(messages: string[], isTruncated: boolean): string {
  const text = messages
    .map((m) =>
      m.length >= 2 && m.startsWith("'") && m.endsWith("'")
        ? m.replace(/\\(\\|n|\x27)/g, (x) => UNESCAPES[x] ?? x).slice(1, -1)
        : m,
    )
    .join(" ");
  return isTruncated ? `${text} (truncated due to length)` : text;
}

function lineOf(l: LogLineJson, fallbackMs: number): { level: LogLevel; message: string; time: number } {
  if (typeof l === "string") {
    // The unstructured form, `[LEVEL] message` (Convex's `entryLogLines`).
    const m = /^\[(LOG|DEBUG|INFO|WARN|ERROR)\] ([\s\S]*)/.exec(l);
    return { level: LEVELS[m?.[1] ?? "LOG"] ?? "info", message: m?.[2] ?? l, time: fallbackMs };
  }
  return {
    level: LEVELS[l.level] ?? "info",
    message: messageText(l.messages, l.isTruncated),
    time: l.timestamp || fallbackMs,
  };
}

function usageOf(e: Extract<FunctionExecution, { kind: "Completion" }>): ExecutionUsage | undefined {
  const u = e.usageStats;
  if (!u) return undefined;
  return {
    ...(u.memoryUsedMb !== undefined && { memoryMb: u.memoryUsedMb }),
    ...(u.databaseReadBytes !== undefined && { databaseReadBytes: u.databaseReadBytes }),
    ...(u.databaseWriteBytes !== undefined && { databaseWriteBytes: u.databaseWriteBytes }),
    ...(u.storageReadBytes !== undefined && { fileReadBytes: u.storageReadBytes }),
    ...(u.storageWriteBytes !== undefined && { fileWriteBytes: u.storageWriteBytes }),
    ...(typeof e.returnBytes === "number" && { returnBytes: e.returnBytes }),
  };
}

/** Whether an execution failed (Convex's `entryOutcome`: an HTTP action by its status, anything else by `error`). */
function failed(e: Extract<FunctionExecution, { kind: "Completion" }>): boolean {
  if (typeof e.error === "string") return true;
  if (e.udfType !== "HttpAction") return false;
  const status = Number((e.success as { status?: string } | null)?.status);
  return !(status >= 200 && status <= 299);
}

/**
 * The entries of a batch of executions, oldest first (Convex's `processLogs`): each log line, then for a
 * Completion its outcome line, which carries the `execution`. `nextId` hands out the ordered ids.
 */
export function entriesOf(executions: FunctionExecution[], nextId: () => string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const e of executions) {
    const fn = { path: displayPath(e.identifier), kind: KINDS[e.udfType] ?? "action" };
    const ms = e.timestamp * 1000;
    const common = {
      function: fn,
      requestId: e.requestId,
      executionId: e.executionId,
      ...(e.kind === "Completion" && e.parentExecutionId !== null && { parentExecutionId: e.parentExecutionId }),
    };
    for (const l of e.logLines) {
      const { level, message, time } = lineOf(l, ms);
      out.push({ id: nextId(), time, level, message, ...common });
    }
    if (e.kind !== "Completion") continue;
    const failure = failed(e);
    const usage = usageOf(e);
    const identity = e.identityType === undefined ? undefined : IDENTITIES[e.identityType];
    out.push({
      id: nextId(),
      time: ms,
      level: failure ? "error" : "info",
      message: e.error ?? "",
      ...common,
      execution: {
        status: failure ? "failure" : "success",
        durationMs: e.executionTime * 1000,
        ...(usage && { usage }),
        ...(identity && { identity }),
        ...(e.links && { links: e.links }),
      },
    });
  }
  return out;
}

export const matchesLogFilter = (e: LogEntry, f: LogFilter) =>
  (f.function === undefined || e.function?.path === f.function) && (!f.levels || f.levels.includes(e.level));

// ------------------------------------------------------------------ the loop

type Watcher = { filter: LogFilter; onEntries: (e: LogEntry[]) => void; onError: (e: DataSourceError) => void };

export type LogStreamOptions = {
  /**
   * How long the loop's first answer counts as the history: `list` waits for it that long at most (the server
   * holds an empty log's request up to 60 s), and a later first answer is new, delivered to the watchers.
   * Default 1 000 ms.
   */
  firstAnswerMs?: number;
  /** For tests: the backoff between failures. Default: `backoffWithJitter`. */
  backoff?: (failures: number) => number;
};

/**
 * The log of a deployment as the dashboard sees it: one long-poll loop, started by the first `list` or
 * `watch` and stopped by `close`, holding the newest `MAX_LOGS` entries.
 */
export class LogStream {
  private readonly entries: LogEntry[] = [];
  private readonly watchers = new Set<Watcher>();
  private readonly abort = new AbortController();
  private started = false;
  private seq = 0;
  /** Set once the server answered (or refused) the first request. */
  private firstAnswer: Promise<void> | null = null;
  private answered!: () => void;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private denied: DataSourceError | null = null;

  constructor(
    private readonly http: AdminHttp,
    private readonly opts: LogStreamOptions = {},
  ) {}

  private start() {
    if (this.started) return;
    this.started = true;
    this.firstAnswer = new Promise((r) => {
      this.answered = r;
    });
    // The server answers the first request at once when it holds any entry; one that has none holds it until
    // the next execution. So an answer within the grace is the history (listed, not delivered to watchers),
    // and one after it is new.
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.answered();
    }, this.opts.firstAnswerMs ?? 1000);
    void this.loop();
  }

  /** The first answer is in (or refused): `list` may read. */
  private endGrace() {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.answered();
  }

  private nextId = () => (++this.seq).toString().padStart(12, "0");

  private async loop() {
    const signal = this.abort.signal;
    let cursor = 0;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const { entries, newCursor } = await this.http.json<{ entries: FunctionExecution[]; newCursor: number }>(
          `/api/app_metrics/stream_function_logs?cursor=${cursor}`,
          { signal },
        );
        failures = 0;
        cursor = newCursor;
        const history = this.graceTimer !== null;
        this.endGrace();
        this.receive(entriesOf(entries, this.nextId), !history);
      } catch (e) {
        if (signal.aborted) return;
        const error = e instanceof DataSourceError ? e : new DataSourceError("unavailable", String(e));
        // Convex's loop stops on a 403 (`PermissionDeniedError`); anything else, a refused key included, backs off.
        if (error instanceof ResponseError && error.status === 403) {
          this.denied = error;
          this.endGrace();
          for (const w of this.watchers) w.onError(error);
          return;
        }
        failures++;
        if (failures > REPORT_AFTER_FAILURES) for (const w of this.watchers) w.onError(error);
        await new Promise((r) => setTimeout(r, (this.opts.backoff ?? backoffWithJitter)(failures)));
      }
    }
  }

  private receive(fresh: LogEntry[], deliver: boolean) {
    if (fresh.length === 0) return;
    this.entries.push(...fresh);
    if (this.entries.length > MAX_LOGS) this.entries.splice(0, this.entries.length - MAX_LOGS);
    if (!deliver) return;
    for (const w of this.watchers) {
      const mine = fresh.filter((e) => matchesLogFilter(e, w.filter));
      if (mine.length > 0) w.onEntries(mine);
    }
  }

  /** A page of the entries held, newest first; the cursor walks back. */
  async list(q: LogQuery, signal?: AbortSignal): Promise<Page<LogEntry>> {
    if (!Number.isInteger(q.numItems) || q.numItems < 1)
      throw new DataSourceError("invalid_request", "numItems must be a positive integer");
    this.start();
    await this.firstAnswer;
    if (signal?.aborted) throw signal.reason;
    if (this.denied) throw this.denied;
    const key = JSON.stringify([q.function ?? null, q.levels ? [...q.levels].sort() : null]);
    let before: string | null = null;
    if (q.cursor !== null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(atob(q.cursor));
      } catch {
        throw new DataSourceError("invalid_request", "This cursor is not one this source made.");
      }
      if (!Array.isArray(decoded) || decoded[0] !== key || typeof decoded[1] !== "string")
        throw new DataSourceError("invalid_request", "This cursor belongs to another query.");
      before = decoded[1];
    }
    const page: LogEntry[] = [];
    let i = this.entries.length - 1;
    for (; i >= 0 && page.length < q.numItems; i--) {
      const e = this.entries[i]!;
      if (before !== null && e.id >= before) continue;
      if (matchesLogFilter(e, q)) page.push(e);
    }
    const last = page.at(-1);
    const isDone = !this.entries
      .slice(0, i + 1)
      .some((e) => (before === null || e.id < before) && matchesLogFilter(e, q));
    return { page, isDone, continueCursor: last ? btoa(JSON.stringify([key, last.id])) : (q.cursor ?? "") };
  }

  /** Entries that arrive after the call, matching the filter; never synchronously. */
  watch(filter: LogFilter, onEntries: (e: LogEntry[]) => void, onError: (e: DataSourceError) => void): () => void {
    const w: Watcher = { filter, onEntries, onError };
    this.watchers.add(w);
    this.start();
    if (this.denied) {
      const denied = this.denied;
      setTimeout(() => this.watchers.has(w) && onError(denied), 0);
    }
    return () => {
      this.watchers.delete(w);
    };
  }

  close() {
    if (this.started) this.endGrace();
    this.abort.abort();
    this.watchers.clear();
  }
}

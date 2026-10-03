// The function execution log (STUDY-47), as Convex's `FunctionExecutionLog`
// (crates/application/src/function_log.rs): the deployment's recent executions in memory, read by the log
// stream endpoints (crates/local_backend/src/logs.rs) behind `bunvex logs`, `dev` and the dashboard.
//
// A part is a Completion (one per execution) or a Progress event (lines an action printed as it ran). The
// newest MAX_UDF_EXECUTION parts are kept, each under a cursor: wall-clock ms, strictly increasing.
import { wallClock } from "@bunvex/core";
import { type LogLine, type LogOwner, prettyLogLine } from "./logs.ts";

/** How many parts the log keeps (Convex's MAX_UDF_EXECUTION). */
export const MAX_UDF_EXECUTION = 1000;
/** A stream request with nothing new answers empty after this long (Convex's 60 s long poll). */
export const LONG_POLL_MS = 60_000;

export type UdfType = "Query" | "Mutation" | "Action" | "HttpAction";
/** Who ran the function (Convex's `FunctionCaller` names). */
export type CallerName = "SyncWorker" | "HttpApi" | "Tester" | "HttpEndpoint" | "Cron" | "Scheduler" | "Action";
/** Convex's `Identity::tag()`. */
export type IdentityType = "system" | "instance_admin" | "unknown" | "user" | "member_acting_user" | "team_acting_user";

/** Convex's `UsageStatsJson`. */
export type UsageStats = {
  databaseReadBytes: number;
  databaseWriteBytes: number;
  databaseIoReadBytes: number;
  databaseIoWriteBytes: number;
  databaseReadDocuments: number;
  databaseWriteDocuments: number;
  databaseWriteIndexRows: number;
  storageReadBytes: number;
  storageWriteBytes: number;
  vectorIndexReadBytes: number;
  vectorIndexWriteBytes: number;
  textIndexQueryBytes: number;
  textIndexWriteQueryBytes: number;
  vectorIndexReadQueryBytes: number;
  vectorIndexWriteQueryBytes: number;
  networkEgressBytes: number;
  memoryUsedMb: number;
};

export const usageStats = (
  read: { bytes: number; documents: number },
  written: { bytes: number; documents: number },
): UsageStats => ({
  databaseReadBytes: read.bytes,
  databaseWriteBytes: written.bytes,
  // bunvex does not meter the store's own I/O apart from what the transaction read and wrote (DV-251).
  databaseIoReadBytes: read.bytes,
  databaseIoWriteBytes: written.bytes,
  databaseReadDocuments: read.documents,
  databaseWriteDocuments: written.documents,
  databaseWriteIndexRows: 0,
  storageReadBytes: 0,
  storageWriteBytes: 0,
  vectorIndexReadBytes: 0,
  vectorIndexWriteBytes: 0,
  textIndexQueryBytes: 0,
  textIndexWriteQueryBytes: 0,
  vectorIndexReadQueryBytes: 0,
  vectorIndexWriteQueryBytes: 0,
  networkEgressBytes: 0,
  memoryUsedMb: 0,
});

export const NO_USAGE: UsageStats = usageStats({ bytes: 0, documents: 0 }, { bytes: 0, documents: 0 });

/** Convex's `OccInfoJson`. */
export type OccInfo = {
  tableName: string | null;
  documentId: string | null;
  writeSource: string | null;
  componentPath: string | null;
  retryCount: number | null;
};

/** One execution, as Convex's `FunctionExecution` (times in seconds, as its JSON has them). */
export type Completion = {
  kind: "Completion";
  udfType: UdfType;
  identifier: string;
  logLines: LogLine[];
  /** When the completion was logged. */
  timestamp: number;
  cachedResult: boolean;
  caller: CallerName;
  parentExecutionId: string | null;
  executionTime: number;
  userExecutionTime: number | null;
  /** A successful HTTP action's status. */
  success: { status: string } | null;
  error: string | null;
  requestId: string;
  executionId: string;
  usageStats: UsageStats;
  returnBytes: number | null;
  occInfo: OccInfo | null;
  willRetry: boolean;
  /** When the execution started. */
  executionTimestamp: number;
  identityType: IdentityType;
  /** `node` for a `"use node"` action. */
  environment: "isolate" | "node";
};

/** Lines an action or HTTP action printed while running (Convex's `FunctionExecutionProgress`). */
export type Progress = {
  kind: "Progress";
  udfType: UdfType;
  identifier: string;
  /** The function's start. */
  timestamp: number;
  logLines: LogLine[];
  requestId: string;
  executionId: string;
  /** Not a function an action called: what the request filter keeps. */
  root: boolean;
};

export type Part = Completion | Progress;

/** An execution being logged: the owner of the lines it prints (logs.ts). */
export class Running implements LogOwner {
  onLine: ((line: LogLine) => void) | null = null;
  cached = false;
  /** Its name in the app metrics (STUDY-58): `module.js:function`, or an HTTP action's route path. */
  metricsName = "";
  tx: unknown = null;
  constructor(
    readonly executionId: string,
    readonly requestId: string,
    readonly parent: Running | null,
    readonly udfType: UdfType,
    readonly identifier: string,
    readonly caller: CallerName,
    readonly identityType: IdentityType,
    /** Wall-clock ms. */
    readonly start: number,
    readonly environment: "isolate" | "node" = "isolate",
  ) {}
}

/** The next double after `x` (> 0): Convex's `f64::next_up`, so two parts never share a cursor. */
function nextUp(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

export class FunctionLog {
  private parts: { cursor: number; part: Part }[] = [];
  private last = 0;
  private waiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly max = MAX_UDF_EXECUTION) {}

  append(part: Part) {
    const now = wallClock();
    this.last = now > this.last ? now : nextUp(this.last);
    this.parts.push({ cursor: this.last, part });
    if (this.parts.length > this.max) this.parts.splice(0, this.parts.length - this.max);
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /** End every waiting stream request (the server is stopping). */
  close() {
    this.closed = true;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiting) wake();
  }

  /** The newest cursor (0 when empty). */
  get headCursor(): number {
    return this.parts.at(-1)?.cursor ?? 0;
  }

  /**
   * The parts after `cursor` and the cursor to ask from next (the last part's), as soon as there is one;
   * after `timeoutMs` without any, none and `cursor` (Convex's `stream_parts` under the 60 s long poll).
   */
  async after(
    cursor: number,
    timeoutMs = LONG_POLL_MS,
    signal?: AbortSignal,
  ): Promise<{ parts: Part[]; newCursor: number }> {
    for (;;) {
      const i = this.firstAfter(cursor);
      if (i < this.parts.length) return { parts: this.parts.slice(i).map((p) => p.part), newCursor: this.headCursor };
      if (signal?.aborted || this.closed) return { parts: [], newCursor: cursor };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const woken = await new Promise<boolean>((resolve) => {
        wake = () => resolve(true);
        this.waiters.add(wake);
        timer = setTimeout(() => resolve(false), timeoutMs);
        signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
      clearTimeout(timer);
      this.waiters.delete(wake);
      if (!woken) return { parts: [], newCursor: cursor };
    }
  }

  private firstAfter(cursor: number): number {
    let lo = 0;
    let hi = this.parts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.parts[mid]!.cursor <= cursor) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** A line as an endpoint sends it: structured for the CLI and dashboard, else Convex's pretty string. */
const lineJson = (l: LogLine, structured: boolean) =>
  structured
    ? { messages: l.messages, isTruncated: l.isTruncated, timestamp: l.timestamp, level: l.level }
    : prettyLogLine(l);

/**
 * A part as Convex's `FunctionExecutionJson`. `parts`: for `stream_function_logs`, where an action's lines
 * went out as Progress events and its Completion carries none.
 */
export function partJson(p: Part, opts: { structured: boolean; parts: boolean }) {
  const lines = (ls: LogLine[]) => ls.map((l) => lineJson(l, opts.structured));
  if (p.kind === "Progress")
    return {
      kind: "Progress",
      udfType: p.udfType,
      componentPath: null,
      identifier: p.identifier,
      timestamp: p.timestamp,
      logLines: lines(p.logLines),
      requestId: p.requestId,
      executionId: p.executionId,
    };
  const streamed = opts.parts && (p.udfType === "Action" || p.udfType === "HttpAction");
  return {
    kind: "Completion",
    udfType: p.udfType,
    componentPath: null,
    identifier: p.identifier,
    logLines: streamed ? [] : lines(p.logLines),
    timestamp: p.timestamp,
    cachedResult: p.cachedResult,
    caller: p.caller,
    parentExecutionId: p.parentExecutionId,
    executionTime: p.executionTime,
    userExecutionTime: p.userExecutionTime,
    success: p.success,
    error: p.error,
    requestId: p.requestId,
    executionId: p.executionId,
    usageStats: p.usageStats,
    returnBytes: p.returnBytes,
    occInfo: p.occInfo,
    willRetry: p.willRetry,
    executionTimestamp: p.executionTimestamp,
    identityType: p.identityType,
    environment: p.environment,
  };
}

/** Convex's `RequestId::new_for_ws_session`: the first 16 hex digits of SHA-256(`<sessionId>|<counter>`). */
export function wsRequestId(sessionId: string, counter: number): string {
  return new Bun.CryptoHasher("sha256").update(`${sessionId}|${counter}`).digest("hex").slice(0, 16);
}

/** Whether a client gets structured lines: the CLI and the dashboard, by their client header. */
export const wantsStructuredLines = (clientHeader: string | null) =>
  clientHeader !== null && /^(npm-cli|dashboard)-/.test(clientHeader);

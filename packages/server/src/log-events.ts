// The events log streams carry (STUDY-59), as Convex's `LogEvent` / `StructuredLogEvent`
// (crates/common/src/log_streaming.rs), and their V2 JSON: what webhook and local sinks write.

import type { OccInfo, UsageStats } from "./function-log.ts";
import type { LogLine } from "./logs.ts";

/** Convex's `LogTopic`, as sinks subscribe to them. */
export const LOG_TOPICS = [
  "verification",
  "console",
  "function_execution",
  "exception",
  "audit_log",
  "scheduler_stats",
  "scheduled_job_lag",
  "current_storage_usage",
  "concurrency_stats",
  "storage_api_bandwidth",
  "ai_gateway_usage",
  "log_stream_egress",
  "custom_audit",
] as const;
export type LogTopic = (typeof LOG_TOPICS)[number];
/** Every topic but `verification` and `exception` (Convex's `SUBSCRIBABLE`). */
export const SUBSCRIBABLE_TOPICS: readonly LogTopic[] = LOG_TOPICS.filter(
  (t) => t !== "verification" && t !== "exception",
);

/** Where a function event comes from (Convex's `FunctionEventSource`). */
export type FunctionSource = {
  /** `module.js:function`, or an HTTP action's `METHOD /path`. */
  path: string;
  udfType: "Query" | "Mutation" | "Action" | "HttpAction";
  cached: boolean | null;
  requestId: string;
  mutationRetryCount: number | null;
  mutationQueueLength: number | null;
};

/** Convex's `FunctionRunReason`. */
export type RunReason =
  | "initialSubscription"
  | "dataChange"
  | "identityChange"
  | "webSocket"
  | "httpApi"
  | "httpEndpoint"
  | "cron"
  | "scheduler"
  | "action"
  | "tester";

export type Concurrency = { running: number; queued: number };

export type StructuredLogEvent =
  | { topic: "verification" }
  | { topic: "console"; source: FunctionSource; line: LogLine }
  | {
      topic: "function_execution";
      source: FunctionSource;
      error: string | null;
      /** Seconds. */
      executionTime: number;
      userExecutionTime: number | null;
      usage: UsageStats;
      argsBytes: number | null;
      returnBytes: number | null;
      occInfo: OccInfo | null;
      willRetry: boolean;
      schedulerJobId: string | null;
      runReason: RunReason;
    }
  | {
      topic: "exception";
      source: FunctionSource;
      message: string;
      /** The caller's `tokenIdentifier`, when a user called. */
      userIdentifier: string | null;
      /** The stack, innermost first (Convex's `JsError.frames`); null when unknown. */
      frames: StackFrame[] | null;
      /** A `BunvexError`'s data, as internal JSON. */
      customData: unknown;
      /** The request's IP, when known. */
      ip: string | null;
      /** Convex's `func_runtime`: `default`, or `node` for a `"use node"` action. */
      runtime: "default" | "node";
    }
  | { topic: "audit_log"; action: string; metadata: unknown }
  /** A function's `log.audit` line, its variables resolved (STUDY-82). */
  | { topic: "custom_audit"; body: unknown }
  | { topic: "scheduler_stats"; lagSeconds: number; numRunningJobs: number }
  | { topic: "scheduled_job_lag"; lagSeconds: number }
  | ({ topic: "current_storage_usage" } & StorageUsage)
  | {
      topic: "concurrency_stats";
      query: Concurrency;
      mutation: Concurrency;
      action: Concurrency;
      nodeAction: Concurrency;
      httpAction: Concurrency;
    };

/** One stack frame (Convex's `FrameData`), each part null when the line did not say. */
export type StackFrame = {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** The frame's line as the runtime printed it, `at …` (V1's string frames). */
  text: string;
};

/** The frames of an error's stack, innermost first: lines `at fn (file:line:col)` or `at file:line:col`. */
export function stackFrames(stack: string | undefined): StackFrame[] | null {
  if (!stack) return null;
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const body = line.slice(3);
    const m = /^(.*?) \((.*):(\d+):(\d+)\)$/.exec(body) ?? /^()(.*):(\d+):(\d+)$/.exec(body);
    frames.push(
      m
        ? {
            functionName: m[1] ? m[1] : null,
            fileName: m[2] ?? null,
            lineNumber: Number(m[3]),
            columnNumber: Number(m[4]),
            text: line,
          }
        : { functionName: body || null, fileName: null, lineNumber: null, columnNumber: null, text: line },
    );
  }
  return frames;
}

/** `timestamp`: wall-clock ms. */
/** Convex's `AggregatedStorageUsage`, as the `current_storage_usage` event carries it (STUDY-73). */
export type StorageUsage = {
  documentBytes: number;
  indexBytes: number;
  vectorBytes: number;
  textBytes: number;
  fileBytes: number;
  backupBytes: number;
  /** The virtual tables' documents: `_storage` and `_scheduled_functions`. */
  systemTableDocumentBytes: { _storage: number; _scheduled_functions: number };
};

export type LogEvent = { timestamp: number; event: StructuredLogEvent };

const functionJson = (s: FunctionSource) => ({
  path: s.path,
  type: { Query: "query", Mutation: "mutation", Action: "action", HttpAction: "http_action" }[s.udfType],
  cached: s.udfType === "Query" ? s.cached : null,
  request_id: s.requestId,
  mutation_queue_length: s.mutationQueueLength,
  mutation_retry_count: s.mutationRetryCount,
});

const concurrencyJson = (c: Concurrency) => ({ num_running: c.running, num_queued: c.queued });

/** Convex's `LogEventFormatVersion::V2` serialization of an event. */
export function eventJsonV2(e: LogEvent): Record<string, unknown> {
  const ms = Math.floor(e.timestamp);
  const ev = e.event;
  switch (ev.topic) {
    case "verification":
      return { timestamp: ms, topic: "verification", message: "Log stream connection test" };
    case "console":
      return {
        timestamp: Math.floor(ev.line.timestamp),
        topic: "console",
        function: functionJson(ev.source),
        log_level: ev.line.level,
        message: ev.line.messages.join(" "),
        is_truncated: ev.line.isTruncated,
        system_code: null,
      };
    case "function_execution": {
      const u = ev.usage;
      const action = ev.source.udfType === "Action" || ev.source.udfType === "HttpAction";
      return {
        timestamp: ms,
        topic: "function_execution",
        function: functionJson(ev.source),
        execution_time_ms: Math.floor(ev.executionTime * 1000),
        user_execution_time_ms: ev.userExecutionTime === null ? null : Math.floor(ev.userExecutionTime * 1000),
        status: ev.error === null ? "success" : "failure",
        error_message: ev.error,
        occ_info:
          ev.occInfo === null
            ? null
            : {
                table_name: ev.occInfo.tableName,
                document_id: ev.occInfo.documentId,
                write_source: ev.occInfo.writeSource,
                component_path: ev.occInfo.componentPath,
                retry_count: ev.occInfo.retryCount,
              },
        will_retry: ev.willRetry,
        scheduler_info: ev.schedulerJobId === null ? null : { job_id: ev.schedulerJobId },
        run_reason: ev.runReason,
        usage: {
          database_read_bytes: u.databaseReadBytes,
          database_write_bytes: u.databaseWriteBytes,
          database_io_read_bytes: u.databaseIoReadBytes,
          database_io_write_bytes: u.databaseIoWriteBytes,
          database_read_documents: u.databaseReadDocuments,
          database_write_documents: u.databaseWriteDocuments,
          database_write_index_rows: u.databaseWriteIndexRows,
          file_storage_read_bytes: u.storageReadBytes,
          file_storage_write_bytes: u.storageWriteBytes,
          vector_storage_read_bytes: u.vectorIndexReadBytes,
          vector_storage_write_bytes: u.vectorIndexWriteBytes,
          text_search_query_bytes: u.textIndexQueryBytes,
          text_search_write_query_bytes: u.textIndexWriteQueryBytes,
          vector_search_query_bytes: u.vectorIndexReadQueryBytes,
          vector_search_write_query_bytes: u.vectorIndexWriteQueryBytes,
          network_egress_bytes: u.networkEgressBytes,
          memory_used_mb: u.memoryUsedMb,
          action_memory_used_mb: action ? u.memoryUsedMb : null,
          audit_log_egress_bytes: 0,
          function_args_bytes: ev.argsBytes,
          function_returns_bytes: ev.returnBytes,
        },
      };
    }
    case "exception": {
      // Convex's V2 falls back to the V1 shape for exceptions (only the local sink writes them).
      const type = { Query: "query", Mutation: "mutation", Action: "action", HttpAction: "httpAction" }[
        ev.source.udfType
      ];
      return {
        _timestamp: ms,
        _topic: "_exception",
        _functionPath: ev.source.path,
        _functionType: type,
        _functionCached: ev.source.udfType === "Query" ? ev.source.cached : null,
        message: ev.message,
        frames: ev.frames === null ? null : ev.frames.map((f) => f.text),
        udfServerVersion: null,
        userIdentifier: ev.userIdentifier,
      };
    }
    case "audit_log":
      return {
        timestamp: ms,
        topic: "audit_log",
        audit_log_action: ev.action,
        audit_log_metadata: JSON.stringify(ev.metadata),
      };
    case "custom_audit":
      return { timestamp: ms, topic: "custom_audit", body: ev.body };
    case "scheduler_stats":
      return {
        topic: "scheduler_stats",
        timestamp: ms,
        lag_seconds: Math.floor(ev.lagSeconds),
        num_running_jobs: ev.numRunningJobs,
      };
    case "scheduled_job_lag":
      return { timestamp: ms, topic: "scheduled_job_lag", lag_seconds: Math.floor(ev.lagSeconds) };
    case "current_storage_usage":
      return {
        timestamp: ms,
        topic: "current_storage_usage",
        total_document_size_bytes: ev.documentBytes,
        total_index_size_bytes: ev.indexBytes,
        total_vector_storage_bytes: ev.vectorBytes,
        total_text_storage_bytes: ev.textBytes,
        total_file_storage_bytes: ev.fileBytes,
        total_backup_storage_bytes: ev.backupBytes,
        total_system_table_document_size_bytes: ev.systemTableDocumentBytes,
      };
    case "concurrency_stats":
      return {
        timestamp: ms,
        topic: "concurrency_stats",
        query: concurrencyJson(ev.query),
        mutation: concurrencyJson(ev.mutation),
        action: concurrencyJson(ev.action),
        node_action: concurrencyJson(ev.nodeAction),
        http_action: concurrencyJson(ev.httpAction),
      };
  }
}

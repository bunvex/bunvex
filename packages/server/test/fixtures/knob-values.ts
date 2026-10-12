// Prints, as JSON, what each knob wired to the environment (STUDY-147) came to in this process: run by
// knobs-env.test.ts with every knob set, so a constant still hard-coded shows its default.
import * as metrics from "../../src/app-metrics.ts";
import * as codeVersion from "../../src/code-version.ts";
import { DATA_SYNC_LIMITS } from "../../src/data-sync.ts";
import * as exportsModule from "../../src/exports.ts";
import * as functionLog from "../../src/function-log.ts";
import * as functions from "../../src/functions.ts";
import * as imports from "../../src/imports.ts";
import * as warnings from "../../src/limit-warnings.ts";
import { defaultLogSinkOptions } from "../../src/log-sinks.ts";
import * as requestTimeout from "../../src/request-timeout.ts";
import { schedulerOptionsFromEnv } from "../../src/scheduler.ts";
import * as sessionCleanup from "../../src/session-cleanup.ts";
import * as streamingExport from "../../src/streaming-export.ts";
import * as systemFunctions from "../../src/system-functions.ts";

const sink = defaultLogSinkOptions();
const values: Record<string, unknown> = {
  UDF_METRICS_BUCKET_WIDTH_SECS: metrics.BUCKET_WIDTH_MS / 1000,
  UDF_METRICS_MAX_BUCKETS: metrics.MAX_BUCKETS,
  UDF_METRICS_MIN_DURATION_MS: metrics.HISTOGRAM_BOUNDS.low,
  UDF_METRICS_MAX_DURATION_MS: metrics.HISTOGRAM_BOUNDS.high,
  UDF_METRICS_SIGNIFICANT_FIGURES: metrics.HISTOGRAM_BOUNDS.figures,
  MAX_USER_MODULES: codeVersion.MAX_USER_MODULES,
  ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS: codeVersion.IMPORT_TIMEOUT_MS / 1000,
  DATA_SYNC_PAGE_SIZE_LIMIT: DATA_SYNC_LIMITS.pageSize,
  DATA_SYNC_BY_ID_FRESHNESS_SECONDS: Number(DATA_SYNC_LIMITS.byIdFreshnessNs / 1_000_000_000n),
  MAX_EXPIRED_SNAPSHOT_AGE_DAYS: Number(exportsModule.MAX_EXPIRED_SNAPSHOT_AGE_NS / (86_400n * 1_000_000_000n)),
  MAX_UDF_EXECUTION: functionLog.MAX_UDF_EXECUTION,
  MAX_REACTOR_CALL_DEPTH: functions.MAX_NESTED_CALL_DEPTH,
  HTTP_SERVER_TIMEOUT_SECONDS: requestTimeout.REQUEST_TIMEOUT_MS / 1000,
  MAX_IMPORT_AGE_SECONDS: imports.MAX_IMPORT_AGE_MS / 1000,
  V8_ACTION_USER_TIMEOUT_SECS: warnings.V8_ACTION_USER_TIMEOUT_MS / 1000,
  LOG_MANAGER_AGGREGATION_INTERVAL: sink.aggregationMs,
  SCHEDULED_JOB_EXECUTION_PARALLELISM: schedulerOptionsFromEnv().parallelism,
  SCHEDULER_OCC_INITIAL_BACKOFF_MS: schedulerOptionsFromEnv().occInitialBackoffMs,
  SCHEDULER_OCC_MAX_BACKOFF_MS: schedulerOptionsFromEnv().occMaxBackoffMs,
  SCHEDULED_JOB_INITIAL_BACKOFF_MS: schedulerOptionsFromEnv().errorInitialBackoffMs,
  SCHEDULED_JOB_MAX_BACKOFF_SECS: schedulerOptionsFromEnv().errorMaxBackoffMs / 1000,
  SCHEDULED_JOB_GARBAGE_COLLECTION_BATCH_SIZE: schedulerOptionsFromEnv().gcBatchSize,
  SCHEDULED_JOB_GARBAGE_COLLECTION_DELAY: schedulerOptionsFromEnv().gcDelayMs / 1000,
  SCHEDULED_JOB_GARBAGE_COLLECTION_INITIAL_BACKOFF_MS: schedulerOptionsFromEnv().gcInitialBackoffMs,
  SCHEDULED_JOB_GARBAGE_COLLECTION_MAX_BACKOFF_SECS: schedulerOptionsFromEnv().gcMaxBackoffMs / 1000,
  SYSTEM_TABLE_CLEANUP_FREQUENCY_SECONDS: sessionCleanup.SESSION_CLEANUP_FREQUENCY_MS / 1000,
  SNAPSHOT_LIST_LIMIT: streamingExport.SNAPSHOT_LIST_LIMIT,
  DOCUMENT_DELTAS_LIMIT: streamingExport.DOCUMENT_DELTAS_LIMIT,
  MAX_JOBS_CANCEL_BATCH: systemFunctions.MAX_JOBS_CANCEL_BATCH,
};
console.log(JSON.stringify(values));

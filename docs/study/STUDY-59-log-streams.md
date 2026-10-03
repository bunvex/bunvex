# STUDY-59 — Log streams (`_log_sinks`, the log stream API, webhook and local sinks)

- **Status:** implemented; decisions pending (owner): DV-303–DV-305
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-03
- **Related:** [STUDY-47](STUDY-47-log-streaming.md) (the function log the events come from),
  [STUDY-48](STUDY-48-audit-log.md) (the audit log, now streamed), [STUDY-58](STUDY-58-app-metrics.md)
  (scheduler and concurrency counts), STUDY-34 (`ViewIntegrations` / `WriteIntegrations`)

## 1. How Convex does it

### 1.1 Availability

- Log streaming is allowed when `_backend_info` has no row (`BackendInfoModel::is_log_streaming_allowed`),
  which is every self-hosted deployment. The self-hosted dashboard hardcodes `logStreamingEnabled: true`.
- `custom_audit` needs an entitlement that defaults to false, so self-hosted refuses it (403
  `CustomAuditLogsInLogStreamsNotEnabled`).

### 1.2 `_log_sinks` (crates/model/src/log_sinks)

- The table is number 535 (512 + 23). Each row is `{status, config}`.
  - `status` is one of `pending`, `restarting`, `failed{reason}`, `active` or `deleting`.
  - `config` is tagged by `type`: `local`, `datadog`, `webhook`, `axiom`, `sentry`, `postHogLogs`,
    `postHogErrorTracking` or `s3Export`.
- At most 8 live rows (400 `LogSinkQuotaExceeded`). Adding a type replaces its live row: the old one is
  marked deleting.
- `must_get` answers 404 `LogStreamDoesntExist` for a missing or deleting row. A malformed id gives 400
  `InvalidLogStreamId`.

### 1.3 The API (`local_backend/src/log_sinks.rs`, under `/api/v1/`)

- **Reads** need `ViewIntegrations`:
  - `GET list_log_streams` lists every row (deleting ones too; the local one left out) as `LogStreamConfig`.
    API keys and DSNs are left out; a webhook's `hmacSecret` is included.
  - `GET get_log_stream/{id}` answers one row.
- **Writes** need `WriteIntegrations`.
- **`POST create_log_stream`** takes a body tagged by `logStreamType`.
  - Checks, in order:
    1. the type already exists: 409 `LogStreamAlreadyExists` ("Webhook log stream already exists for this
       deployment");
    2. per-type validation: `InvalidWebhookUrl`, `EmptyLogTopics`, `InvalidLogTopic`,
       `InvalidAxiomIngestUrl`, `InvalidSentryDsn`, `InvalidPostHogHost`, `InvalidS3Bucket`;
    3. the topic entitlement.
  - It inserts a `pending` row and writes the audit event `create_integration {id, type}`.
  - The answer is `{logStreamType, id}`; a webhook's adds its `hmacSecret` (a UUID v4 without dashes).
- **`POST update_log_stream/{id}`**:
  - Each field given replaces the stored one, and `null` unsets an optional field.
  - Another type is 400 `LogStreamTypeMismatch`, worded per type.
  - Writes `update_integration`, then resets the row to `pending` so it is verified again.
- **`POST delete_log_stream/{id}`** marks the row deleting and writes `delete_integration`.
- **`POST rotate_webhook_secret/{id}`** answers `{logStreamType:"webhook", hmacSecret}` and writes
  `update_integration`. Another type is 400 `NoSecretToRotate`. The running sink keeps the old secret until
  it restarts.
- The dashboard reads `_system/frontend/listConfiguredSinks` (`ViewIntegrations`): the raw rows, only S3
  export's secret stripped.

### 1.4 The manager (`crates/log_streaming`)

- **`send_logs`** is a no-op unless some sink is active. Events go into a 4096-event channel; more are
  dropped.
- **The aggregator** flushes every 5 s (`LOG_MANAGER_AGGREGATION_INTERVAL`) or at 4096 events. It hands
  each drain to every sink's channel (capacity 8 drains, 50 for local), dropping the drain for a sink whose
  channel is full.
- **The startup worker** follows `_log_sinks`. Each pass:
  1. hard-deletes `deleting` rows and stops their sinks;
  2. starts `pending` sinks (verifying them, 15 s at most) and `restarting` ones (without);
  3. marks each started sink `active`, or `failed{reason}`;
  4. marks an `active` row with no running sink (after a restart) `restarting`.

  A failed update leaves the old sink running. Failed rows are never retried by themselves.
- **Webhook sink**:
  - Payload:
    - V2 JSON for every event, merged with the deployment metadata under `convex`, at most 128 events
      per request;
    - `json` sends an array, `jsonl` one object per line;
    - always `Content-Type: application/json`;
    - `x-webhook-signature: sha256=<hex HMAC-SHA256(secret, body)>`.
  - Retries:
    - 6 attempts (3 to verify), backoff 1 s – 60 s with full jitter, 30 s per request;
    - another 4xx is not retried ("endpoint rejected the request with 404 Not Found");
    - a 5xx, 408, 421, 425 or 429 is ("endpoint returned …", then "gave up after n attempts, last
      failure: …").
  - Verification posts a `verification` event. Once active, a failed batch is dropped.
- **Local sink** (`--local-log-sink <path>`): every event, exceptions included, as V2 JSON lines, appended
  and synced. A failed write is retried forever (1 s – 10 s).
- **S3 export** is a stub in the open-source backend: it starts and drains.
- **The filter**: verification always passes; exception goes only to error trackers (and local); with no
  `topics`, every topic but `custom_audit`; else the topics given.

### 1.5 The events (common/src/log_streaming.rs)

| Topic | When | V2 fields |
|---|---|---|
| `console` | each log line (an action's as it is printed) | `timestamp` (the line's), `function`, `log_level`, `message` (messages joined by a space), `is_truncated`, `system_code` |
| `function_execution` | each completion | `function`, `execution_time_ms`, `user_execution_time_ms`, `status`, `error_message`, `occ_info`, `will_retry`, `scheduler_info`, `run_reason`, `usage {…}` |
| `exception` | each failure | V1 shape: `_timestamp`, `_topic: "_exception"`, `_functionPath`, … |
| `audit_log` | each audit event, after its commit | `audit_log_action`, `audit_log_metadata` (internal JSON, as a string) |
| `scheduler_stats` | with the scheduler's stats, when late or busy | `lag_seconds`, `num_running_jobs` |
| `scheduled_job_lag` | when late | `lag_seconds` |
| `concurrency_stats` | every metrics bucket, when changed | `query`, `mutation`, `action`, `node_action`, `http_action` (`{num_running, num_queued}`) |

The `function` object is `{path, type, cached (queries), request_id, mutation_queue_length,
mutation_retry_count}`. Storage usage, AI gateway, egress and custom audit events are cloud-only.

## 2. What an app can observe

- The API: answers, errors and audit events.
- What a webhook endpoint or the local file receives: shape, signature, batching, retries.
- The dashboard's integrations page, through `listConfiguredSinks` and the API.

## 3. How bunvex does it

- **`server/src/log-sinks.ts`**:
  - the model: rows, `mustGetSink`, `addOrUpdateSink`;
  - `WebhookSink`, `LocalSink`, and S3 export's draining stub;
  - `LogManager`: buffer, flush, per-sink queues, the startup worker.
- **`server/src/log-events.ts`**: the events and their V2 JSON.
- **`server/src/log-sinks-routes.ts`**: the API, with every type's arguments and checks.
- **When the worker runs**: after each commit to `_log_sinks` (except its own), and on start.
- **Event sources**:
  - completions and action lines from `Functions` (`logCompletion`, `onLine`);
  - audit events: inserted `_deployment_audit_log` rows, read after their commit;
  - the scheduler's stats;
  - a 60 s concurrency timer.
- **Local sink**: `createServer({localLogSink})` or `BUNVEX_LOCAL_LOG_SINK`, in place of Convex's
  `--local-log-sink` flag. As Convex's `add_on_startup`, it replaces the stored local row.
- **Cost**:
  - With no sink active: none (one property check per completion).
  - With the local sink active, measured in process (30 000 calls × 3 rounds): about +0.5 µs per query
    (≈ 11 µs) and +2.5 µs per mutation (≈ 23 µs).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-303 | Datadog, Axiom, Sentry and PostHog streams are created, listed and updated as Convex's, and then fail to start ("Datadog log streams are not supported by bunvex yet."). | Ainda não fizemos: each needs its client. | pending (recommend: accept for now) |
| DV-304 | The event metadata is under `deployment`, not `convex`. The verification message is "Log stream connection test". The `custom_audit` refusal has no plans link. | Rule 5. Não dá pra fazer igual sem quebrar a regra. | pending (recommend: accept) |
| DV-305 | In `function_execution`: a subscription's `run_reason` is always `initialSubscription`; `scheduler_info`, `function_args_bytes` and `mutation_retry_count` are null. Exception `frames` are null. | Ainda não fizemos: the function log does not carry them. | pending (recommend: accept for now) |

Not divergences:

- No V1 format: only Datadog and Axiom rows that Convex created before V2 use it, and bunvex has no
  legacy data.
- The local sink is set by an option or environment variable instead of a binary flag.

## 5. Tests

`server/test/log-sinks.test.ts`, against a real HTTP endpoint (`Bun.serve`):

- **Webhook**:
  - creation, verification and the signature over the exact body;
  - the JSON Lines body; console and execution events (paths, levels, messages, status, run reason,
    usage keys);
  - no exceptions sent to it;
  - the audit event.
- **Topics and format**: only subscribed topics (verification always); `json` arrays; the audit log
  streamed with its metadata.
- **Failures**: a 404 at verification fails with Convex's reason and is not retried; a 503 gives "gave up
  after 3 attempts…"; an update verifies again.
- **The API's errors**: URL, topics, `custom_audit`, missing field, operation, duplicate, mismatch, id,
  Sentry DSN, Axiom ingest URL.
- **Another type**: Datadog stored, listed without its key, failed (DV-303); `NoSecretToRotate`; delete
  then removal; the audit trail.
- **Local sink**: every event as a line, exceptions included; not in the API; after a restart an active
  sink starts again without a new verification.
- **Sabotage checks**, each failing a test: signature, topics, exception filter, no retry on rejection,
  no verification on restart, hard delete, audit streaming, metadata, format, unsupported types, reset to
  pending, duplicate, `custom_audit`, completion events, the console message join.

## 6. Open questions

- The dashboard's integrations page is not built on the mock yet. Its contract is
  `listConfiguredSinks` plus these routes.

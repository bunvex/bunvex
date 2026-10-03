# STUDY-48 — The deployment audit log

- **Status:** accepted: A1–A3 as recommended (owner, 2026-10-03)
- **Convex source read:** `main` of get-convex/convex-backend, 2026-10-02
- **Related:** [STUDY-42](STUDY-42-import-export.md) (DV-218), [STUDY-37](STUDY-37-cli-and-environment-variables.md),
  [STUDY-30](STUDY-30-scheduler-and-crons.md), [STUDY-32](STUDY-32-file-storage.md). Scope chosen by the owner
  (2026-10-02): only the events of features bunvex has; the others wait in the ledger.

## 1. How Convex does it

### 1.1 The table

`_deployment_audit_log` (`crates/model/src/deployment_audit_log/mod.rs`): a global system table,
`DefaultTableNumber::DeploymentAuditLogs` = 15 (number 527), with the index `by_action_and_creation_time`
(`action`, `_creationTime`). One document per event (`types.rs` `SerializedDeploymentAuditLogEntry`):

| Field | Value |
|---|---|
| `action` | the event's snake_case name |
| `metadata` | the event's object (§1.2) |
| `member_id` | int64: the admin's member (`identity.member_id()`, or the import's member), else null |
| `token_id`, `app_client_id` | the access token and OAuth app, else null |
| `client_ip`, `client_user_agent` | the request's (`x-forwarded-for`'s first entry or the peer; `User-Agent`), null for the system |

No time field: the event's time is `_creationTime`. Only the system or an admin may insert
(`insert_with_member_override`). Nothing ever deletes them.

### 1.2 The events bunvex can make

Every event is inserted **in the transaction that makes the change** (`commit_with_audit_log_events`,
`execute_with_audit_log_events_and_occ_retries`). Component fields are null for the root.

| Change | `action` | `metadata` | Source |
|---|---|---|---|
| `POST /api/update_environment_variables` | `create_environment_variable` / `update_environment_variable` / `delete_environment_variable` | `{variable_name}`; a set of a new variable creates, of an existing one updates; an unset of an existing one deletes | `application/src/lib.rs` |
| `POST /api/delete_tables` | `delete_tables` | `{component_id, component, table_names}` | `lib.rs` `delete_tables` |
| `POST /api/cancel_job` | `cancel_scheduled_function` | `{component_id, component, scheduled_function_id, function_path}` (the job's `udf_path`, null if gone) | `local_backend/src/scheduling.rs` |
| `POST /api/cancel_all_jobs` | `cancel_all_scheduled_functions` | `{component_id, component}`, one per batch that canceled anything | `lib.rs` |
| `POST /api/export/request/zip` | `request_export` | `{id, component_id, component, format: "zip" \| "zip_with_storage", requestor: "snapshot_export"}` | `lib.rs` `request_export` |
| `POST /api/export/set_expiration/{id}` | `set_export_expiration` | `{id, expiration_ts_ms}` | `snapshot_export.rs` |
| `POST /api/export/cancel/{id}` | `cancel_export` | `{id}` | `snapshot_export.rs` |
| A snapshot import finishing | `snapshot_import` | `{table_names: [{component, table_names}] (first 20), table_count, import_mode, import_format, requestor, table_names_deleted, table_count_deleted}` | `snapshot_import/audit_log.rs` |
| Dashboard `fileStorageV2:deleteFile(s)` / `generateUploadUrl` | `delete_files` / `generate_upload_url` | `{component_id, component, storage_ids}` / `{component_id, component}` | `system-udfs` `writeAuditLog` |
| `finish_push` | `push_config_with_components` | the push's component diffs | `deploy_config.rs` |

Events of features bunvex does not have: usage limits, canonical URLs, pause/unpause, system stop state,
`clear_tables` (streaming import), components, `delete_scheduled_jobs_table`, log sinks (`*_integration`),
data sync, and the dashboard's document edits (`add_documents`, `update_documents`, `delete_documents`,
`create_table`).

### 1.3 Reading

- **Dashboard** (`system-udfs/convex/_system/frontend`):
  - `paginatedDeploymentEvents` (ViewAuditLog): newest first from `filters.minDate` to `maxDate`, of
    `authorMemberIds` (OR) and `actions` (OR).
  - `listDeploymentEventsFromTime` (ViewAuditLog): from `fromTimestamp`, oldest first.
  - `deploymentEvents:lastPushEvent` (ViewData): the newest `push_config` / `push_config_with_components`.
  - The documents are returned as stored.
- **HTTP**: `GET /api/v1/list_audit_log_events?from=&limit=&cursor=` (ViewAuditLog).
  - Events from `from` (ms), oldest first. `limit` defaults to 15; 0 or more than 100 is
    `LimitOutOfRange`.
  - The answer is `{items: [{actor, action, createTime, metadata, clientIp, clientUserAgent}],
    pagination: {hasMore, nextCursor?}}`.
  - `actor` is `{kind: "system"}` or `{kind: "member", member_id}`, and `metadata` is clean JSON (int64 as
    strings).
- **Retention**: `_backend_info.auditLogRetentionDays`, written by Convex's cloud.
  - -1 means everything.
  - A number of days refuses older HTTP reads (`AuditLogsTooOld`); the dashboard's queries clamp
    `minDate` to that many days plus one.
  - With no `_backend_info`, as on a self-hosted backend, the HTTP list is 403 `AuditLogsDisabled`, the
    dashboard's queries keep one day, and the History page is off.
- **Log sinks**: events are also streamed to log sinks, which bunvex does not have.

## 2. What an app can observe

Nothing from functions: the table is private. Operators and the dashboard see the documents of §1.1, the
system queries and the HTTP list.

## 3. How bunvex does it

- `@bunvex/core` `audit-log.ts`: the table (number 527, the same index) and `insertAuditLogEvents(db, events,
  actor)`, called inside each change's own transaction.
- `@bunvex/server` `audit-log.ts`: the events of §1.2 (but the push's, A2) and the actor: an admin key's member
  (bunvex keys carry one; 0 by default), null for the system key, and the request's IP and user agent.
- The three system queries and the HTTP list, as §1.3. The retention is the server option
  `auditLogRetentionDays` (A1).

## 4. Divergences

| # | Divergence | Why | Decision |
|---|---|---|---|
| A1 | The audit log is readable by default (`auditLogRetentionDays` -1; null or a number of days as Convex's) | Convex's self-hosted backend has no `_backend_info`, so its log is recorded but unreadable (403, the History page off): a cloud plan's limit, not a feature. **Possible to match**; recommended not to | DV-275, accepted (owner, 2026-10-03) |
| A2 | No `push_config_with_components` event yet | **Not done yet**: the push's diffs (modules, crons, indexes, schema, auth) are a follow-up PR | DV-276, accepted (owner, 2026-10-03) |
| A3 | `snapshot_import`'s `member_id` is null | bunvex's import rows have no member (STUDY-42). **Not done yet** | DV-277, accepted (owner, 2026-10-03) |

The events of features bunvex lacks wait for those features (ledger, "Waiting on a dependency").

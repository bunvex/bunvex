## Platform features around the core (parity inventory)

Scope: everything a self-hosted Convex deployment provides beyond the function/database API and client sync.
Reference: Convex `convex-backend` at commit 4577b9031. Paths are relative to that repo; `crates/x` means `crates/x/src/…`, and `npm/convex` means `npm-packages/convex/src`.

**bunvex baseline** (from ARCHITECTURE.md and `packages/*`):
- `@bunvex/auth`, `@bunvex/file-storage`, `@bunvex/cli` and `@bunvex/testing` are empty stubs.
- `@bunvex/server` has:
  - query, mutation and action definitions, and internal functions;
  - `POST /api/{query,mutation,action,query_ts,query_at_ts}`, the sync WebSocket at `/api/{version}/sync`,
    `GET /version` and `GET /stats` (JSON);
  - `PERSISTENCE` / `PERSISTENCE_URL` / `DATA` / `DURABLE` / `POOL` configuration, with Convex's
    `POSTGRES_URL` / `MYSQL_URL` / `DATABASE_URL`, `DO_NOT_REQUIRE_SSL`, `PG_CA_FILE` / `MYSQL_CA_FILE`, and
    the database call timeouts `POSTGRES_TIMEOUT_SECONDS` / `MYSQL_TIMEOUT_SECONDS` / `MONGODB_TIMEOUT_SECONDS`.
- `@bunvex/core` keeps every version with no GC. Its schema has the system indexes `by_id` and `by_creation_time` plus declared indexes, with no validators and no backfill.
- `ctx.auth` (STUDY-27) and `ctx.scheduler` (STUDY-30) exist; there is no ctx.storage yet.

Status legend: **done** · **partial** · **missing**. "Divergence?" in Notes marks where bunvex may deliberately differ; the owner has to decide those.

---

### 1. Authentication (end-user identity)

| Feature | Convex source (file/crate) | bunvex status | Notes |
|---|---|---|---|
| `auth.config.ts` with OIDC providers `{domain, applicationID}` | `npm/convex/server/authentication.ts`; `crates/common/auth.rs` (`AuthInfo::Oidc`) | done (STUDY-27) | Validated at server start (DV-100), with Convex's checks and messages. |
| Custom JWT provider `{type:"customJwt", issuer, jwks, algorithm RS256/ES256, applicationID?}` | `crates/common/auth.rs` (`AuthInfo::CustomJwt`) | done (STUDY-27) | Including `data:` JWKS URLs. |
| Evaluating the auth config in a sandbox on push | `crates/isolate/environment/auth_config.rs`; `crates/application/lib.rs` `get_evaluated_auth_config` | partial (STUDY-35) | `auth.config.js` is evaluated in its own `vm` context in the import phase (seeded random, fixed time, no fetch or timers), `process.env` = the deployment's variables and the built-ins (STUDY-37; a missing one fails with Convex's `AuthConfigMissingEnvironmentVariable`); stored in the code package, re-evaluated on a restart and on every variable update (an update that breaks it is refused), and `finish_push` fails with `RaceDetected` if the variables changed during the push; validated as at start (`parseAuthConfig`). Embedded servers keep `createServer({ auth })` (DV-100). |
| `_auth` system table and auth diff on push | `crates/model/auth` | missing | The diff (added/removed providers) goes to the deploy audit log. |
| Re-evaluating the auth config when env vars change | `crates/application/lib.rs` `reevaluate_existing_auth_config` | missing | An env var change that would break the auth config is rejected. |
| OIDC discovery (`/.well-known/openid-configuration`) and JWKS fetch | `crates/authentication/lib.rs` `validate_id_token` | done (STUDY-27) | `@bunvex/auth` `TokenVerifier` (`jose`): RS256 / EdDSA, exact `iss` / `aud`. |
| JWKS / discovery caching | `crates/http_client` (`CachedHttpClient`, knob `HTTP_CACHE_SIZE` 16 MiB) | done (STUDY-27) | By `Cache-Control`, plus a rate-limited refetch on an unknown `kid` (DV-101). |
| Provider matching by `iss` / `aud` | `crates/common/auth.rs` `matches_token` | done (STUDY-27) |  |
| Clock skew and required `exp` (custom JWT) | `crates/authentication/lib.rs` | done (STUDY-27) | 5 s leeway, `exp` required. |
| `ctx.auth.getUserIdentity()` fields | `npm/convex/server/authentication.ts`; `crates/keybroker/broker.rs` `UserIdentity::from_token` | done (STUDY-27) |  |
| Identity expiry at JWT `exp` (sync session `TokenExpired`) | `crates/sync/state.rs` | done (STUDY-27) | `Token identity expired`, `authUpdateAttempted: false`. |
| Invalid token: null in queries and mutations, throw in actions | `crates/isolate/environment/action/task_executor.rs` | missing | A subtle behaviour that apps can observe. |
| WebSocket `Authenticate` message and `AuthError` reply | `crates/sync/worker.rs`; `sync_types/json.rs` | done (STUDY-27, STUDY-34) | `User` tokens and `Admin` keys (`impersonating` or `actingAs`); a bad admin key gets `AuthError` with `authUpdateAttempted: false`. |
| HTTP `Authorization: Bearer <jwt>` | `crates/local_backend/authentication.rs` | done (STUDY-27) | 401 with Convex's codes for a bad token; `Bunvex <admin key>` is an admin (STUDY-34). |
| Client `setAuth(fetcher)` and refresh (leeway 10 s, force refresh after confirm, 2 retries) | `npm/convex/browser/sync/authentication_manager.ts` | done (STUDY-27) | `@bunvex/client`; see client-sync.md. |
| Query cache keyed by identity | `crates/keybroker` `Identity::cache_key` | done (STUDY-27) | Keyed by the identity's attributes only when the run read it, as Convex (`observed_identity`). |
| Acting as a user (admin impersonation, `actingAs`) | `crates/application/lib.rs` `authenticate`; header `Convex <key>:<b64 identity>` | done (STUDY-34) | `Bunvex <key>:<b64 identity>` (DV-97) and sync's `impersonating`; needs `ActAsUser`; `tokenIdentifier`, or `issuer|subject`; a malformed identity is 400 `HeaderParseFailure`; never with a system key. |
| Clerk / Auth0 / Convex Auth / WorkOS helpers | docs; `npm/convex` react-clerk, react-auth0; `crates/workos_client` | missing | ARCHITECTURE lists clerk and auth0 as D. They are only OIDC configurations plus client glue. |

### 2. Deployment auth, admin keys, operations

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Instance secret (32-byte hex), required at startup | `crates/keybroker/secret.rs`; `crates/local_backend/config.rs` | done (STUDY-40) | `bunvex-local-backend` requires it (32 hex bytes, Convex's messages), as Convex's binary; the Docker scripts (`read_credentials.sh`) and `bunvex dev`'s local deployments generate and keep one. Embedded servers keep the store's (DV-07). |
| Admin key format `instance_name\|encrypted proto` (AES-GCM-SIV, KBKDF) | `crates/keybroker/broker.rs` `issue_key`, `encryptor.rs` | done (STUDY-34) | Byte for byte Convex's: `issueAdminKey` / `checkAdminKey` in `@bunvex/server` (AES-128-GCM-SIV from RFC 8452, KBKDF-CTR-HMAC-SHA256 "admin key", the `AdminKey` proto), checked against aws-lc-rs fixtures; keys never expire; type prefixes stripped. Legacy secretbox keys are refused (DV-158). |
| Generating an admin key (`generate_key`, `keygen admin-key`, `generate_admin_key.sh`) | `crates/keybroker/bin/generate_key.rs`; `self-hosted/docker-build/generate_admin_key.sh` | done (STUDY-34) | `bunvex admin-key [--read-only] [--system]` (DV-160, DV-161): the name and secret from the flags, `INSTANCE_NAME` / `INSTANCE_SECRET`, else the store's `_instance` read without the lease (works while the server runs). "Admin key:" on stderr, the key on stdout, as `generate_key`. |
| System keys (`Identity::System`) | `broker.rs` `issue_system_key` | done (STUDY-34) | Issued with `system: true`; every operation allowed; not an admin for `check_admin_key`. |
| Read-only admin keys and the `DeploymentOp` permission set | `crates/keybroker/operations.rs` | done (STUDY-34) | Convex's 26 operations and read-only set; `OperationNotPermitted` with Convex's action names. Read-only keys can be issued (DV-161). |
| Admin-only access to internal functions | `crates/udf/validation.rs` `check_visibility_access` | done (STUDY-34) | An admin (or system key) runs internal queries, mutations and actions with `RunInternal*`; to anyone else they do not exist. `_system/*` functions likewise, each with its operation; sync checks access before reusing another session's run. |
| `Authorization: Convex <adminKey>` header, `?adminKey=` | `crates/local_backend/authentication.rs` | done (STUDY-34) | `Bunvex <adminKey>` (DV-97), type prefixes stripped; `?adminKey=` without a header. Errors: 401 `BadAdminKey`, 403 `BadDeployKey`, 403 `OperationNotPermitted`. |
| `GET /api/check_admin_key` | `crates/local_backend/dashboard.rs` | done (STUDY-34) | `{success, allowedOps, isReadOnly}` (`[]` is every operation); 403 `BadDeployKey` without an admin. |
| Deploy and preview keys, team/OAuth tokens | `crates/authentication/application_auth.rs` (`AccessTokenAuth`) | missing | Self-hosted Convex uses `NullAccessTokenAuth`, so only admin keys work. The cloud-only token types can be skipped. |
| Action callback token (`Convex-Action-Callback-Token`) | `crates/local_backend/node_action_callbacks.rs` | missing | Only needed with an out-of-process Node executor. |
| Other signed tokens (upload, export download, cursor, data-sync cursor) | `crates/keybroker/encryptor.rs` purposes | missing | One key derivation per purpose from the instance secret. |
| Deployment audit log (`_deployment_audit_log`) | `crates/model/deployment_audit_log` | partial (STUDY-48) | Convex's documents (number 527, `by_action_and_creation_time`), each in the change's transaction: environment variables, `delete_tables`, job cancels, exports, `snapshot_import`, the dashboard's file mutations. Read by `_system/frontend/paginatedDeploymentEvents`, `listDeploymentEventsFromTime`, `deploymentEvents:lastPushEvent` and `GET /api/v1/list_audit_log_events`; readable by default (DV-260, accepted). Not yet: the push's event (DV-261); the events of features bunvex lacks. |

### 3. File storage

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `ctx.storage.generateUploadUrl()` (mutations and actions) | `npm/convex/server/storage.ts`; `crates/file_storage/core.rs` | done (STUDY-32) | `{cloud origin}/api/storage/upload?token=`; the origin is `cloudOrigin` / `BUNVEX_CLOUD_ORIGIN` (F2). |
| `POST /api/storage/upload?token=` | `crates/local_backend/storage.rs` | done (STUDY-32) | Streamed and hashed; `Digest` checked; `{storageId}`; no size limit (F4). Token errors with Convex's codes. |
| The `_storage` metadata row is written in its own transaction after the upload | `crates/file_storage` `store_entry` | done (STUDY-32) | |
| `ctx.storage.getUrl(id)` | syscall `1.0/storageGetUrl` | done (STUDY-32) | Reactive (the row is read in the transaction). |
| `GET /api/storage/{uuid}`: serving | `crates/local_backend/storage.rs`; `crates/file_storage/lib.rs` | done (STUDY-32) | Convex's headers; one range 206, several 416; HEAD; `/api` CORS. |
| `ctx.storage.delete(id)` | `crates/model/file_storage` `delete_file` | done (STUDY-32) | Transactional. The blob is removed after commit, and orphans are swept hourly (F3, DV-150); Convex never removes them. |
| `ctx.storage.store(blob)` / `get(id)` (actions only) | `npm-packages/udf-runtime/src/storage.ts` | done (STUDY-32) | |
| `ctx.storage.getMetadata` (deprecated) | syscall `1.0/storageGetMetadata` | done (STUDY-32) | |
| `_storage` virtual table `{_id, _creationTime, sha256 (base64), size, contentType}` | `crates/model/file_storage/virtual_table.rs` | done (STUDY-32) | A real system table, projected (F1). |
| `ctx.db.system.get/query` for virtual system tables | `npm/convex/server/database.ts` (system reader) | done (STUDY-32) | `_scheduled_functions`, `_storage`. |
| Storage id formats: `Id<"_storage">` and legacy UUID | `crates/model/file_storage/mod.rs` `FileStorageId` | done (STUDY-32) | Convex's messages. |
| Per-transaction file limits (10 files and 16 MiB read/written) | `crates/common/knobs.rs` `TRANSACTION_MAX_NUM_FILES_*` | done (STUDY-32) | Not enforced in Convex either. |
| Blob backends: local directory and S3 (`S3_STORAGE_*_BUCKET`, `S3_ENDPOINT_URL`, path style) | `crates/storage`; `crates/aws_s3`; `crates/aws_utils` | partial (STUDY-32) | `@bunvex/file-storage`: local (`<dir>/files/<key>.blob`, synced; `STORAGE_DIR`, else `<DATA>/storage`), S3 through Bun's S3Client with Convex's variable names (files bucket), memory for tests; a conformance suite (S3 in CI on RustFS). Other use cases' buckets come with their features. |
| Storage type pinned at init (`_db` globals) | `crates/model/database_globals` | partial (STUDY-32) | The S3 key prefix is kept in `_instance` (`bunvex-<uuid>/`); switching local↔S3 is not checked yet. |
| Dashboard: file system functions (`numFiles`, `fileMetadata`, `getFile`, `deleteFile`, `deleteFiles`, `generateUploadUrl`) | `system-udfs/convex/_system/frontend/fileStorageV2.ts` | partial (STUDY-32) | Convex's names, arguments and shapes (each file with its `url` first); `deleteFiles` is one transaction. With their audit-log entries (`delete_files`, `generate_upload_url`, STUDY-48); reachable by admins (STUDY-34). |
| Total file-storage size gauge | `FileStorageSizeTracker` | missing | Used for usage reporting. |

### 4. Scheduler

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `ctx.scheduler.runAfter(ms, fn, args)` / `runAt(ts\|Date, fn, args)` | `npm/convex/server/scheduler.ts`; `impl/scheduler_impl.ts` | done (STUDY-30) | Mutations and actions; a reference or a name. Function handles come with components. |
| Scheduling is transactional (a job exists only if the mutation commits) | `crates/model/scheduled_jobs` | done (STUDY-30) | From actions, each call commits at once. |
| Validation at schedule time: ±5 years, target must exist | `crates/udf/validation.rs` | done (STUDY-30) | Convex's messages; the kind and the args are checked when the job runs. |
| Limits: 1000 scheduled per transaction, 16 MiB total args (docs say 8 MB) | `knobs.rs` `TRANSACTION_MAX_NUM_SCHEDULED` etc. | done (STUDY-30) | As Convex's code (16 MiB). |
| `_scheduled_functions` virtual table `{name, args, scheduledTime, completedTime?, state}` | `crates/model/scheduled_jobs/virtual_table.rs` | done (STUDY-30) | A real system table, projected to the public shape through `db.system` (S2, DV-140); only `by_id` / `by_creation_time` are public. |
| `ctx.scheduler.cancel(id)` | `SchedulerModel::cancel` | done (STUDY-30) | As Convex: no-op on finished jobs; self-cancel refused; what a canceled running action schedules is born canceled. |
| Scheduled mutations run exactly once | `crates/application/scheduled_jobs` | done (STUDY-30) | The job is finished in the mutation's transaction; OCC retried with backoff (100 ms to 60 s); a user error gives `failed`. |
| Scheduled actions run at most once | same | done (STUDY-30) | A job found in progress that no one runs fails with "Transient error while executing action". |
| System-error retry with backoff (500 ms to 2 h, unbounded attempts) | same; knobs `SCHEDULED_JOB_*_BACKOFF` | done (STUDY-30) | |
| Executor parallelism 8; pauses when the deployment is paused | knob `SCHEDULED_JOB_EXECUTION_PARALLELISM` | partial (STUDY-30) | Parallelism 8 (env as Convex); pausing waits for the deployment state. Woken by commits, no polling. |
| GC of finished jobs after 7 days | `SCHEDULED_JOB_RETENTION`; `crates/application/system_table_cleanup` | done (STUDY-30) | `SCHEDULED_JOB_RETENTION` (seconds), as Convex. |
| Dashboard / API: cancel one job, cancel all, delete the scheduled-functions table | `/api/cancel_job`, `/api/cancel_all_jobs`, `/api/delete_scheduled_functions_table` | partial (STUDY-30, STUDY-34) | `_system/frontend/paginatedScheduledJobs` and `scheduler:getArgs` in Convex's shapes, for admins; `POST /api/cancel_job` and `/api/cancel_all_jobs` with `WriteData` (batches of 1000, by function and `nextTs` range). Deleting the table is not done. |
| Per-component scheduling | `crates/model/scheduled_jobs` (per namespace) | missing | Depends on components. |

### 5. Cron jobs

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `cronJobs()` with `interval`, `hourly`, `daily`, `weekly`, `monthly`, `cron("m h dom mon dow")` | `npm/convex/server/cron.ts` | done (STUDY-30) | Convex's messages. Cron strings follow saffron exactly (its quirks included), checked against saffron itself on 7143 cases. |
| Defined as the default export of `convex/crons.ts`, validated at analyze time | `crates/isolate/environment/analyze.rs`; `application_function_runner` `validate_cron_jobs` | partial (STUDY-30) | `createServer({ crons })`, checked at start with Convex's messages (S1, DV-139); `crons.ts` discovery comes with the CLI. |
| `_cron_jobs`, `_cron_next_run`, `_cron_job_logs` tables | `crates/model/cron_jobs` | done (STUDY-30) | Convex's three tables and indexes; not visible to apps. |
| Diff on push (added / updated / deleted) | `CronModel::apply` | done (STUDY-30) | At start (S1). A new interval cron runs at once; a schedule change moves the next run under the 30 s rule. |
| Splay (`CRON_SPLAY_SECONDS` 60) | `crates/model/cron_jobs/next_ts.rs` | done (STUDY-30) | As Convex (DV-85), `CRON_SPLAY_SECONDS` (0 turns it off). |
| No overlapping runs; missed runs skipped, not replayed | `crates/application/cron_jobs` | done (STUDY-30) | An interval's skips are logged as one `canceled` run. |
| Dashboard: list crons and their run history | `system-udfs/_system/frontend/listCronJobs.ts`, `listCronJobRuns.ts` | done (STUDY-30, STUDY-34) | Both system functions, in Convex's document shapes, for admins with `ViewData`. |

### 6. Full-text search

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `searchIndex(name, {searchField, filterFields?, staged?})` | `npm/convex/server/schema.ts` | partial (STUDY-45) | Declared, staged or not, with Convex's push-time checks and messages (16 filter fields, deduplicated; one index per `(searchField, filterFields)`; names unique across kinds and not reserved; field paths; 64 indexes per table), the schema JSON's `searchIndexes` / `stagedSearchIndexes`, and the data model's types. Not yet built or queryable (PR 2). Not checked: that the fields exist in the document schema (Convex's `check_index_references`, for database indexes too). |
| `withSearchIndex(i, q => q.search(f, text).eq(ff, v)…)` | `npm/convex/server/search_filter_builder.ts` | missing | One `.search`, up to 8 `.eq`. |
| Tokenizer: split on whitespace and punctuation, lowercase, drop terms over 32 chars, no stemming | `crates/search/constants.rs` (`convex_en`) | missing | Needed for identical results. |
| Query limits: 16 terms (extras dropped), prefix match on the last term, fuzzy removed | `crates/search/lib.rs`, `query.rs` | missing | Up to 16 prefix expansions per term, 64 unique terms. |
| BM25 relevance; order by score desc, then newest `_creationTime` | `crates/search/lib.rs`, `scoring.rs` | missing | Prefix-match terms get half the boost. |
| At most 1024 results / scanned candidates | `MAX_CANDIDATE_REVISIONS`; `crates/database/query/search_query.rs` | missing | |
| Transactional and reactive (read set records terms and filters) | `crates/search/query.rs` `QueryReads` | missing | Needs a search-term read set in bunvex's invalidation, which today tracks key intervals only. |
| Memory index plus disk segments, flusher and compactor workers | `crates/search_index_workers`; `crates/search/text_index_manager.rs` | missing | Internal to Convex. bunvex could use its own design as long as it is consistent. |
| Write backpressure at 100 MiB in-memory index | `transaction.rs` `validate_memory_index_sizes` | missing | |
| States Backfilling / Backfilled / SnapshottedAt; staged indexes | `crates/common/bootstrap_model/index/text_index` | missing | |

### 7. Vector search

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `vectorIndex(name, {vectorField, dimensions, filterFields?, staged?})` | `npm/convex/server/schema.ts` | missing | Dimensions 2–4096. |
| `ctx.vectorSearch(table, index, {vector, limit, filter})` in actions only | `crates/isolate/environment/action/async_syscall.rs` | missing | Not reactive or transactional. |
| Limit up to 256 (default 10); filter only `q.eq` / `q.or`, 64 values max | `crates/vector/lib.rs`, `query.rs` | missing | |
| Cosine `_score`, results `{_id, _score}` | `crates/vector/qdrant_segments.rs` | missing | Convex uses Qdrant: HNSW m=16, with plain brute force for small segments. bunvex could brute-force first. |
| Dimension mismatch error | `crates/vector/qdrant_index.rs` | missing | |
| Backfill, compaction, 100 MiB hard limit | `crates/search_index_workers/vector_index_worker` | missing | |

### 8. HTTP actions

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `httpRouter()` and `route({path \| pathPrefix, method, handler})` in `convex/http.ts` | `npm/convex/server/router.ts` | done (STUDY-31) | Passed as `createServer({ http })`, checked at start (H1, DV-143). |
| `httpAction(handler(ctx, Request) => Response)` | `npm/convex/server/impl/registration_impl.ts` | partial (STUDY-31) | ctx: runQuery, runMutation, runAction, scheduler, auth; storage and vectorSearch come with their features. |
| Served under `/http/*` and a separate site origin (port 3211 proxy, `CONVEX_SITE_URL`) | `crates/local_backend/router.rs`, `proxy.rs`, `http_actions.rs` | done (STUDY-31) | `/http/*` on the API port and the site port (`sitePort`, default the API port + 1; DV-86). The URL a handler sees is rebuilt from Host / X-Forwarded-Proto / Forwarded. |
| Streaming request and response bodies; 20 MiB body limit | `crates/udf/http_action.rs` `HTTP_ACTION_BODY_LIMIT` | done (STUDY-31) | Responses cut past 20 MiB (logged), as Convex; requests capped by `maxRequestBodySize` (H3, DV-145). No body on GET, HEAD, OPTIONS. |
| CORS is left to the app (no backend CORS on `/http`) | `router.rs` | done (STUDY-31) | |
| Component HTTP mounts (`httpPrefix`) | `application_function_runner/http_routing.rs` | missing | |
| Errors: 404 `No matching routes found` / not enabled, 405, 500 JSON `{code, trace?, data?}` with a fresh request id, 408 at 300 s, 429 past 64 concurrent actions | `action/mod.rs`, `redaction.rs`, `http_routing.rs`, `application_function_runner` | done (STUDY-31) | "not enabled" says "bunvex deployment"; the 429 message ends with how to raise the limit (DV-03). |
| Auth from `Authorization` never rejects up front; `getUserIdentity()` throws the verification error | `http_actions.rs`, `task_executor.rs` | done (STUDY-31) | |
| Request id header added to the request when missing | `common/src/http/mod.rs` `ExtractRequestId` | done (STUDY-31) | `bunvex-request-id` (H2, DV-144). |
| Concurrent actions limited (64), a 10 s wait, then 429 `TooManyConcurrentRequests` | knob `APPLICATION_MAX_CONCURRENT_V8_ACTIONS` | done (STUDY-31) | Every action (HTTP API, sync, scheduled, nested, HTTP actions), with Convex's knob names. |

### 9. Node.js actions ("use node")

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `"use node"` directive and a separate runtime for those modules | `npm/convex/bundler`; `crates/node_executor`; `npm-packages/node-executor` | missing | **Divergence (owner, 2026-10-01, DV-87):** the directive is accepted and those modules run in Bun itself, which has the Node APIs; no separate Node runtime. |
| Only actions allowed in "use node" files; not allowed in http, crons, schema or auth.config | `node_executor/executor.rs`; `bundler/index.ts` `mustBeIsolate` | missing | An app written for Convex expects these errors. |
| `node.externalPackages` (installed server-side, `_external_deps_packages`) | `bundler/external.ts`; `crates/model/external_packages` | missing | |
| Node action timeout 600 s vs V8 action 1800 s | knobs `NODE_ACTION_USER_TIMEOUT_SECS`, `V8_ACTION_USER_TIMEOUT_SECS` | missing | bunvex actions have no timeout at all. |

### 10. Environment variables

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Deployment env vars in the `_environment_variables` table | `crates/model/environment_variables` | done (STUDY-37) | `{ name, value }` by `by_name`; `POST /api/update_environment_variables` (one batch: removals, then sets, then the limits; `WriteEnvironmentVariables`) and `GET /api/list_environment_variables` (`ViewEnvironmentVariables`), also under `/api/v1/`; `_system/cli/queryEnvironmentVariables` and `:get`. Built-ins `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL` (DV-179) cannot be set. |
| `process.env.X` inside functions | `udf-runtime/00_misc.ts`; `crates/isolate/ops/environment_variables.rs` | done (STUDY-37) | Pushed code: Convex's isolate proxy (one name at a time, lists nothing, a name that does not parse throws); `"use node"` sees the allowlist (`PATH`, `PWD`, `LANG`, `NODE_PATH`, `TZ`, `UTC`) plus the deployment's, listable. Embedded servers' functions see the host's `process.env` (DV-180). Measured: +0.6 µs per uncached query of pushed code (`packages/server/bench/env-vars.ts`). |
| Env reads are in the read set; changes invalidate subscriptions and the cache | `crates/udf/environment.rs` `PreloadedEnvVars` | done (STUDY-37) | Each name read records its `by_name` range (a missing name too); the variables of a snapshot come from a cache the committer invalidates; actions read them once, at their start. |
| Limits: name `^[a-zA-Z_][a-zA-Z0-9_]*$` up to 256, value 8 KiB, 512 vars, 512 KiB total | `crates/common/types/environment_variables.rs`; knobs `ENV_VAR_*` | done (STUDY-37) | Convex's codes and messages. Not knobs (fixed). |
| Built-ins `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL` (not overridable; canonical URL overrides) | `crates/udf/environment.rs`; `/api/update_canonical_url`; `_canonical_urls` | partial | `BUNVEX_CLOUD_URL` / `BUNVEX_SITE_URL` from the server's origins (rule 5 names, STUDY-37), not overridable by a deployment variable. No canonical URL overrides (`/api/update_canonical_url`, `_canonical_urls`). |
| `POST /api/update_environment_variables`, `GET /api/list_environment_variables` (+ `/api/v1`) | `crates/local_backend/environment_variables.rs` | done (STUDY-37) | Both routes and their `/api/v1` forms, with Convex's operations, limits and messages (`server.ts` `envRoute`). |
| Component env declarations (`defineComponent({env})`, `app.use(c,{env})`) | `npm/convex/server/components/index.ts` | missing | Only the root sees user vars. |

### 11. Components

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `convex.config.ts`: `defineApp()`, `app.use(component, {name, httpPrefix, env})` | `npm/convex/server/components/index.ts` | missing | Not on the ARCHITECTURE map. |
| `defineComponent(name)` and a component's own schema and functions | same; `crates/model/components` | missing | |
| Table and function isolation per component (`TableNamespace`) | `crates/model/components`; `_components`, `_component_definitions` tables | missing | |
| Calling a component: `ctx.runQuery(components.x.fn, args)` | `server/impl/actions_impl.ts` | missing | Also works from mutations via `ctx.runMutation`, at depth up to 8. |
| Function handles (`createFunctionHandle`, `_function_handles`) | `crates/model/components/handles.rs` | missing | Used by the scheduler and by components. |
| Component type checking on push | `crates/model/components/type_checking.rs` | missing | |
| Ecosystem components (ratelimiter, workpool, aggregate, …) | `npm-packages/components/`; external `@convex-dev/*` | missing | Popular apps depend on these, so they are the main reason to support components. |

### 12. CLI (`npx convex …`)

bunvex's `@bunvex/cli` is an empty stub; ARCHITECTURE marks dev, codegen and deploy M and the rest D.

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `dev` (watch, push, typecheck, codegen, `--once`, `--until-success`, `--run`, `--tail-logs`, local backend) | `npm/convex/cli/dev.ts`; `lib/localDeployment/*` | partial (STUDY-37) | `bunvex dev`: each push is `bunvex deploy`'s (codegen, bundle, start_push, codegen, typecheck, wait_for_schema, finish_push), then `✔ HH:MM:SS bunvex functions ready! (Xs)`; the functions directory watched (`_generated/`, dotfiles and `node_modules` aside) with Convex's 500 ms quiet period, and a change during a push pushed again; an app error waits for the next change, an unreachable deployment or a push race backs off (500 ms doubling to 16 s, ±50%); `--once`, `--until-success`, `--run` (after the first success), `--start` (its failure ends dev), `--typecheck`, `--codegen`. With no deployment configured, the project's local deployment, as Convex's (STUDY-40, DV-199–DV-201): `bunvex-local-backend` from the latest release (GitHub's API), cached in `~/.cache/bunvex/binaries/<version>/`, run as a child on the saved or first free ports from 3210 (`--local-cloud-port`, `--local-site-port`), ready on `/instance_name`; state in `.bunvex/local/default/` (`config.json`, SQLite, storage); `.env.local` gets `BUNVEX_DEPLOYMENT=local:<name>` and the framework's URL variables; the upgrade prompt (`--local-force-upgrade`, `--local-backend-version`); the "still running" check; one-off commands start it for themselves. No local dashboard (DV-202). Not yet: log tailing (DV-184, item 12), waiting on env vars or a table after such errors, cloud flags (DV-186). |
| `deploy` (`--dry-run`, `-y`, `--cmd`, `--preview-*`, `--skip-large-indexes-check`, `--message`) | `cli/deploy.ts`; `lib/deploy2.ts` | partial (STUDY-35) | `bunvex deploy [--url] [--admin-key] [--dry-run] [--env-file]`: bundles `bunvex/` (or `bunvex.json`'s `functions`, DV-170) and pushes over deploy2 with the diff of module hashes; target from `BUNVEX_SELF_HOSTED_URL` / `BUNVEX_SELF_HOSTED_ADMIN_KEY` (DV-171), the environment, `.env.local`, `.env`. Codegen before bundling and after `start_push`, then the typecheck (`--codegen enable|disable`, `--typecheck enable|try|disable`, default `try`; STUDY-36); `-y`, `--cmd`, previews and the large-index check are missing. |
| `run <fn> [args]` (`--watch`, `--push`, `--identity`, `--component`, `--inline-query`) | `cli/run.ts` | partial (STUDY-37) | `bunvex run`: Convex's name forms, JSON5 args (bunvex's own reader, DV-185), `--identity` with Convex's defaults (issuer `https://bunvex.test`, DV-181), log lines on stderr, the result on stdout (inspected on a terminal, else JSON), the deployment's functions listed for a missing one (`_system/cli/modules:apiSpec`, without HTTP routes), `--push`, `--watch` (a WebSocket subscription through `@bunvex/client`, DV-182: the result, then each change; "Watching query … on …" and "Closing connection to …" as Convex); `--component` and `--inline-query` are not built (DV-186). |
| `import` (`--table`, `--replace`, `--append`, `--replace-all`, `--format csv\|jsonLines\|jsonArray\|zip`) | `cli/convexImport.ts` | done (STUDY-42) | `bunvex import`: the format from the extension or `--format` (a mismatch warns), `--table`'s rules, the upload in 5 MiB parts (`BUNVEX_IMPORT_CHUNK_SIZE`), "There is already a snapshot import in progress.", the summary and "Perform import?" (`-y`), progress and checkpoints, "Added N documents to table "T"."; follows the row by polling. No `--component` (DV-215) or dashboard links (DV-217). |
| `export --path [--include-file-storage]` | `cli/convexExport.ts` | done (STUDY-42) | `bunvex export`: request, follow, download into a directory (the server's file name) or to a new path; an existing file refused; Convex's messages, without dashboard links (DV-217). |
| `data [table] --limit --order --format --component` | `cli/data.ts` | done (STUDY-43) | `bunvex data`: the user tables sorted (`_system/cli/tables`), or a table's documents (`_system/cli/tableData`, `db.system` for `_storage` and `_scheduled_functions`) newest or oldest first, as Convex's table (its columns, padding and cut to the terminal's width), JSON array or lines, each value printed as Convex's CLI does (`5n`, `Bytes("…")`); Convex's warnings and empty messages. No `--component` until components (DV-224). |
| `logs` (`--history`, `--success`, `--jsonl`) | `cli/logs.ts` | missing | |
| `env set\|get\|remove\|list` (and `env default …`, which is cloud-only) | `cli/env.ts` | done (STUDY-37) | `bunvex env`: Convex's forms (`NAME value`, `NAME=value`), value sources (argument, `--from-file`, piped stdin, a prompt), the .env batch (`--force`, CLI-managed `BUNVEX_*` names skipped), `get` (missing: stderr, exit 0), `remove`/`rm`/`unset`, `list [--names-only]` with Convex's dotfile quoting; messages on stderr, values on stdout. The batch reads .env lines (no multi-line quoted values, which dotenv accepts). `env default` is cloud-only (DV-186). |
| `codegen` (`--typecheck`, `--init`, `--commonjs`, …) | `cli/codegen.ts` | partial (STUDY-36) | `bunvex codegen [--init] [--typecheck]`, from the code alone with no deployment (DV-173). `--init` writes `tsconfig.json` (with `allowImportingTsExtensions`, DV-177) and `README.md`. The typecheck is the app's own `tsc --project <functions>`. No `--commonjs`, `--dry-run`, `--debug` or `--component-dir`. |
| `function-spec` (JSON of every function's args and returns) | `cli/functionSpec.ts` | done | `bunvex function-spec [--file]`: `{ url, functions }` with two-space indentation — `_system/cli/modules:apiSpec` (each function's identifier, kind, visibility, validators, then the HTTP routes as `HttpAction` entries, as Convex) and the API's URL from `_system/cli/deploymentUrl:cloudUrl` (Convex's `convexUrl:cloudUrl`, renamed by rule 5, DV-226); `--file` writes `function_spec_<ms>.json`. |
| `typecheck`, `dashboard`, `docs`, `update`, `network-test` | `cli/*.ts` | missing | Low priority. |
| `mcp start` (tools: data, env, functionSpec, logs, run, runOneoffQuery, status, tables) | `cli/mcp.ts`; `lib/mcp/tools` | missing | ARCHITECTURE marks mcp D. |
| `deployment create/select/token/usage-limits`, `login`, `project` | `cli/deployment.ts` etc. | missing | Cloud-only; can be skipped. |
| Self-hosted selection via `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY`, `--url`, `--admin-key`, `--env-file` | `cli/lib/command.ts`, `lib/deployment.ts` | done (STUDY-35, STUDY-37) | `BUNVEX_SELF_HOSTED_URL` / `BUNVEX_SELF_HOSTED_ADMIN_KEY` (DV-171) from the environment, `.env.local`, `.env`, or `--url` / `--admin-key` / `--env-file`, for `deploy`, `env` and `run`. |

### 13. Codegen (`convex/_generated`)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `api.d.ts` / `api.js`: `api`, `internal`, `components` (runtime `anyApi`) | `npm/convex/cli/codegen_templates/api.ts` | done (STUDY-36) | Dynamic mode: one `import type` per module (Convex's keys and identifiers), `FilterApi<ApiFromModules<…>>`; the initial pass writes an `AnyApi` stub. `components` is `{}` (DV-174). The layout is the generator's own (DV-175). |
| `dataModel.d.ts`: `Doc<T>`, `Id<T>`, `TableNames`, `DataModel` | `codegen_templates/dataModel.ts` | done (STUDY-36) | Dynamic mode, from `typeof schema`; `AnyDataModel` and `Doc = any` when there is no schema. Static mode is missing. |
| `server.d.ts` / `server.js`: typed `query`, `mutation`, `action`, `internal*`, `httpAction`, ctx types | `codegen_templates/server.ts` | done (STUDY-36) | The `*Generic` builders typed with `DataModel`; `QueryCtx` … `DatabaseWriter`. `env` is untyped (DV-176). |
| `component.ts` (ComponentApi) and component-level codegen | `codegen_templates/component_api.ts` | missing | |
| `convex.json` codegen options (`staticApi`, `staticDataModel`, `fileType`, `generateCommonJSApi`, `legacyComponentApi`) | `cli/lib/config.ts`; `schemas/convex.schema.json` | partial (STUDY-36) | `bunvex.json`'s `codegen.fileType` (`"ts"` or `"js/dts"`); the others are missing. |
| Other `convex.json` keys: `functions` dir, `node.externalPackages`, `node.nodeVersion`, `bundler.includeSourcesContent`, `typescriptCompiler` | same | missing | |

### 14. Deploy / push flow

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Bundling functions with esbuild (ESM, splitting, source maps, wasm, `server-only` stub) | `npm/convex/bundler/*` | partial (STUDY-35) | `Bun.build`: Convex's entry-point rules, ESM, splitting into `_deps/` chunks, external source maps, `NODE_ENV` production, `bunvex/*` external, `"use node"` files apart (`_deps/node/`), `schema.js` and `auth.config.js` on their own. Builtins in a non-`"use node"` file are refused by the server (Bun's browser target would shim them). No wasm or `server-only` stub. |
| Push protocol: `start_push`, `evaluate_push`, `wait_for_schema`, `finish_push`, `report_push_completed` | `cli/lib/deploy2.ts`; `crates/local_backend/deploy_config2.rs`; `crates/application/deploy_config.rs` | done (STUDY-35) | `/api/deploy2/*` with the `Deploy` operation, the admin key in the header or the body; Convex's request and response shapes for the root app (no components: `ComponentsNotSupported`); the schema and `auth.config.js` from the push (auth evaluated with the server's environment until deployment env vars, owner 2026-10-02); code rows and crons in the schema push's commit; `RaceDetected` for an older push or one lost on a restart. Deployable servers only (`NotDeployable`). |
| Module analysis (functions, visibility, arg and return validators, http routes, crons) | `crates/isolate/environment/analyze.rs` | done (STUDY-35) | `CodeVersion.load`: each module in a `vm` context (DV-164), analyzed into Convex's `AnalyzedModule` (`udfType`, `visibility`, `args`/`returns` validator JSON, `httpRoutes`, `cronSpecs`); `http.js` / `crons.js` default exports and cron targets checked with Convex's messages; `"use node"` files may define only actions (DV-169). Reached by a push in PR 3. |
| Storing modules and source packages (`_modules`, `_source_packages`, `_udf_config`) | `crates/model/modules`, `source_packages`, `udf_config` | done (STUDY-35) | Convex's rows; the package is one gzip JSON blob (DV-166) in the `modules` use case of the blob store (`<STORAGE_DIR>/modules`, `S3_STORAGE_MODULES_BUCKET`), apart from user files; `_udf_config` keeps the import-phase seed and time; a deployable server loads the latest version on start; unused packages are deleted. |
| Skipping unchanged modules (`get_config_hashes`) | `/api/get_config_hashes` | done (STUDY-35) | `{ moduleHashes: [{ path, hash, environment }] }`; unchanged modules are taken from the stored package, with Convex's 409s (`MissingExistingModule`, `ExistingModuleHashConflict`, `ExistingModuleEnvConflict`). |
| Schema push: diff indexes, add pending indexes, enable on finish | `crates/database/bootstrap_model/index.rs` | done (STUDY-35) | `Engine.startSchemaPush` (tables created, indexes backfilling, the schema `pending` in `_schemas`, an older pending one `overwritten`), `schemaPushStatus` (Convex\'s `wait_for_schema` states), `commitSchemaPush` (enable, disable staged, drop, `active`, and the push\'s own writes in ONE commit; validators switch then). A deployable engine restarts on its active schema (`storedSchema`). The endpoints come in the next PR. |
| Schema validation of existing documents on push (Pending, Validated, Active, Failed) | `crates/application/schema_worker`; `crates/common/schemas` | done (STUDY-35) | Convex's states in `_schemas`; the walk covers the tables whose validator changed (or whose validation was off), and its first failure is `Document with ID "…" in table "…" does not match the schema: …`; a write while the schema is pending lands but fails it, as Convex's `enforce`; `finish_push` needs `validated`. No shape inference to skip walks. |
| `schemaValidation: false`, `strictTableNameTypes` | `npm/convex/server/schema.ts` | done (STUDY-14, STUDY-36) | `defineSchema(tables, { schemaValidation, strictTableNameTypes })` (`core/src/schema.ts`): validation off skips document checks; the option shapes the generated data model's types. |
| Large-backfill guard (100k docs) and `staged` indexes | `cli/lib/checkForLargeIndexBackfill.ts` | partial | Staged indexes are built (STUDY-29, #115). The CLI's large-backfill guard (`--skip-large-indexes-check`) is not. |
| Push limits: 200 MB request, 4096 modules, 90 MB zipped / 230 MB unzipped | knobs `MAX_PUSH_BYTES` etc. | partial (STUDY-35) | 4096 modules checked at load; the byte limits come with the push endpoints. |
| Analyze timeout 4 s | `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS` | done (STUDY-35) | `SourceTextModule.evaluate({ timeout })`. |

### 15. Indexes, backfill, table metadata

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| System indexes `by_id` and `by_creation_time` on every table | `crates/common/bootstrap_model/index` | done | `packages/core/src/schema.ts`. |
| Declared database indexes (up to 16 fields) | `crates/common/schemas` | partial | Declared in code via `Schema.table()`; no `defineSchema` / `defineTable().index()` API and no field-count limit. |
| Index backfill over existing data | `crates/database/database_index_workers`; `_index_backfills` | done (STUDY-29) | In the background, as Convex: `init()` does not wait; a worker in the process holding the lease fills new indexes in rate-limited chunks (Convex's knobs: 1024 entries, 16 chunks/s, reads of 500, 8 tables at once) while every write maintains them, checkpoints in `_index_backfills` every second and resumes from there after a crash. `engine.indexesReady()` is Convex's `wait_for_schema`. Chunks are OCC-validated commits rather than writes at each document's ts (**divergence, owner 2026-10-01, DV-127:** until `prev_ts` (DV-66) exists). |
| Index states Backfilling, Backfilled, Enabled; staged indexes | `crates/common/bootstrap_model/index/database_index/index_state.rs` | done (STUDY-29) | `backfilling` → `backfilled` → `enabled`; `.index(name, { fields, staged: true })`; Convex's `IndexBackfillingError` / `IndexStagedError`; a changed index serves its old version until the new one is enabled. No push gate yet: code runs while its indexes backfill (**divergence, owner 2026-10-01, DV-126:** revisit with `bunvex deploy`). |
| Index/table limits: 64 indexes per table (docs say 32), 10 000 tables, names up to 64 chars | `crates/common/schemas/mod.rs`; `database/bootstrap_model/table.rs` | missing | |
| `_tables` (Active, Hidden, Deleting) and `_index` metadata tables | `crates/common/bootstrap_model/tables.rs`, `index/mod.rs` | done (#6, STUDY-42) | `_tables` states `active` / `hidden` / `deleting`: a hidden table is invisible to functions and may share an active table's name and number (`createHiddenTable`, with a chosen number and copied indexes); `activateTables` makes hidden tables active and the ones they replace `deleting` in one commit. Every transaction that uses a table reads its `_tables` document, so an activation conflicts with mutations that wrote the old table and invalidates queries that read it (measured: within noise). |
| Deleting tables and clearing tables (dashboard / API) | `/api/delete_tables`; `system-udfs clearTablePage.ts` | partial | `POST /api/delete_tables {tableNames, componentId}` (WriteData), as Convex's: the tables deleted in one commit (their documents removed in the background, STUDY-42), a missing one skipped, a system table an internal error, a table the active schema declares or points to with `v.id` refused (`SchemaEnforcementError`, Convex's messages), a pending schema that uses one failed; the `delete_tables` audit-log entry in the same commit (STUDY-48). Clearing (`_system/frontend/clearTablePage`) comes with the dashboard's data source (item 12). |
| Table size and shape (`/api/shapes2`, `tableSize`) | `crates/shape_inference`; `system-udfs/_system/frontend/tableSize.ts` | missing | |

### 16. Retention / GC

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Index retention: delete expired index entries older than `INDEX_RETENTION_DELAY` (4 min) | `crates/database/retention.rs` `go_delete_indexes` | done (STUDY-33) | `Retention` in `@bunvex/core`, in the lease holder. It reads the index log (C11) rather than revision pairs (DV-154); chunks of 512, 10 000 a pass. Measured: a hot range rewritten 100 times scans 10–15× faster once pruned. |
| Document retention: delete old document revisions after `DOCUMENT_RETENTION_DELAY` (14 d; docker-compose sets 2 d) | `retention.rs` `expired_documents` | done (STUDY-33) | Over the document log (PERSIST-01 C12, DV-155); 14 days by default (DV-157), `DOCUMENT_RETENTION_DELAY` in seconds. |
| Reads below the minimum snapshot timestamp fail (snapshot invalid) | `retention.rs` `validate_snapshot` | done (STUDY-33) | Checked before and after every store read: `OutOfRetentionError`, "Index snapshot timestamp out of leader retention window: {ts} < {min}" (HTTP 503, close 1013). |
| Purging deleted tables | `retention.rs` `delete_documents_in_tablets` | done (STUDY-42) | A `deleting` table is emptied by a background worker in batches of 1000 ordinary deletes (retention then removes their history), then its `_index` and `_tables` documents; resumed after a restart. Convex purges a deleted tablet's documents directly. |
| Checkpointing and rate limits (`RETENTION_*` knobs) | `knobs.rs:667-822` | done (STUDY-33) | Convex's defaults: windows advanced every 30 s and recorded first (`min_snapshot_ts`, `document_min_snapshot_ts`), cursors checkpointed every 300 s, 256 documents/s, backoff 50 ms to 60 s. |
| System table cleanup: scheduled jobs (7 d), sessions (2 w), expired exports (30 d), import age (7 d) | `crates/application/system_table_cleanup` | partial | Sessions' requests (`session-cleanup.ts`); expired exports and their ZIPs 30 days past expiration (STUDY-42); hidden tables older than twice the import age (14 d), a crashed import's, every 30 minutes, at most 1000 a run (`Engine.dropStaleHiddenTables`, STUDY-42). An import older than 7 days fails ("Import took too long. Try again."). As Convex, `_snapshot_imports` rows and their uploads are not deleted. |

### 17. System tables (complete list)

The first 18 rows are the tables an app can see or depend on. The last row groups internal bookkeeping tables. bunvex has none of them.

| Table | Convex source | bunvex status | Notes |
|---|---|---|---|
| `_storage` (virtual) / `_file_storage` | `crates/model/file_storage` | done (STUDY-32) | One table, `_storage`, holding Convex's public fields and the hidden ones (UUID, blob key); apps read the public ones through `db.system`. Since #216 it has Convex's number (540). |
| `_scheduled_functions` (virtual) / `_scheduled_jobs` / `_scheduled_job_args` | `crates/model/scheduled_jobs` | done (STUDY-30) | One table, `_scheduled_functions`, with the arguments inside (Convex splits them into `_scheduled_job_args`); apps read it through `db.system`; the dashboard's queries give Convex's `_scheduled_jobs` shape. |
| `_cron_jobs`, `_cron_next_run`, `_cron_job_logs` | `crates/model/cron_jobs` | missing | |
| `_tables`, `_index`, `_index_backfills`, `_index_worker_metadata` | `crates/common/bootstrap_model`; `crates/database/bootstrap_model` | partial (#6) | `_tables` and `_index` exist; the other two do not. |
| `_schemas`, `_schema_validations`, `_schema_validation_progress` | `crates/database/bootstrap_model/schema` | partial | `_schemas` with Convex's states (STUDY-35). The validation progress tables are not kept: a pending schema's walk reports its progress in memory. |
| `_modules`, `_source_packages`, `_udf_config`, `_external_deps_packages` | `crates/model/modules` etc. | partial | `_modules`, `_source_packages`, `_udf_config` as Convex's (STUDY-35). No `_external_deps_packages` (Node actions, Phase 4). |
| `_auth` | `crates/model/auth` | missing | |
| `_environment_variables` | `crates/model/environment_variables` | done (STUDY-37) | `{ name, value }`, indexed `by_name`, as Convex's. |
| `_components`, `_component_definitions`, `_function_handles` | `crates/model/components` | missing | |
| `_session_requests` | `crates/model/session_requests` | done (STUDY-23) | Mutation idempotency per (session, request seq). This is the sync layer's exactly-once guarantee, listed here for completeness. |
| `_exports`, `_snapshot_imports` | `crates/model/exports`, `snapshot_imports` | done (STUDY-42) | Convex's fields, states and indexes (timestamps in ns); `_snapshot_imports` also keeps the upload's size (`object_size`, not returned by `queryImport`). |
| `_log_sinks` | `crates/model/log_sinks` | missing | |
| `_deployment_audit_log`, `_audit_log_config` | `crates/model/deployment_audit_log`, `audit_log_config` | partial (STUDY-48) | `_deployment_audit_log` done; `_audit_log_config` (custom audit logs) missing. |
| `_backend_state` | `crates/model/backend_state` | missing | Running, paused or disabled; also the usage-limit stop state. |
| `_canonical_urls` | `crates/model/canonical_urls` | missing | |
| `_db` (database globals: version, storage type, S3 prefix) | `crates/model/database_globals` | missing | |
| `_usage_limits` | `crates/model/usage_limits` | missing | Usage caps; also exposed via `/api/v1`. |
| `_data_sync_progress` | `crates/model/data_sync_progress` | missing | Streaming export / Fivetran. |
| `_backend_info`, `_aws_lambda_versions`, `_next_persistence_index_id` | `crates/model/*` | missing | Internal bookkeeping (cloud entitlements, Lambda, id allocation); `_backend_info` can be skipped. |

### 18. Import / export / backups

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Snapshot export ZIP: `README.md`, `_tables/documents.jsonl`, `<table>/documents.jsonl`, `<table>/generated_schema.jsonl`, `_storage/documents.jsonl` + blobs, `_components/<name>/…` | `crates/exports`; `crates/application/exports/worker.rs` | done (STUDY-42) | Convex's layout and order (README, `_tables`, each table smallest first with `generated_schema.jsonl` `"uniform"`, `_storage` metadata then files named by id with a guessed extension), deflated, 0644, 1980 timestamps, ZIP64 when needed; documents in `_id` order in the lossless encoding (int64 integers, floats always with a point in ryu's form, `$float`, `$bytes`, keys in byte order); one snapshot. README in bunvex's words (DV-216); root only (DV-215). |
| Export API: `/api/export/request/zip?includeStorage=`, `/zip/{id}`, token, `set_expiration`, cancel | `crates/local_backend/router.rs` | done (STUDY-42) | `request/zip` (CreateBackups), `zip/{id or ts}` (DownloadBackups or a 5-minute token; Convex's headers and errors), `zip/{id}/token`, `set_expiration` (DeleteBackups; ≤ 60 days), `cancel` (ImportBackups, as Convex), `_system/cli/exports:getLatest` (ViewBackups); one export at a time; 14-day expiration, cleanup 30 days later; the `exports` blob store use case (`S3_STORAGE_EXPORTS_BUCKET`). Audit-log entries as Convex's (STUDY-48, DV-218 resolved). |
| Snapshot import: CSV, JSONL, JSON array, ZIP | `crates/application/snapshot_import/*` | done (STUDY-42) | Convex's value rules (CSV floats by Rust's `f64` grammar else strings; JSON numbers float64, `$` keys refused; ZIP tables in the lossless encoding when `"uniform"`), its messages ("Hit an error while importing:" …) and limits (JSON array 16 MiB); ZIPs read by byte ranges (ZIP64, CRC checked); `_tables`, `_storage` and its files restored; other system tables skipped. Components refused (DV-215); legacy encoding only for empty tables (DV-219); the JSON parser's wording (DV-222). The dashboard imports all four on the mock (UI-01 §19.2). |
| Import modes RequireEmpty (default), Append, Replace, ReplaceAll; confirmation step | `snapshot_import/mod.rs`; `_snapshot_imports` states | done (STUDY-42) | `_snapshot_imports` with Convex's fields, states and transitions, checkpoints and the `table \| create \| delete` summary (manual confirmation when anything is deleted); each table written into a hidden table and all activated in one commit (an append writes the live table, as Convex); schema checked with the import's tables, `ImportForeignKey`, schema-changed check; a failed or canceled import leaves nothing. A system error is retried with Convex's backoff (5 times) and an interrupted import resumes from its hidden tables (DV-220, DV-221 resolved). The dashboard offers the modes on the mock (UI-01 §19.2). |
| Resumable upload (`start_upload`, `upload_part`, `finish_upload`, `perform_import`, `cancel_import`) | `/api/import/*` | done (STUDY-42) | Also the one-shot `/api/import`; ImportBackups; parts in the `snapshot_imports` blob store use case (`S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET`), each part token signed for its upload; Convex's argument errors; `_system/cli/queryImport` and `:list` (ViewBackups). |
| Shape inference / generated schema | `crates/shape_inference` | missing | Also used by the dashboard's "generate schema". |
| Preserving `_id` and `_creationTime` on import | `snapshot_import` | done (STUDY-42) | An `_id` of the table's number kept (else Convex's `ImportConflict`), a float `_creationTime` kept; table numbers from `_tables`, the first `_id` or the existing table, with Convex's conflict checks; duplicate ids in a batch refused. |
| Periodic cloud backups and restore | `dashboard/…/Backups.tsx` | missing | Cloud-only; self-hosted uses export/import. Can be skipped. |
| Upgrade path via export and `import --replace-all` | `self-hosted/advanced/upgrading.md` | missing | |

### 19. Streaming export / import (Fivetran, Airbyte)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `list_snapshot` and `document_deltas` (paged snapshot plus change feed) | `crates/local_backend/streaming_export.rs`; `crates/application/streaming_export.rs` | missing | bunvex's versioned log makes deltas natural; the by-ts log read exists on `indexes` (PERSIST-01 C11), the documents side does not yet. |
| `json_schemas`, `get_table_column_names`, `test_streaming_export_connection` | same | missing | |
| Data-sync v1 API (`/api/v1/data/sync…`, protobuf cursor) | `crates/streaming_export`; `crates/pb_data_sync` | missing | |
| Fivetran source/destination connectors | `crates/fivetran_source`, `fivetran_destination` | missing | Separate programs; low priority. |
| Streaming import (`/api/streaming_import/*`: Airbyte records, Fivetran operations, primary-key indexes) | `crates/application/airbyte_import.rs`; `crates/model/fivetran_import` | missing | |

### 20. Logs, log streaming, metrics, usage

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Capturing `console.*` from functions (up to 256 lines, 32 KiB per line; docs say 4 KiB) | `crates/isolate/environment/helpers`; `crates/common/log_lines.rs` | done (STUDY-20) | Also still printed to the server's stdout. |
| Returning log lines to the client (dev console) and `REDACT_LOGS_TO_CLIENT` | sync protocol `logLines`; `local_backend/config.rs` | done (STUDY-20, STUDY-23) | HTTP (cache hits too, DV-74), sync v1 queries, mutations and actions; `REDACT_LOGS_TO_CLIENT` enables on any non-empty value, as Convex (DV-79). |
| Function execution log (per call: type, path, duration, error, cache hit, usage) | `crates/application/function_log.rs` | missing | |
| `GET /api/stream_function_logs?cursor=` and `/api/stream_udf_execution` | `crates/local_backend/logs.rs` | missing | |
| Log sinks: Datadog, Axiom, Webhook, Sentry, PostHog, S3 export, local file (`--local-log-sink`) | `crates/log_streaming/sinks/*`; `crates/model/log_sinks` | missing | Event formats V1 and V2. Topics: console, function_execution, audit_log, scheduler_stats, and others. |
| Log stream API (`/api/v1/*_log_stream*`) | `crates/local_backend/log_sinks.rs` | missing | |
| App metrics API (`/api/app_metrics/*`: udf_rate, failure %, cache hit %, latency percentiles, scheduled_job_lag, concurrency) | `crates/udf_metrics`; `local_backend` | missing | 1-minute buckets, 1-hour retention. Backs the dashboard's Health page. |
| Prometheus `/metrics` (`DISABLE_METRICS_ENDPOINT`) | `crates/metrics`; `common/http/mod.rs` | partial | bunvex has `/stats` JSON (cache hits, retries, conflicts, subscriptions) but no Prometheus. ARCHITECTURE marks it D. |
| Usage tracking (function calls, database/storage/vector bandwidth, storage gauges) | `crates/usage_tracking`; `crates/events/usage.rs`; `usage_gauges_tracking_worker` | missing | |
| Usage limits (caps by metric and window, which can stop the deployment) | `crates/usage_limits`; `/api/v1/*usage_limit*` | missing | Newer feature. |
| Insights (OCC and limit warnings) | `cli/lib/insights.ts` | missing | Cloud-only (Big Brain); can be skipped. |
| Warning at 80 % of a limit | knob `FUNCTION_LIMIT_WARNING_RATIO` | missing | |

### 21. Dashboard

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Self-hosted dashboard app (Next.js, `NEXT_PUBLIC_DEPLOYMENT_URL`, admin-key login) | `npm-packages/dashboard-self-hosted`; `dashboard-common` | partial | bunvex's own: `@bunvex/dashboard` behind a `DashboardDataSource`, hosted by `apps/dashboard` (Vite) — on a mock until the server's admin API exists; no admin-key login yet. Reusing Convex's dashboard was considered: the repository is FSL-1.1-Apache-2.0 (Apache only two years after each release) and it needs ~40 system UDFs plus HTTP routes (STUDY-12 D1). |
| Health (failure rate, cache hit, calls, concurrency, invalidations) | `dashboard-common/features/health` | partial | Built on the mock (STUDY-12 §12, UI-01 §18.1): function calls, failure rate and cache hit rate (top 5 and the rest) and scheduler lag over the last hour, beside the engine's counters. Missing: concurrency (running / queued functions), subscription invalidations, the heatmap view (M2); the server's metrics. |
| Data browser (filters, index selection, edit/add/delete documents, clear table, create table, generate schema) | `features/data`; `system-udfs/_system/frontend/*` | partial | Built on the mock (STUDY-12, UI-01 §12): index + field filters, live documents and counts, in-place editing, add / delete / clear, column layout, the cell context menu and shortcuts, complete (view value, go to reference, delete document). create table (UI-01 §15.4), a generated schema (§15.5). A table's metrics (rows read and written, UI-01 §18.3, on the mock). Missing: custom query; the server's admin API (Convex's relies on about 40 system UDFs, `_system/frontend/*`, `_system/cli/*`). Divergences decided (STUDY-12 §4), D13 included (a menu delete asks first, behind a flag). Layout: the grid fills the screen, the document panel is docked and follows the current row (UI-01 §22.1, §22.3). |
| Schema view, Functions (tree, perf graphs, function runner with identity) | `features/functions`, `functionRunner` | partial | The Functions screen is built on the mock (STUDY-12 §7, UI-01 §13.2): the module tree with search, a function's kind, visibility, path and logs; the function runner (UI-01 §13.3: arguments as literals, value or error, the run's log lines; a query stays subscribed and updates live, §16.1; run history, §16.2; acting as a user, §16.3); declared argument and return validators shown, and the runner's template and live argument checks from them (UI-01 §15.1). Its Statistics tab (calls, errors, execution time percentiles, cache hit rate; UI-01 §18.2, on the mock). Missing: custom test queries. The **Schema screen** draws the schema as Convex's does (UI-01 §21: tables and their `v.id` references, groups, search, minimap, a table's fields and indexes), on the mock. |
| Files (upload, delete, preview) | `features/files` | partial | The Files screen is built on the mock (STUDY-12 §9, UI-01 §14.3): stored files newest or oldest first, a day range, lookup by storage id, upload, select and delete, a file's metadata with an image preview, Download. The section column (UI-01 §24): upload, storage used, views by type, upload-date and size filters, and a "Buckets" section holding only "Default" (a placeholder for a bunvex addition). The contract methods are optional. The contract follows Convex's `fileStorageV2`: a malformed storage id is `invalid_request`, and deleting several files is all or nothing. The server has the system functions (§3); missing: reaching them from the dashboard (admin keys). |
| Schedules (scheduled functions, cancel; crons with history) | `features/schedules` | partial | The Schedules screen is built on the mock (STUDY-12 §9, UI-01 §14.2): scheduled runs nearest first with a function filter, a run's details and arguments, Cancel and Cancel all; cron jobs with schedule, last and next run, and recent runs. Scheduled functions and Cron jobs are reached from the section column, with the scheduled filters under it (UI-01 §23.3). The contract methods are optional. Missing: the server's scheduler and its admin API (see §4 of this file), a component picker. |
| Logs (call tree, search), History (audit log) | `features/logs`, `history` | partial | The Logs screen is built on the mock (STUDY-12 §7, UI-01 §13.1, its layout redesigned in §22.4): live lines newest first, pause, clear, client-side filters by time range or a brushed window, function, type, kind and text in a filter column with counts, in the URL and kept per deployment (STUDY-12 L7, L10–L11), a log-volume histogram (L12), JSON Lines export (L13), a line's details with its request, and the call tree (UI-01 §15.6). Deployment events among the lines (UI-01 §16.4). Usage and identity in the details (UI-01 §16.5). Missing: the server's log stream. The History screen (audit log) is built on the mock too (STUDY-12 §9, UI-01 §14.5): events newest first in words, by action and day range, live; the server records none yet. |
| Settings: pause deployment, env vars, usage limits, auth config, components, integrations (log sinks) | `features/settings` | partial | Settings → General shows the deployment's name, version, persistence and URLs (UI-01 §17.1), and pauses / resumes it with a banner on every screen while paused (§17.2, on the mock; the server has no pause yet). Environment variables are built on the mock (STUDY-12 §9, UI-01 §14.4): values hidden until shown, copy one or all as `.env`, add / edit / rename / delete saved as one batch with Convex's limits, a pasted `.env` file becomes rows. The server has no per-deployment variables yet (§10). Snapshots export the tables (and files) as a zip and import a zip or a table's file, a bunvex addition (STUDY-12 §13.2, UI-01 §19.2, on the mock). Authentication — the configured providers — moved to the Authentication screen's "Sign in / Providers" (UI-01 §25.3; first built as Settings → Authentication, §19.1; the server does not expose `_auth` yet). The other settings pages are missing; backups and custom domains are disabled on self-hosted. |

bunvex additions to the dashboard, with no Convex counterpart (STUDY-12 §13.2, §15, §7.7, §7.8, §21): snapshot
export and import in Settings, **who the clients are** (platform, SDK, app and version per connection, an
optional app registry and an SDK policy, on the mock — on Topology, the Overview, Logs, a function's
Statistics, Settings → Apps, Auth sessions, Analytics and flag targeting; Convex sends only `Convex-Client: npm-<version>`; UI-01 §33), the **Topology** screen (UI-01 §22), the Files "Buckets" placeholder
(§24), the **Authentication** screen (users, sessions, organizations and auth configuration, after
better-auth's concepts; §25), **Analytics** (live visitors on a map, events, sessions and profiles — an
extension, UI-01 §26.2, STUDY-12 §16) and **Workflows** (durable workflow runs as a diagram, timeline and
journal, with cancel / rerun / restart from a step, and work pools — an extension, UI-01 §26.3, STUDY-12
§17). All on the mock.

### 22. Deployment state, health, self-hosted configuration

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `GET /version`, `/instance_version`, `/instance_name`, `/`, `POST /echo` | `crates/local_backend/router.rs`; `crates/health_check` | partial | bunvex has `/version`, which returns "bunvex", and `/instance_name` (STUDY-34). docker-compose's healthcheck is `curl /version`. |
| Pause / unpause deployment (`_backend_state`, `/api/v1/pause_deployment`) | `crates/model/backend_state` | missing | A paused deployment rejects functions and stops the scheduler and crons. |
| Backend flags: `--port` 3210, `--site-proxy-port` 3211, `--interface`, `--convex-origin`, `--convex-site`, `--instance-name`, `--instance-secret`, `--local-storage`, `--s3-storage`, `--do-not-require-ssl`, `--disable-beacon`, `--redact-logs-to-client`, `--local-log-sink`, `--convex-http-proxy` | `crates/local_backend/config.rs` | done (STUDY-40) | `bunvex-local-backend` (DV-197): `<db_spec>`, `--db sqlite\|postgres\|mysql\|mongodb`, `--port` 3210, `--site-proxy-port` 3211, `--interface`, `--cloud-origin` / `--site-origin` (for `--convex-origin` / `--convex-site`), `--instance-name` (default `bunvex-self-hosted`) / `--instance-secret` (required), `--local-storage` / `--s3-storage`, `--do-not-require-ssl`, `--redact-logs-to-client`, `keygen admin-key`. No `--disable-beacon` (no beacon), `--convex-http-proxy` or `--local-log-sink`. |
| Database selection: SQLite by default, `POSTGRES_URL`, `MYSQL_URL`, `DATABASE_URL`; database name derived from the instance name | `self-hosted/docker-build/run_backend.sh`; `crates/postgres`, `mysql`, `sqlite` | done | bunvex covers the same stores plus memory and MongoDB, with its own env names (`PERSISTENCE`, `PERSISTENCE_URL`); its default store is memory, not SQLite. Convex's names are accepted as aliases with Convex's precedence; bunvex's win when both are set (DV-88, STUDY-25 §3.7). TLS as Convex: required and verified, `DO_NOT_REQUIRE_SSL` lifts it, `PG_CA_FILE` / `MYSQL_CA_FILE`; Postgres `target_session_attrs=read-write`; a read-only MySQL refused at open (DV-109; Convex re-checks MySQL on every new connection). MongoDB's TLS is its URL's. **Divergence (DV-110):** the database is the one the URL names, not derived from the instance name; a URL without one is refused at start (confirmed by the owner, 2026-10-01). |
| Single writer per database: the persistence lease (`leases` table; the newest process wins at once, the loser exits on its next write with `LeaseLostError`; `SELECT … FOR SHARE` before COMMIT fences writes) | `crates/postgres/src/lib.rs:1745-1893`, `sql.rs:721-755`; `crates/mysql/src/v6/persistence.rs` (SQLite: none) | partial | PERSIST-01 C7 (STUDY-24 H8): Postgres and MySQL have it; SQLite and memory+log hold an exclusive OS lock for the process's life — **a deliberate divergence: Convex's SQLite has no lock and loses writes with two processes** (STUDY-25 L9, owner 2026-09-30); MongoDB has it as a transaction per flush on a replica set (owner 2026-09-30; Convex has no MongoDB driver). **Divergence (owner, 2026-09-30, STUDY-24 H5):** bunvex's lease has a TTL on the store's clock and a graceful release, and a live lease is never taken — a second process fails to open with `LeaseHeldError` (or waits, with `lease.waitMs`), where Convex's newest process wins at once. The fence is an epoch checked inside each flush's first statement (Postgres: a data-modifying CTE, no extra round trip; MySQL: a first `UPDATE`, one round trip). |
| Client-side timeouts on database calls: Postgres 30 s (`POSTGRES_TIMEOUT_SECONDS`), MySQL 19 s (`MYSQL_TIMEOUT_SECONDS`), per round trip (connection, statement, BEGIN, COMMIT); a timed-out connection is never reused | `crates/postgres/src/connection.rs:108-135, 209-220`; `crates/mysql/src/connection.rs:143-153, 280-318`; `crates/common/src/knobs.rs:1197` | done | As Convex (STUDY-25 L3, PERSIST-01 C8, conformance K20), same defaults and env names; MongoDB 30 s (`MONGODB_TIMEOUT_SECONDS`, no Convex counterpart). **Divergence (DV-122, owner 2026-10-01):** Postgres retires its whole pool on a timeout, and before the retry after a lost connection (postgres.js exposes no single connection). Lease renewals are bounded by TTL/4 (bunvex's lease, DV-14). Retries after a transient error: next row. |
| Retries of transient database errors: commit writes retried with full-jitter backoff 100 ms → 10 s, no limit (`INITIAL_/MAX_PERSISTENCE_WRITES_BACKOFF_MS`); an ambiguous commit stops the committer ("Unsure if transaction committed to disk"); reads and init retried once on a fresh connection (Postgres after a lost connection or a timeout, MySQL after an operational error, `MYSQL_MAX_QUERY_RETRIES` = 1) | `crates/database/src/write_batcher.rs:205-246`, `committer.rs:440`; `crates/common/src/errors.rs:855-859`; `crates/postgres/src/connection.rs:209-264`, `lib.rs:1822-1846`; `crates/mysql/src/connection.rs:88-118, 280-318`; `knobs.rs:1245, 2083-2091` | done | As Convex (STUDY-25 L4/L5, PERSIST-01 C9, conformance K21), with Convex's per-driver classification, except two decided divergences (owner, 2026-10-01): **DV-123**, on Postgres a connection lost inside a flush is transient too (as on MySQL; Convex: only timeouts); **DV-124**, a retried group that already landed is acknowledged instead of stopping the process (the driver reads the lease record first: our epoch with `max_ts` ≥ the group's top means it committed; same rule on Postgres, MySQL and MongoDB). MongoDB (no Convex counterpart) classifies as the MySQL list (owner-approved). The backoff knobs are `Engine` options (`flushRetry`); env vars come with Convex's env names (DV-88). bunvex's lease TTL bounds the retries in practice. |
| Bounded persistence writes: the committer's write batcher (whole commits per batch, soft caps 64 document rows / 64 KiB, `COMMITTER_MAX_WRITE_BATCH_*`; up to 16 batches in flight); drivers split a write into statements (Postgres 1 024 rows, MySQL 10 MiB per `INSERT`) | `crates/database/src/write_batcher.rs:86-250`, `committer.rs:278, 438-459`; `crates/common/src/knobs.rs:400-422, 1181-1184`; `crates/postgres/src/lib.rs:577-615`; `crates/mysql/src/chunks.rs:170-204` | done | As Convex (DV-62, STUDY-06 §10; conformance K26): same caps and statement chunking; the caps are the `Engine` option `writeBatch`. **Decided divergence (DV-152):** batches are flushed one at a time, not 16 in flight, so the durable state stays a prefix (PERSIST-01 C4). Not modelled: Convex's batching threshold (3 writes in flight) and 1 ms hold. |
| S3 env (`AWS_*`, `S3_ENDPOINT_URL`, `S3_STORAGE_{EXPORTS,SNAPSHOT_IMPORTS,MODULES,FILES,SEARCH}_BUCKET`, `AWS_S3_FORCE_PATH_STYLE`, `AWS_S3_DISABLE_SSE/CHECKSUMS`) | `crates/aws_s3`, `aws_utils` | missing | Planned `FILE_STORAGE=`. |
| Knob env overrides (every knob is an env var) | `crates/common/knobs.rs`; `self-hosted/advanced/knobs.md` | missing | |
| Docker image, docker-compose, credentials bootstrap (`read_credentials.sh`) | `self-hosted/docker*` | done (STUDY-38, STUDY-40) | `docker/Dockerfile`: the compiled `bunvex-local-backend` on `debian:bookworm-slim` (197 MB; DV-187, DV-198), with Convex's scripts: `read_credentials.sh` (the env, else the volume's files, else generated), `run_backend.sh` (the database from `POSTGRES_URL` / `MYSQL_URL` / `DATABASE_URL` / `PERSISTENCE`, else SQLite `db.sqlite3` in the volume; S3 per use case, DV-190), `generate_admin_key.sh` (`keygen admin-key`). `docker-compose.yml`: Convex's ports, volume, stop signal, healthcheck; bunvex's variables (DV-188, DV-192); no dashboard yet (DV-189). `docker/smoke.sh` runs the self-hosted flow end to end on SQLite and Postgres, in CI too. Published to `ghcr.io/bunvex/bunvex-backend` from `main` (DV-191). |
| Precompiled backend executable per platform (`convex-local-backend-<target>.zip` on GitHub Releases, `running_binary_directly.md`), the `precompile` / `promote` release workflows | `self-hosted/advanced/running_binary_directly.md`; `.github/workflows/precompile.yml`, `promote_local_backend.yml` | done (STUDY-39, STUDY-40) | `bunvex-local-backend` (DV-193, DV-197): Convex's flags and defaults (`<db_spec>`, `--db`, `--port` 3210, `--site-proxy-port` 3211, `--interface`, `--cloud-origin`/`--site-origin`, `--instance-name`/`--instance-secret` required, `--local-storage`/`--s3-storage`, `--do-not-require-ssl`, `--redact-logs-to-client`), `keygen admin-key`, `--version`; compiled for Convex's five targets with the database drivers inside (`scripts/build-binary.ts`, `bunvex-local-backend-<target>.zip`); `release-binaries.yml` (push to `release` → prerelease `precompiled-<date>-<sha7>`), `promote-binaries.yml`; `scripts/smoke-binary.sh` runs Convex's guide on Linux (SQLite, Postgres) and macOS in CI. No `dashboard.zip` (DV-194); Windows built, not run (DV-195). |
| SSRF proxy for action `fetch` and OIDC (`--convex-http-proxy`) | `crates/local_backend/config.rs` | missing | |
| Beacon / telemetry (hourly, `DISABLE_BEACON`), Sentry | `crates/local_backend/beacon.rs` | missing | **Divergence (owner, 2026-10-01, DV-89):** bunvex ships no beacon or telemetry. |
| In-place database migrations between versions (`migrations_model`) | `crates/migrations_model` | missing | **Not for now (owner, 2026-10-01, DV-56):** pre-alpha. The version story comes first, and is built (#114): next row. An older layout is refused until an upgrade exists. |
| Persistence layout version: chosen by configuration (V5/V6) and checked against the database (MySQL v5 refuses a non-V5 configuration; v6 refuses to initialize over a v5 or unversioned database, and checks its shared tables' columns) | `crates/common/src/types/mod.rs:175-197`; `crates/mysql/src/v5/persistence.rs:151-153`; `crates/mysql/src/v6/persistence.rs:207-271` | done | As Convex (STUDY-25 L6, PERSIST-01 C10, conformance K22; #114, DV-107 resolved). bunvex has one layout, so every store records it instead (`persistence_globals.layout_version`, MongoDB `meta`, the memory log's header) and every open checks it. A newer, unknown or older (no upgrade yet) version is refused with `LayoutError`, and so is a store that is not bunvex's (e.g. Convex's own tables), without being written to. A store written before this check opens as version 1 and gets its record under the lease. |
| `read_only` flag: a writer's open fails with "persistence is read-only, data migration in progress" unless `allow_read_only` (readers pass it); `set_read_only` needs no lease; Postgres and MySQL only | `crates/postgres/src/lib.rs:220-224, 330-334, 357-389`, `sql.rs:198-215, 681-715`; `crates/mysql/src/v6/persistence.rs:168-180`; `crates/db_connection/src/lib.rs:181-196, 238-262` | done | As Convex (STUDY-25 L7, PERSIST-01 C10, conformance K23; #114, DV-108 resolved): `ReadOnlyError` unless `allowReadOnly`; `setReadOnly(on)` on every driver. No CLI yet; import/export will use it. **Divergence (owner, 2026-10-01, DV-125):** also on SQLite and memory+log, where Convex has none. |
| Reading the commit log by timestamp (`load_documents` over a `TimestampRange`, bounded by the repeatable ts; Postgres pages `documents` by `(ts, table_id, id)`) | `crates/common/src/persistence/mod.rs:562`, `:774`; `crates/postgres/src/sql.rs:269` | partial | PERSIST-01 C11 (STUDY-24 H11, owner 2026-10-01): `readLog(afterTs, upToTs, limit)` on every driver reads **`indexes`** by ts (each commit's index write set, whole commits, a per-commit `prevTs` for gap detection, never above the durable prefix), with a ts index everywhere. Documents by ts and `prev_ts` (retention, export) are not built (DV-66). |
| OpenAPI specs (`/api/public_openapi.json`, `/api/dashboard_openapi.json`, `/api/v1/openapi.json`) | `crates/local_backend/router.rs` | missing | |

### 23. Public HTTP function API (non-sync)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action` `{path, args, format}` returning `{status, value, logLines}` | `crates/local_backend/public_api.rs` | partial | Since STUDY-20: `args` as an object or a one-element array, function errors as HTTP 200 `{status:"error", errorMessage, errorData?, logLines?}`, request errors as `{code, message}`, system failures as 500 (503 for `OutOfRetention`, STUDY-06 D10). Still no `format`, no auth header. |
| `GET /api/query`, `/api/query_ts`, `/api/query_at_ts`, `/api/query_batch`, `/api/function`, `/api/run/{fn}` | same | partial (STUDY-26) | `POST /api/query_ts` and `/api/query_at_ts` done; `POST /api/function` done (STUDY-37: any kind; internal ones for an admin; Convex's "Could not find function for …" otherwise); the others missing. |

### 24. Limits apps can hit (from `crates/common/knobs.rs` and hard constants)

bunvex enforces almost none of these. Matching them matters so an app that works on bunvex also works on Convex.

| Limit | Convex value (source) | bunvex status | Notes |
|---|---|---|---|
| Documents written per transaction | 16 000 (`TRANSACTION_MAX_NUM_USER_WRITES`) | missing | |
| Bytes written per transaction | 16 MiB (`TRANSACTION_MAX_USER_WRITE_SIZE_BYTES`) | missing | |
| Documents scanned per transaction | 32 000 (`TRANSACTION_MAX_READ_SIZE_ROWS`) | missing | |
| Bytes read per transaction | 16 MiB (`TRANSACTION_MAX_READ_SIZE_BYTES`) | missing | |
| Read-set intervals | 4096, warning at 3072 (`TRANSACTION_MAX_READ_SET_INTERVALS`) | missing | |
| Query / mutation user time | 1 s (`DATABASE_UDF_USER_TIMEOUT_SECONDS`); syscall time 15 s | missing | bunvex has no timeouts. |
| Action timeout | V8 1800 s (docs say 10 min for cloud); Node 600 s | missing | |
| Arguments / return value size | 16 MiB each (`FUNCTION_MAX_ARGS_SIZE`, `FUNCTION_MAX_RESULT_SIZE`) | missing | |
| Document size / nesting | 1 MiB / 16 (`crates/common/document.rs`) | missing | |
| Object fields / array length | 1024 / 8192 (`crates/value`) | missing | |
| Identifier length | 64 for fields, tables and indexes; 1024 for nested keys | missing | |
| Page size / query operators / index key prefix | 1024 / 256 / 2500 bytes | missing | |
| OCC retries (UDF executor) | 4, backoff 100 ms to 2 s (`UDF_EXECUTOR_OCC_MAX_RETRIES`) | done (STUDY-21) | Same budget and full-jitter backoff, plus the wait for the conflicting write. The knobs are `Engine` options. |
| Write-log retention (how old a mutation's snapshot may be at commit) | 30 s floor, 300 s, 50 MiB soft (`WRITE_LOG_MIN_RETENTION_SECS`, `WRITE_LOG_MAX_RETENTION_SECS`, `WRITE_LOG_SOFT_MAX_SIZE_BYTES`) | done (STUDY-06 D10) | Past it: `OutOfRetention`, HTTP 503 / close 1013, not retried as OCC. Knobs are the `Engine` option `writeLogRetention`. Divergence: a hard byte cap, 256 MiB by default (`hardMaxBytes`; `null`/`0` turns it off), DV-128 (owner, 2026-10-01). |
| Transaction begin window | 10 s (`MAX_TRANSACTION_WINDOW`) | done (STUDY-06 D10) | Only `/api/query_at_ts` begins in the past; further back answers 503. |
| Nested runQuery/runMutation depth | 8 (`MAX_REACTOR_CALL_DEPTH`) | missing | |
| Concurrency | queries 16, mutations 16, V8 actions 64, Node actions 64, uploads 4 (`APPLICATION_MAX_CONCURRENT_*`) | missing | Waiting for a slot times out after 5 s for queries/mutations and 10 s for actions. |
| Isolate heap | 64 MiB + 32 MiB, ArrayBuffers 64 MiB | missing | Tied to sandbox decision #3. |
| Write throughput | 4 MiB/s (`MAX_BYTES_WRITTEN_PER_SECOND`) | missing | |
| HTTP server | timeout 300 s, 1024 concurrent requests | missing | bunvex uses `idleTimeout` 120 s and an 8 MiB WebSocket payload limit. |
| Log lines | 256 per function, 32 KiB each | missing | |
| Scheduling / env vars / search / vector limits | see sections 4, 6, 7, 10 | missing | |

---

### Summary counts

| Status | Count |
|---|---|
| done | 4 |
| partial | 12 |
| missing | 224 |

- The four done rows are system indexes, database selection, the client-side timeouts on database calls and
  the retries of transient database errors.
- The twelve partial rows are: the persistence lease (PERSIST-01 C7: every driver), the log by timestamp (PERSIST-01 C11: on `indexes`), declared indexes, internal-function admin access, `process.env`, `/metrics` (via `/stats`), `/version` health, backend flags, the public HTTP function API, OCC retries (done since STUDY-21), the self-hosted dashboard app and the data browser.
- Everything else, including the system-table catalogue, is missing.

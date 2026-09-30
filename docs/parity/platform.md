## Platform features around the core (parity inventory)

Scope: everything a self-hosted Convex deployment provides beyond the function/database API and client sync.
Reference: Convex `convex-backend` at commit 4577b9031. Paths are relative to that repo; `crates/x` means `crates/x/src/…`, and `npm/convex` means `npm-packages/convex/src`.

**bunvex baseline** (from ARCHITECTURE.md and `packages/*`):
- `@bunvex/auth`, `@bunvex/file-storage`, `@bunvex/cli` and `@bunvex/testing` are empty stubs.
- `@bunvex/server` has:
  - query, mutation and action definitions, and internal functions;
  - `POST /api/{query,mutation,action}`, WebSocket `/ws`, `GET /version` and `GET /stats` (JSON);
  - `PERSISTENCE` / `PERSISTENCE_URL` / `DATA` / `DURABLE` / `POOL` configuration.
- `@bunvex/core` keeps every version with no GC. Its schema has the system indexes `by_id` and `by_creation_time` plus declared indexes, with no validators and no backfill.
- There are no system (`_`) tables, no ctx.auth, no ctx.storage and no ctx.scheduler.

Status legend: **done** · **partial** · **missing**. "Divergence?" in Notes marks where bunvex may deliberately differ; the owner has to decide those.

---

### 1. Authentication (end-user identity)

| Feature | Convex source (file/crate) | bunvex status | Notes |
|---|---|---|---|
| `auth.config.ts` with OIDC providers `{domain, applicationID}` | `npm/convex/server/authentication.ts`; `crates/common/auth.rs` (`AuthInfo::Oidc`) | missing | `@bunvex/auth` is an empty stub. The module name is `auth.config.js`. |
| Custom JWT provider `{type:"customJwt", issuer, jwks, algorithm RS256/ES256, applicationID?}` | `crates/common/auth.rs` (`AuthInfo::CustomJwt`) | missing | `jwks` may be a `data:` URL. The JWKS response must be `application/json` or `jwk-set+json`. |
| Evaluating the auth config in a sandbox on push | `crates/isolate/environment/auth_config.rs`; `crates/application/lib.rs` `get_evaluated_auth_config` | missing | No Date/random/syscalls/imports. `process.env` is allowed, and a missing variable is an error. Can't be combined with legacy `convex.json` `authInfo`. |
| `_auth` system table and auth diff on push | `crates/model/auth` | missing | The diff (added/removed providers) goes to the deploy audit log. |
| Re-evaluating the auth config when env vars change | `crates/application/lib.rs` `reevaluate_existing_auth_config` | missing | An env var change that would break the auth config is rejected. |
| OIDC discovery (`/.well-known/openid-configuration`) and JWKS fetch | `crates/authentication/lib.rs` `validate_id_token` | missing | OIDC accepts RS256 and EdDSA. Checks iss and aud; no nonce; multi-aud tokens rejected. |
| JWKS / discovery caching | `crates/http_client` (`CachedHttpClient`, knob `HTTP_CACHE_SIZE` 16 MiB) | missing | Follows HTTP Cache-Control headers; there is no dedicated JWKS cache. |
| Provider matching by `iss` / `aud` | `crates/common/auth.rs` `matches_token` | missing | Adds `https://` when there is no scheme, ignores trailing `/`, first match wins, `NoAuthProvider` if none. |
| Clock skew and required `exp` (custom JWT) | `crates/authentication/lib.rs` | missing | 5 s leeway. |
| `ctx.auth.getUserIdentity()` fields | `npm/convex/server/authentication.ts`; `crates/keybroker/broker.rs` `UserIdentity::from_token` | missing | `tokenIdentifier = "iss\|sub"`, `subject`, `issuer`, standard OIDC claims (name, email, pictureUrl, …) and custom claims. Nested custom claims are flattened to dotted keys. `jti`, `nbf` and `fva` are dropped so caching still works. |
| Identity expiry at JWT `exp` (sync session `TokenExpired`) | `crates/sync/state.rs` | missing | |
| Invalid token: null in queries and mutations, throw in actions | `crates/isolate/environment/action/task_executor.rs` | missing | A subtle behaviour that apps can observe. |
| WebSocket `Authenticate` message and `AuthError` reply | `crates/sync/worker.rs`; `sync_types/json.rs` | missing | Protocol v0 has no auth message. Identity versioning (`baseVersion`) is part of the protocol. |
| HTTP `Authorization: Bearer <jwt>` | `crates/local_backend/authentication.rs` | missing | |
| Client `setAuth(fetcher)` and refresh (leeway 10 s, force refresh after confirm, 2 retries) | `npm/convex/browser/sync/authentication_manager.ts` | missing | Belongs to the client, listed here because it drives the auth protocol. |
| Query cache keyed by identity | `crates/keybroker` `Identity::cache_key` | missing | The bunvex cache key is `path + args` only, so adding auth needs identity in the key. |
| Acting as a user (admin impersonation, `actingAs`) | `crates/application/lib.rs` `authenticate`; header `Convex <key>:<b64 identity>` | missing | Needs the `ActAsUser` operation. Used by `npx convex run --identity` and the dashboard runner. |
| Clerk / Auth0 / Convex Auth / WorkOS helpers | docs; `npm/convex` react-clerk, react-auth0; `crates/workos_client` | missing | ARCHITECTURE lists clerk and auth0 as D. They are only OIDC configurations plus client glue. |

### 2. Deployment auth, admin keys, operations

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Instance secret (32-byte hex), required at startup | `crates/keybroker/secret.rs`; `crates/local_backend/config.rs` | missing | Convex has no fallback: `--instance-secret` is required. Docker generates one and persists it. |
| Admin key format `instance_name\|encrypted proto` (AES-GCM-SIV, KBKDF) | `crates/keybroker/broker.rs` `issue_key`, `encryptor.rs` | missing | Keys never expire; they are revoked only by rotating the secret. Prefixes `prod:`, `dev:`, `preview:` and `project:` are stripped. |
| Generating an admin key (`generate_key`, `keygen admin-key`, `generate_admin_key.sh`) | `crates/keybroker/bin/generate_key.rs`; `self-hosted/docker-build/generate_admin_key.sh` | missing | |
| System keys (`Identity::System`) | `broker.rs` `issue_system_key` | missing | |
| Read-only admin keys and the `DeploymentOp` permission set | `crates/keybroker/operations.rs` | missing | Operations include Deploy, View/WriteEnvironmentVariables, ViewLogs, ViewData/WriteData, ActAsUser, RunInternal*, Backups*, UsageLimits*, and more. |
| Admin-only access to internal functions | `crates/udf/validation.rs` `check_visibility_access` | partial | bunvex has internal functions, callable only from actions. No caller can authenticate as admin to run them over HTTP. |
| `Authorization: Convex <adminKey>` header, `?adminKey=` | `crates/local_backend/authentication.rs` | missing | |
| `GET /api/check_admin_key` | `crates/local_backend/dashboard.rs` | missing | Returns `{success, allowedOps, isReadOnly}`. |
| Deploy and preview keys, team/OAuth tokens | `crates/authentication/application_auth.rs` (`AccessTokenAuth`) | missing | Self-hosted Convex uses `NullAccessTokenAuth`, so only admin keys work. The cloud-only token types can be skipped. |
| Action callback token (`Convex-Action-Callback-Token`) | `crates/local_backend/node_action_callbacks.rs` | missing | Only needed with an out-of-process Node executor. |
| Other signed tokens (upload, export download, cursor, data-sync cursor) | `crates/keybroker/encryptor.rs` purposes | missing | One key derivation per purpose from the instance secret. |
| Deployment audit log (`_deployment_audit_log`) | `crates/model/deployment_audit_log` | missing | Records env var changes, push config and index diffs, pause/unpause, clear/delete tables, snapshot import, cancel jobs, delete files, exports and integrations. |

### 3. File storage

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `ctx.storage.generateUploadUrl()` (mutations and actions) | `npm/convex/server/storage.ts`; `crates/file_storage/core.rs` | missing | Returns `{origin}/api/storage/upload?token=…`. The token is valid for 1 h, tied to its component, and must be issued within 15 s of the UDF timestamp. |
| `POST /api/storage/upload?token=` | `crates/local_backend/storage.rs` | missing | Streams the body and hashes it. Optional `Digest: sha-256=` must match. Returns `{storageId}`. No body cap; docs say 2 min timeout. |
| The `_storage` metadata row is written in its own transaction after the upload | `crates/file_storage` `store_entry` | missing | Avoids OCC conflicts. |
| `ctx.storage.getUrl(id)` | syscall `1.0/storageGetUrl` | missing | Returns `{origin}/api/storage/{uuid}[?component=]`, or null. |
| `GET /api/storage/{uuid}`: serving | `crates/local_backend/storage.rs`; `crates/file_storage/lib.rs` | missing | Headers: `Content-Type`, `Content-Length`, `Digest`, `Cache-Control: private, max-age=2592000`, `Accept-Ranges`. A single Range gives 206; multiple ranges give 416. |
| `ctx.storage.delete(id)` | `crates/model/file_storage` `delete_file` | missing | Transactional delete of the metadata row. Blobs are **never** garbage-collected in OSS, and old URLs return 404. |
| `ctx.storage.store(blob)` / `get(id)` (actions only) | `npm-packages/udf-runtime/src/storage.ts` | missing | `store` in queries and mutations is rejected with `StorageStoreNotImplemented`. |
| `ctx.storage.getMetadata` (deprecated) | syscall `1.0/storageGetMetadata` | missing | Replaced by `ctx.db.system.get("_storage", id)`. |
| `_storage` virtual table `{_id, _creationTime, sha256 (base64), size, contentType}` | `crates/model/file_storage/virtual_table.rs` | missing | Physical table `_file_storage` holds `storageId` (uuid), `storageKey`, `sha256`, `size` and `contentType`, with index `by_storage_id`. |
| `ctx.db.system.get/query` for virtual system tables | `npm/convex/server/database.ts` (system reader) | missing | Also needed for `_scheduled_functions`. |
| Storage id formats: `Id<"_storage">` and legacy UUID | `crates/model/file_storage/mod.rs` `FileStorageId` | missing | A doc id from another table is rejected. Divergence? bunvex could accept only doc ids. |
| Per-transaction file limits (10 files and 16 MiB read/written) | `crates/common/knobs.rs` `TRANSACTION_MAX_NUM_FILES_*` | missing | |
| Blob backends: local directory and S3 (`S3_STORAGE_*_BUCKET`, `S3_ENDPOINT_URL`, path style) | `crates/storage`; `crates/aws_s3`; `crates/aws_utils` | missing | Planned as `@bunvex/file-storage` local and s3. Convex splits blobs by use case: Files, Exports, SnapshotImports, Modules, SearchIndexes. |
| Storage type pinned at init (`_db` globals) | `crates/model/database_globals` | missing | Switching local↔S3 after init is an error. |
| Total file-storage size gauge | `FileStorageSizeTracker` | missing | Used for usage reporting. |

### 4. Scheduler

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `ctx.scheduler.runAfter(ms, fn, args)` / `runAt(ts\|Date, fn, args)` | `npm/convex/server/scheduler.ts`; `impl/scheduler_impl.ts` | missing | Mutations and actions only; function handles are allowed. |
| Scheduling is transactional (a job exists only if the mutation commits) | `crates/model/scheduled_jobs` | missing | The central guarantee. From actions, scheduling commits immediately. |
| Validation at schedule time: ±5 years, target must exist | `crates/udf/validation.rs` | missing | The function type is checked only when the job runs. |
| Limits: 1000 scheduled per transaction, 16 MiB total args (docs say 8 MB) | `knobs.rs` `TRANSACTION_MAX_NUM_SCHEDULED` etc. | missing | Docs quote "1,000,000 outstanding" for cloud. |
| `_scheduled_functions` virtual table `{name, args, scheduledTime, completedTime?, state}` | `crates/model/scheduled_jobs/virtual_table.rs` | missing | State kinds: `pending`, `inProgress`, `success`, `failed{error}`, `canceled`. Physical tables are `_scheduled_jobs` and `_scheduled_job_args`. |
| `ctx.scheduler.cancel(id)` | `SchedulerModel::cancel` | missing | Pending or in-progress jobs become canceled. A running action keeps running, but what it schedules is inserted as canceled. Finished jobs are a no-op, although the TS doc says it throws. A mutation canceling itself raises an error. |
| Scheduled mutations run exactly once | `crates/application/scheduled_jobs` | missing | Success is written in the same transaction as the user mutation. OCC is retried with backoff (100 ms to 60 s). A user error gives `failed`. |
| Scheduled actions run at most once | same | missing | Marked inProgress, then run. After a crash, a leftover inProgress job becomes failed ("Transient error"). Never retried. |
| System-error retry with backoff (500 ms to 2 h, unbounded attempts) | same; knobs `SCHEDULED_JOB_*_BACKOFF` | missing | |
| Executor parallelism 8; pauses when the deployment is paused | knob `SCHEDULED_JOB_EXECUTION_PARALLELISM` | missing | |
| GC of finished jobs after 7 days | `SCHEDULED_JOB_RETENTION`; `crates/application/system_table_cleanup` | missing | |
| Dashboard / API: cancel one job, cancel all, delete the scheduled-functions table | `/api/cancel_job`, `/api/cancel_all_jobs`, `/api/delete_scheduled_functions_table` | missing | |
| Per-component scheduling | `crates/model/scheduled_jobs` (per namespace) | missing | Depends on components. |

### 5. Cron jobs

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `cronJobs()` with `interval`, `hourly`, `daily`, `weekly`, `monthly`, `cron("m h dom mon dow")` | `npm/convex/server/cron.ts` | missing | All UTC. `monthly` days above 28 skip short months. Identifiers are printable ASCII and unique. |
| Defined as the default export of `convex/crons.ts`, validated at analyze time | `crates/isolate/environment/analyze.rs`; `application_function_runner` `validate_cron_jobs` | missing | Must target a mutation or action; queries and HTTP actions are rejected. |
| `_cron_jobs`, `_cron_next_run`, `_cron_job_logs` tables | `crates/model/cron_jobs` | missing | Keeps the last 5 logs per cron, with results and log lines truncated to 1000 chars. |
| Diff on push (added / updated / deleted) | `CronModel::apply` | missing | A new interval cron runs immediately. A schedule change recomputes the next run, using a 30 s heuristic. |
| Splay (`CRON_SPLAY_SECONDS` 60) | `crates/model/cron_jobs/next_ts.rs` | missing | Without `minuteUTC`, runs get a stable random offset within the hour. Divergence? It could be skipped. |
| No overlapping runs; missed runs skipped, not replayed | `crates/application/cron_jobs` | missing | Same exactly-once / at-most-once rules as the scheduler. |
| Dashboard: list crons and their run history | `system-udfs/_system/frontend/listCronJobs.ts`, `listCronJobRuns.ts` | missing | |

### 6. Full-text search

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `searchIndex(name, {searchField, filterFields?, staged?})` | `npm/convex/server/schema.ts` | missing | ARCHITECTURE marks search D, open decision #4. Up to 16 filter fields. |
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
| `httpRouter()` and `route({path \| pathPrefix, method, handler})` in `convex/http.ts` | `npm/convex/server/router.ts` | missing | ARCHITECTURE marks it M. Methods: GET, POST, PUT, DELETE, OPTIONS, PATCH. HEAD is served as GET. `/.files/` is reserved. |
| `httpAction(handler(ctx, Request) => Response)` | `npm/convex/server/impl/registration_impl.ts` | missing | Uses the action ctx: runQuery, runMutation, runAction, scheduler, storage, auth, vectorSearch. |
| Served under `/http/*` and a separate site origin (port 3211 proxy, `CONVEX_SITE_URL`) | `crates/local_backend/router.rs`, `proxy.rs`, `http_actions.rs` | missing | Divergence? bunvex could serve both on one port, by path or host. |
| Streaming request and response bodies; 20 MiB body limit | `crates/udf/http_action.rs` `HTTP_ACTION_BODY_LIMIT` | missing | |
| CORS is left to the app (no backend CORS on `/http`) | `router.rs` | missing | |
| Component HTTP mounts (`httpPrefix`) | `application_function_runner/http_routing.rs` | missing | |

### 9. Node.js actions ("use node")

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `"use node"` directive and a separate runtime for those modules | `npm/convex/bundler`; `crates/node_executor`; `npm-packages/node-executor` | missing | bunvex already runs on Bun, which has Node APIs, so this may collapse to "accept and ignore the directive". Divergence? |
| Only actions allowed in "use node" files; not allowed in http, crons, schema or auth.config | `node_executor/executor.rs`; `bundler/index.ts` `mustBeIsolate` | missing | An app written for Convex expects these errors. |
| `node.externalPackages` (installed server-side, `_external_deps_packages`) | `bundler/external.ts`; `crates/model/external_packages` | missing | |
| Node action timeout 600 s vs V8 action 1800 s | knobs `NODE_ACTION_USER_TIMEOUT_SECS`, `V8_ACTION_USER_TIMEOUT_SECS` | missing | bunvex actions have no timeout at all. |

### 10. Environment variables

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Deployment env vars in the `_environment_variables` table | `crates/model/environment_variables` | missing | bunvex reads the process env of the server itself; there are no per-deployment, runtime-changeable vars. |
| `process.env.X` inside functions | `udf-runtime/00_misc.ts`; `crates/isolate/ops/environment_variables.rs` | partial | bunvex functions see the host's real `process.env`, which is not isolated from server secrets such as `PERSISTENCE_URL`. |
| Env reads are in the read set; changes invalidate subscriptions and the cache | `crates/udf/environment.rs` `PreloadedEnvVars` | missing | |
| Limits: name `^[a-zA-Z_][a-zA-Z0-9_]*$` up to 256, value 8 KiB, 512 vars, 512 KiB total | `crates/common/types/environment_variables.rs`; knobs `ENV_VAR_*` | missing | |
| Built-ins `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL` (not overridable; canonical URL overrides) | `crates/udf/environment.rs`; `/api/update_canonical_url`; `_canonical_urls` | missing | |
| `POST /api/update_environment_variables`, `GET /api/list_environment_variables` (+ `/api/v1`) | `crates/local_backend/environment_variables.rs` | missing | |
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
| `dev` (watch, push, typecheck, codegen, `--once`, `--until-success`, `--run`, `--tail-logs`, local backend) | `npm/convex/cli/dev.ts`; `lib/localDeployment/*` | missing | Downloads and runs `convex-local-backend`. bunvex would run its own server in-process. |
| `deploy` (`--dry-run`, `-y`, `--cmd`, `--preview-*`, `--skip-large-indexes-check`, `--message`) | `cli/deploy.ts`; `lib/deploy2.ts` | missing | |
| `run <fn> [args]` (`--watch`, `--push`, `--identity`, `--component`, `--inline-query`) | `cli/run.ts` | missing | Needs admin-key auth and acting-as-user. |
| `import` (`--table`, `--replace`, `--append`, `--replace-all`, `--format csv\|jsonLines\|jsonArray\|zip`) | `cli/convexImport.ts` | missing | |
| `export --path [--include-file-storage]` | `cli/convexExport.ts` | missing | |
| `data [table] --limit --order --format --component` | `cli/data.ts` | missing | |
| `logs` (`--history`, `--success`, `--jsonl`) | `cli/logs.ts` | missing | |
| `env set\|get\|remove\|list` (and `env default …`, which is cloud-only) | `cli/env.ts` | missing | |
| `codegen` (`--typecheck`, `--init`, `--commonjs`, …) | `cli/codegen.ts` | missing | Open decision #1: codegen or type inference. |
| `function-spec` (JSON of every function's args and returns) | `cli/functionSpec.ts` | missing | |
| `typecheck`, `dashboard`, `docs`, `update`, `network-test` | `cli/*.ts` | missing | Low priority. |
| `mcp start` (tools: data, env, functionSpec, logs, run, runOneoffQuery, status, tables) | `cli/mcp.ts`; `lib/mcp/tools` | missing | ARCHITECTURE marks mcp D. |
| `deployment create/select/token/usage-limits`, `login`, `project` | `cli/deployment.ts` etc. | missing | Cloud-only; can be skipped. |
| Self-hosted selection via `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY`, `--url`, `--admin-key`, `--env-file` | `cli/lib/command.ts`, `lib/deployment.ts` | missing | |

### 13. Codegen (`convex/_generated`)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `api.d.ts` / `api.js`: `api`, `internal`, `components` (runtime `anyApi`) | `npm/convex/cli/codegen_templates/api.ts` | missing | Types are built with `FilterApi<ApiFromModules<…>>`. |
| `dataModel.d.ts`: `Doc<T>`, `Id<T>`, `TableNames`, `DataModel` | `codegen_templates/dataModel.ts` | missing | `AnyDataModel` when there is no schema. |
| `server.d.ts` / `server.js`: typed `query`, `mutation`, `action`, `internal*`, `httpAction`, ctx types | `codegen_templates/server.ts` | missing | |
| `component.ts` (ComponentApi) and component-level codegen | `codegen_templates/component_api.ts` | missing | |
| `convex.json` codegen options (`staticApi`, `staticDataModel`, `fileType`, `generateCommonJSApi`, `legacyComponentApi`) | `cli/lib/config.ts`; `schemas/convex.schema.json` | missing | |
| Other `convex.json` keys: `functions` dir, `node.externalPackages`, `node.nodeVersion`, `bundler.includeSourcesContent`, `typescriptCompiler` | same | missing | |

### 14. Deploy / push flow

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Bundling functions with esbuild (ESM, splitting, source maps, wasm, `server-only` stub) | `npm/convex/bundler/*` | missing | Open decision #2: restart vs hot swap. Bun.build is the natural equivalent. |
| Push protocol: `start_push`, `evaluate_push`, `wait_for_schema`, `finish_push`, `report_push_completed` | `cli/lib/deploy2.ts`; `crates/local_backend/deploy_config2.rs`; `crates/application/deploy_config.rs` | missing | |
| Module analysis (functions, visibility, arg and return validators, http routes, crons) | `crates/isolate/environment/analyze.rs` | missing | Feeds function-spec, the dashboard and validation. |
| Storing modules and source packages (`_modules`, `_source_packages`, `_udf_config`) | `crates/model/modules`, `source_packages`, `udf_config` | missing | `_udf_config` holds the npm version and the import-phase RNG seed and timestamp, which matter for determinism. |
| Skipping unchanged modules (`get_config_hashes`) | `/api/get_config_hashes` | missing | |
| Schema push: diff indexes, add pending indexes, enable on finish | `crates/database/bootstrap_model/index.rs` | missing | |
| Schema validation of existing documents on push (Pending, Validated, Active, Failed) | `crates/application/schema_worker`; `crates/common/schemas` | missing | Uses shape inference to skip walks; tracked in `_schemas` and `_schema_validation_progress`. bunvex has no document validation yet (N). |
| `schemaValidation: false`, `strictTableNameTypes` | `npm/convex/server/schema.ts` | missing | |
| Large-backfill guard (100k docs) and `staged` indexes | `cli/lib/checkForLargeIndexBackfill.ts` | missing | |
| Push limits: 200 MB request, 4096 modules, 90 MB zipped / 230 MB unzipped | knobs `MAX_PUSH_BYTES` etc. | missing | |
| Analyze timeout 4 s | `ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS` | missing | |

### 15. Indexes, backfill, table metadata

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| System indexes `by_id` and `by_creation_time` on every table | `crates/common/bootstrap_model/index` | done | `packages/core/src/schema.ts`. |
| Declared database indexes (up to 16 fields) | `crates/common/schemas` | partial | Declared in code via `Schema.table()`; no `defineSchema` / `defineTable().index()` API and no field-count limit. |
| Index backfill over existing data | `crates/database/database_index_workers`; `_index_backfills` | partial (#6) | Synchronous at startup, in batched commits, idempotent after a crash (STUDY-04). Convex backfills in the background from a snapshot and persists progress. |
| Index states Backfilling, Backfilled, Enabled; staged indexes | `crates/common/bootstrap_model/index/database_index/index_state.rs` | partial (#6) | `backfilling` → `enabled`; no `Backfilled`/staged state. |
| Index/table limits: 64 indexes per table (docs say 32), 10 000 tables, names up to 64 chars | `crates/common/schemas/mod.rs`; `database/bootstrap_model/table.rs` | missing | |
| `_tables` (Active, Hidden, Deleting) and `_index` metadata tables | `crates/common/bootstrap_model/tables.rs`, `index/mod.rs` | partial (#6) | `_tables`/`_index` are persisted (STUDY-04); there are no Hidden/Deleting states. |
| Deleting tables and clearing tables (dashboard / API) | `/api/delete_tables`; `system-udfs clearTablePage.ts` | missing | |
| Table size and shape (`/api/shapes2`, `tableSize`) | `crates/shape_inference`; `system-udfs/_system/frontend/tableSize.ts` | missing | |

### 16. Retention / GC

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Index retention: delete expired index entries older than `INDEX_RETENTION_DELAY` (4 min) | `crates/database/retention.rs` `go_delete_indexes` | missing | ARCHITECTURE marks it M. bunvex keeps every version and index entry forever. |
| Document retention: delete old document revisions after `DOCUMENT_RETENTION_DELAY` (14 d; docker-compose sets 2 d) | `retention.rs` `expired_documents` | missing | |
| Reads below the minimum snapshot timestamp fail (snapshot invalid) | `retention.rs` `validate_snapshot` | missing | bunvex snapshots are always valid today; that changes once GC exists. |
| Purging deleted tables | `retention.rs` `delete_documents_in_tablets` | missing | |
| Checkpointing and rate limits (`RETENTION_*` knobs) | `knobs.rs:667-822` | missing | |
| System table cleanup: scheduled jobs (7 d), sessions (2 w), expired exports (30 d), import age (7 d) | `crates/application/system_table_cleanup` | missing | |

### 17. System tables (complete list)

The first 18 rows are the tables an app can see or depend on. The last row groups internal bookkeeping tables. bunvex has none of them.

| Table | Convex source | bunvex status | Notes |
|---|---|---|---|
| `_storage` (virtual) / `_file_storage` | `crates/model/file_storage` | missing | Readable by apps via `db.system`. |
| `_scheduled_functions` (virtual) / `_scheduled_jobs` / `_scheduled_job_args` | `crates/model/scheduled_jobs` | missing | Readable by apps via `db.system`. |
| `_cron_jobs`, `_cron_next_run`, `_cron_job_logs` | `crates/model/cron_jobs` | missing | |
| `_tables`, `_index`, `_index_backfills`, `_index_worker_metadata` | `crates/common/bootstrap_model`; `crates/database/bootstrap_model` | partial (#6) | `_tables` and `_index` exist; the other two do not. |
| `_schemas`, `_schema_validations`, `_schema_validation_progress` | `crates/database/bootstrap_model/schema` | missing | |
| `_modules`, `_source_packages`, `_udf_config`, `_external_deps_packages` | `crates/model/modules` etc. | missing | |
| `_auth` | `crates/model/auth` | missing | |
| `_environment_variables` | `crates/model/environment_variables` | missing | |
| `_components`, `_component_definitions`, `_function_handles` | `crates/model/components` | missing | |
| `_session_requests` | `crates/model/session_requests` | done (STUDY-23) | Mutation idempotency per (session, request seq). This is the sync layer's exactly-once guarantee, listed here for completeness. |
| `_exports`, `_snapshot_imports` | `crates/model/exports`, `snapshot_imports` | missing | |
| `_log_sinks` | `crates/model/log_sinks` | missing | |
| `_deployment_audit_log`, `_audit_log_config` | `crates/model/deployment_audit_log`, `audit_log_config` | missing | |
| `_backend_state` | `crates/model/backend_state` | missing | Running, paused or disabled; also the usage-limit stop state. |
| `_canonical_urls` | `crates/model/canonical_urls` | missing | |
| `_db` (database globals: version, storage type, S3 prefix) | `crates/model/database_globals` | missing | |
| `_usage_limits` | `crates/model/usage_limits` | missing | Usage caps; also exposed via `/api/v1`. |
| `_data_sync_progress` | `crates/model/data_sync_progress` | missing | Streaming export / Fivetran. |
| `_backend_info`, `_aws_lambda_versions`, `_next_persistence_index_id` | `crates/model/*` | missing | Internal bookkeeping (cloud entitlements, Lambda, id allocation); `_backend_info` can be skipped. |

### 18. Import / export / backups

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Snapshot export ZIP: `README.md`, `_tables/documents.jsonl`, `<table>/documents.jsonl`, `<table>/generated_schema.jsonl`, `_storage/documents.jsonl` + blobs, `_components/<name>/…` | `crates/exports`; `crates/application/exports/worker.rs` | missing | ARCHITECTURE marks it D. Taken at one snapshot timestamp. The format is what lets data move between Convex and bunvex. |
| Export API: `/api/export/request/zip?includeStorage=`, `/zip/{id}`, token, `set_expiration`, cancel | `crates/local_backend/router.rs` | missing | |
| Snapshot import: CSV, JSONL, JSON array, ZIP | `crates/application/snapshot_import/*` | missing | |
| Import modes RequireEmpty (default), Append, Replace, ReplaceAll; confirmation step | `snapshot_import/mod.rs`; `_snapshot_imports` states | missing | Tables stay Hidden until the import commits atomically. |
| Resumable upload (`start_upload`, `upload_part`, `finish_upload`, `perform_import`, `cancel_import`) | `/api/import/*` | missing | |
| Shape inference / generated schema | `crates/shape_inference` | missing | Also used by the dashboard's "generate schema". |
| Preserving `_id` and `_creationTime` on import | `snapshot_import` | missing | Needed by bunvex's id format (STUDY-01). |
| Periodic cloud backups and restore | `dashboard/…/Backups.tsx` | missing | Cloud-only; self-hosted uses export/import. Can be skipped. |
| Upgrade path via export and `import --replace-all` | `self-hosted/advanced/upgrading.md` | missing | |

### 19. Streaming export / import (Fivetran, Airbyte)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `list_snapshot` and `document_deltas` (paged snapshot plus change feed) | `crates/local_backend/streaming_export.rs`; `crates/application/streaming_export.rs` | missing | bunvex's versioned log makes deltas natural. |
| `json_schemas`, `get_table_column_names`, `test_streaming_export_connection` | same | missing | |
| Data-sync v1 API (`/api/v1/data/sync…`, protobuf cursor) | `crates/streaming_export`; `crates/pb_data_sync` | missing | |
| Fivetran source/destination connectors | `crates/fivetran_source`, `fivetran_destination` | missing | Separate programs; low priority. |
| Streaming import (`/api/streaming_import/*`: Airbyte records, Fivetran operations, primary-key indexes) | `crates/application/airbyte_import.rs`; `crates/model/fivetran_import` | missing | |

### 20. Logs, log streaming, metrics, usage

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| Capturing `console.*` from functions (up to 256 lines, 32 KiB per line; docs say 4 KiB) | `crates/isolate/environment/helpers`; `crates/common/log_lines.rs` | done (STUDY-20) | Also still printed to the server's stdout. |
| Returning log lines to the client (dev console) and `REDACT_LOGS_TO_CLIENT` | sync protocol `logLines`; `local_backend/config.rs` | partial (STUDY-20) | HTTP `logLines` and WebSocket mutation `l`; subscriptions and cached query results carry none yet (STUDY-20 D2, D3). |
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
| Health (failure rate, cache hit, calls, concurrency, invalidations) | `dashboard-common/features/health` | missing | Needs app metrics. bunvex's Health screen shows the engine's counters meanwhile (STUDY-12 D12). |
| Data browser (filters, index selection, edit/add/delete documents, clear table, create table, generate schema) | `features/data`; `system-udfs/_system/frontend/*` | partial | Built on the mock (STUDY-12, UI-01 §12): index + field filters, live documents and counts, in-place editing, add / delete / clear, column layout, the cell context menu and shortcuts, complete (view value, go to reference, delete document). create table (UI-01 §15.4), a generated schema (§15.5). Missing: custom query, per-table metrics; the server's admin API (Convex's relies on about 40 system UDFs, `_system/frontend/*`, `_system/cli/*`). Divergences decided (STUDY-12 §4) but D13 (a menu delete asks first). |
| Schema view, Functions (tree, perf graphs, function runner with identity) | `features/functions`, `functionRunner` | partial | The Functions screen is built on the mock (STUDY-12 §7, UI-01 §13.2): the module tree with search, a function's kind, visibility, path and logs; the function runner (UI-01 §13.3: arguments as literals, value or error, the run's log lines; a query stays subscribed and updates live, §16.1; run history, §16.2; acting as a user, §16.3); declared argument and return validators shown, and the runner's template and live argument checks from them (UI-01 §15.1). Missing: performance graphs (no app metrics, L1), live query results, run history, acting as a user, custom test queries, a separate schema view (the Database screen's schema panel shows the saved schema as code, UI-01 §15.2). |
| Files (upload, delete, preview) | `features/files` | partial | The Files screen is built on the mock (STUDY-12 §9, UI-01 §14.3): stored files newest or oldest first, a day range, lookup by storage id, upload, select and delete, a file's metadata with an image preview, Download. The contract methods are optional. Missing: the server's file storage and its admin API (§3 of this file). |
| Schedules (scheduled functions, cancel; crons with history) | `features/schedules` | partial | The Schedules screen is built on the mock (STUDY-12 §9, UI-01 §14.2): scheduled runs nearest first with a function filter, a run's details and arguments, Cancel and Cancel all; cron jobs with schedule, last and next run, and recent runs. The contract methods are optional. Missing: the server's scheduler and its admin API (see §4 of this file), a component picker. |
| Logs (call tree, search), History (audit log) | `features/logs`, `history` | partial | The Logs screen is built on the mock (STUDY-12 §7, UI-01 §13.1): live lines newest first, pause, clear, client-side filters by function, type and text, in the URL and kept per deployment (STUDY-12 L7), a line's details with its request, and the call tree (UI-01 §15.6). Deployment events among the lines (UI-01 §16.4). Usage and identity in the details (UI-01 §16.5). Missing: the server's log stream. The History screen (audit log) is built on the mock too (STUDY-12 §9, UI-01 §14.5): events newest first in words, by action and day range, live; the server records none yet. |
| Settings: pause deployment, env vars, usage limits, auth config, components, integrations (log sinks) | `features/settings` | partial | Environment variables are built on the mock (STUDY-12 §9, UI-01 §14.4): values hidden until shown, copy one or all as `.env`, add / edit / rename / delete saved as one batch with Convex's limits, a pasted `.env` file becomes rows. The server has no per-deployment variables yet (§10). The other settings pages are missing; backups and custom domains are disabled on self-hosted. |

### 22. Deployment state, health, self-hosted configuration

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `GET /version`, `/instance_version`, `/instance_name`, `/`, `POST /echo` | `crates/local_backend/router.rs`; `crates/health_check` | partial | bunvex has `/version`, which returns "bunvex". docker-compose's healthcheck is `curl /version`. |
| Pause / unpause deployment (`_backend_state`, `/api/v1/pause_deployment`) | `crates/model/backend_state` | missing | A paused deployment rejects functions and stops the scheduler and crons. |
| Backend flags: `--port` 3210, `--site-proxy-port` 3211, `--interface`, `--convex-origin`, `--convex-site`, `--instance-name`, `--instance-secret`, `--local-storage`, `--s3-storage`, `--do-not-require-ssl`, `--disable-beacon`, `--redact-logs-to-client`, `--local-log-sink`, `--convex-http-proxy` | `crates/local_backend/config.rs` | partial | bunvex has a port option, defaulting to 3210, plus `PERSISTENCE*`, `DATA`, `DURABLE` and `POOL`. The rest are missing. |
| Database selection: SQLite by default, `POSTGRES_URL`, `MYSQL_URL`, `DATABASE_URL`; database name derived from the instance name | `self-hosted/docker-build/run_backend.sh`; `crates/postgres`, `mysql`, `sqlite` | done | bunvex covers the same stores plus memory and MongoDB, with its own env names (`PERSISTENCE`, `PERSISTENCE_URL`). Divergence? It could accept Convex's names as aliases. |
| Single writer per database: the persistence lease (`leases` table; the newest process wins at once, the loser exits on its next write with `LeaseLostError`; `SELECT … FOR SHARE` before COMMIT fences writes) | `crates/postgres/src/lib.rs:1745-1893`, `sql.rs:721-755`; `crates/mysql/src/v6/persistence.rs` (SQLite: none) | partial | PERSIST-01 C7 (STUDY-24 H8): Postgres has it; MySQL, MongoDB, SQLite and memory follow. **Divergence (owner, 2026-09-30, STUDY-24 H5):** bunvex's lease has a TTL on the store's clock and a graceful release, and a live lease is never taken — a second process fails to open with `LeaseHeldError` (or waits, with `lease.waitMs`), where Convex's newest process wins at once. The fence is an epoch checked inside each flush's first statement. |
| S3 env (`AWS_*`, `S3_ENDPOINT_URL`, `S3_STORAGE_{EXPORTS,SNAPSHOT_IMPORTS,MODULES,FILES,SEARCH}_BUCKET`, `AWS_S3_FORCE_PATH_STYLE`, `AWS_S3_DISABLE_SSE/CHECKSUMS`) | `crates/aws_s3`, `aws_utils` | missing | Planned `FILE_STORAGE=`. |
| Knob env overrides (every knob is an env var) | `crates/common/knobs.rs`; `self-hosted/advanced/knobs.md` | missing | |
| Docker image, docker-compose, credentials bootstrap (`read_credentials.sh`) | `self-hosted/docker*` | missing | ARCHITECTURE marks docker/ M. |
| SSRF proxy for action `fetch` and OIDC (`--convex-http-proxy`) | `crates/local_backend/config.rs` | missing | |
| Beacon / telemetry (hourly, `DISABLE_BEACON`), Sentry | `crates/local_backend/beacon.rs` | missing | Divergence? bunvex probably shouldn't ship one. |
| In-place database migrations between versions (`migrations_model`) | `crates/migrations_model` | missing | bunvex needs a persistence format version story. |
| OpenAPI specs (`/api/public_openapi.json`, `/api/dashboard_openapi.json`, `/api/v1/openapi.json`) | `crates/local_backend/router.rs` | missing | |

### 23. Public HTTP function API (non-sync)

| Feature | Convex source | bunvex status | Notes |
|---|---|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action` `{path, args, format}` returning `{status, value, logLines}` | `crates/local_backend/public_api.rs` | partial | Since STUDY-20: `args` as an object or a one-element array, function errors as HTTP 200 `{status:"error", errorMessage, errorData?, logLines?}`, request errors as `{code, message}`, system failures as 500. Still no `format`, no auth header. |
| `GET /api/query`, `/api/query_ts`, `/api/query_at_ts`, `/api/query_batch`, `/api/function`, `/api/run/{fn}` | same | missing | |

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
| done | 2 |
| partial | 11 |
| missing | 224 |

- The two done rows are system indexes and database selection.
- The eleven partial rows are: the persistence lease (PERSIST-01 C7, Postgres first), declared indexes, internal-function admin access, `process.env`, `/metrics` (via `/stats`), `/version` health, backend flags, the public HTTP function API, OCC retries (done since STUDY-21), the self-hosted dashboard app and the data browser.
- Everything else, including the system-table catalogue, is missing.

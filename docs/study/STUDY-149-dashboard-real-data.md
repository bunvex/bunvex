# STUDY-149 — The dashboard on real data: how Convex's dashboard reads a deployment

- **Status:** decided (owner, 2026-10-12); PR 1 built (`@bunvex/dashboard-source`, §5 "PR 1, as built"). Q1: option B, a
  separate service with its own image (DV-475); Q3: rename (DV-474); Q4: Convex's model plus a `Host` check
  (DV-476); Q5: local links only (DV-477, replaces DV-217); Q2, Q6, Q7 confirmed as planned; AD-32 not taken.
- **Convex source read:** commit `4577b9031` of get-convex/convex-backend (`npm-packages/dashboard-common`,
  `dashboard-self-hosted`, `dashboard`, `system-udfs/convex/_system/frontend`, `@convex-dev/platform`,
  `convex/src/cli`, `self-hosted/docker`, `crates/local_backend`, `crates/application`)
- **Related:** [STUDY-12](STUDY-12-dashboard.md) (the screens, built on the mock; D1 and D3 decided),
  [UI-01](../specs/UI-01-ui-and-dashboard.md) §5 (the `DashboardDataSource` contract, §5.7 the proposed HTTP
  source), [STUDY-34](STUDY-34-admin-keys.md) (admin keys), [STUDY-38](STUDY-38-docker.md) K3 (DV-189),
  [STUDY-39](STUDY-39-standalone-binary.md) B2 (DV-194), [STUDY-40](STUDY-40-local-backend-and-local-deployments.md)
  L6 (DV-202), [STUDY-42](STUDY-42-import-export.md) X3 (DV-217), [STUDY-48](STUDY-48-audit-log.md) (audit
  log), [STUDY-58](STUDY-58-app-metrics.md) (app metrics), [STUDY-119](STUDY-119-run-inline-query.md)
  (`run_test_function`), [STUDY-146](STUDY-146-cli-network-test-docs-update-dashboard.md) (`bunvex dashboard`);
  [parity: platform §21](../parity/platform.md), roadmap item 12

STUDY-12 is about the **screens**: what each one shows and how bunvex drew it on the mock. This study is about
the **wire**: what Convex's dashboard calls on a deployment, how often, with which credentials, how it is
packaged and connected, and how bunvex's dashboard gets a real data source in place of the mock. It does not
repeat STUDY-12's screen descriptions.

In the citations, `dc/` is `npm-packages/dashboard-common/src/`, `sh/` is
`npm-packages/dashboard-self-hosted/src/`, `cl/` is `npm-packages/dashboard/src/`, `lb/` is
`crates/local_backend/src/`, and `udfs` is `api._system.frontend` (`dc/udfs.ts:1-6`), the functions in
`npm-packages/system-udfs/convex/_system/frontend/`.

## 1. How Convex does it

### 1.1 Two channels, one credential

Convex's dashboard talks to a deployment over exactly two channels, both with the admin key.

1. **The sync WebSocket, as an admin.**
   - `DeploymentApiProvider` builds a `ConvexReactClient(deploymentUrl)` and calls
     `client.setAdminAuth(adminKey)` before anything subscribes (`dc/lib/deploymentContext.tsx:524-531`).
   - A rotated key is pushed into the open socket without a new client (`:576-580`).
   - On the wire this is `{type: "Authenticate", tokenType: "Admin", value, impersonating}`
     (`npm-packages/convex/src/browser/sync/local_state.ts:220-241`), on `/api/{version}/sync`
     (`lb/router.rs:291`, `:402`).
   - Every `useQuery` / `usePaginatedQuery` of a `udfs.*` function is therefore a **reactive subscription**,
     and every `useMutation` a WebSocket mutation. `useSystemQuery` (`dc/lib/useSystemQuery.ts:20-41`) is a
     thin wrapper over the same hook.
   - The dashboard calls `_system/frontend/*` only; `_system/cli/*` is the CLI's.
2. **The HTTP admin API.**
   - `useDeploymentAuthHeader()` returns `` `Convex ${adminKey}` `` (`dc/lib/deploymentApi.ts:14-36`).
   - `deploymentFetch` sends `Authorization: Convex <adminKey>` and `Convex-Client: dashboard-0.0.0`
     (`dc/lib/fetching.ts:93-117`); SWR keys include the URL, path and header (`deploymentApi.ts:91-104`).
   - The `/api/v1/*` platform routes go through `createDeploymentClient(url, key)` with the same header
     (`npm-packages/@convex-dev/platform/src/client.ts:46-63`).
   - **One exception:** `POST /api/run_test_function` (the custom query) carries the admin key **in the JSON
     body** (`adminKey`), with no `Authorization` header (`dc/features/functionRunner/lib/client.ts:50-105`;
     the route is in `cli_routes`, `lb/router.rs:333`; the handler `lb/dashboard.rs:291-330`).

On the server, `extract_admin_key` strips a case-insensitive `convex ` prefix, and an optional
`:<base64 identity>` suffix means "an admin acting as a user" (`lb/authentication.rs:106-128`, `:168-205`).
Each system function and route then checks a named operation (`DeploymentOp`), e.g. the log stream needs
`ViewLogs` (`crates/application/src/lib.rs:1031-1033`).

A watchdog polls `client.connectionState()` every 2 500 ms (`dc/lib/deploymentContext.tsx:819-879`;
`sh/pages/_app.tsx:332`) and shows the disconnect overlay; for a `local-*` deployment it also fetches
`/instance_name` (`:796`).

`dc/lib/usePausedLiveData.ts` guards the busiest live lists (scheduled jobs, files): past 100 updates in 10 s
it **auto-pauses** the subscription and switches to one-shot `client.query()` calls on a second admin client
(`:9-11`, `:102-142`), until the user presses "Go live".

### 1.2 Per screen: mechanism, freshness and calls

"Live" = a reactive query over the WebSocket. "Poll N s" = SWR `refreshInterval`. "Long-poll" = an HTTP
request the server holds until there is data or 60 s pass. "Once" = fetched when the view opens or the user
acts.

| Screen / part | Mechanism | Function or route | Freshness | Call site |
|---|---|---|---|---|
| **Data** — table list | WS query | `getTableMapping` | live | `dc/lib/useTableMetadata.tsx:26` |
| Data — component switcher | WS query | `components.list` | live | `dc/lib/useNents.ts:32-35` |
| Data — documents | WS paginated query | `paginatedTableDocuments {table, filters, componentId}` | live; `"skip"` after 1 min idle | `dc/features/data/components/Table/utils/useQueryFilteredTable.ts:22,43,49-54` |
| Data — row count | WS query | `tableSize` | live | `DataContent.tsx:96` |
| Data — indexes | WS query | `indexes {tableName, tableNamespace}` | live | `DataContent.tsx:286`, `IndexList.tsx:25` (`/api/get_indexes` exists, `lb/dashboard.rs:216`, but is not called) |
| Data — schema | WS query | `getSchemas` | live | `DataView.tsx:67`, `TableSchema.tsx:78,260` |
| Data — inferred shapes | HTTP GET | `/api/shapes2[?component=]` | **poll 60 s** | `dc/lib/deploymentApi.ts:48-77` (`refreshInterval: 60000`, `:61`); `lb/dashboard.rs:89-97` |
| Data — id references | WS query | `getTableMapping`, `listById` | live | `DataCell.tsx:541,546`, `useIdDecorations.tsx:36,56` |
| Data — add / patch / replace / delete | WS mutation | `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments` | once | `dc/features/data/lib/useDataToolbarActions.ts:44,63,66`; `useToolPopup.tsx:228` |
| Data — clear table | WS mutation, looped on a cursor | `clearTablePage {tableName, cursor}` (4 000 per call) | once | `ClearTableConfirmation.tsx:59`; `system-udfs/…/clearTablePage.ts:5` |
| Data — create table | WS mutation | `createTable` | once | `DataSidebar.tsx:105` |
| Data — delete tables | HTTP POST | `/api/delete_tables {tableNames, componentId}` | once | `dc/features/data/lib/api.ts:13-29` |
| Data — table metrics | HTTP GET | `/api/app_metrics/table_rate` | once (chart open) | `dc/lib/appMetrics.ts:758-785`; `BigChart.tsx:38-60` |
| **Schema** | WS query + HTTP | `getSchemas`, `getSchemas:schemaValidationProgress`; `/api/shapes2` | live; shapes poll 60 s | `dc/features/schema/components/SchemaView.tsx:46-54` |
| **Functions** — module tree | WS query | `modules:listForAllComponents` | live | `dc/lib/functions/useListModules.ts:23-26` |
| Functions — summary | WS query | `getVersion`, `convexSiteUrl`, `components.list` | live | `FunctionSummary.tsx:37`; `useHttpActionRoute.ts:24-28` |
| Functions — statistics | HTTP GET | `/api/app_metrics/{udf_rate, cache_hit_percentage, latency_percentiles}` | **once** per window (no interval) | `dc/lib/appMetrics.ts:649-753`; `SingleGraph.tsx:32-41` |
| Functions — invalidations (mutations) | HTTP GET | `/api/app_metrics/subscription_invalidations_top_k` | poll 8 s | `appMetrics.ts:513-559` (`:555`) |
| Functions — logs | long-poll | as Logs, filtered | long-poll | `FunctionLogs.tsx:140` |
| **Runner** — query | WS query on a second admin client (impersonation via `setAdminAuth(key, identity)`) | the function itself, `watchQuery` | live | `dc/features/functionRunner/lib/client.ts:14-48`; `QueryResult.tsx:94` |
| Runner — mutation / action | WS request | `mutationInternal` / `actionInternal` | once | `FunctionTester.tsx:583-608` |
| Runner — the run's log lines | long-poll | `/api/app_metrics/stream_function_logs?…&sessionId&clientRequestCounter` | long-poll | `dc/lib/useLogs.ts:318-354`; server filter `lb/logs.rs:85-127` |
| Runner — argument validator, paused banner | WS query | `modules:argsValidator`, `deploymentState:deploymentState` | live | `FunctionTester.tsx:188`; `FunctionRunnerWrapper.tsx:40` |
| **Custom query** | HTTP POST | `/api/run_test_function {bundle: {path, source}, adminKey, componentId, args, format: "convex_encoded_json"}`; types from `getSchemas` | once (Run) | `functionRunner/lib/client.ts:50-105`; `FunctionEditor.tsx:205,265-286` |
| **Logs** | long-poll | `GET /api/app_metrics/stream_function_logs?cursor=<ms>` | long-poll (60 s) | `dc/lib/appMetrics.ts:69-110`; loop `dc/lib/useLogs.ts:204-275` |
| Logs — deployment events | WS paginated query | `paginatedDeploymentEvents {filters: {minDate, actions}}` | live | `dc/lib/useDeploymentAuditLog.ts:105-125`; `Logs.tsx:127` |
| **Health** — function calls, failure rate, cache hit rate | HTTP GET | `/api/app_metrics/{function_call_count_top_k, failure_percentage_top_k, cache_hit_percentage_top_k}` | **poll 8 s** | `appMetrics.ts:192-228,324-366,414-441` |
| Health — concurrency | HTTP GET | `/api/app_metrics/function_concurrency` | poll 8 s | `appMetrics.ts:801-857` (`:829`); `ConcurrencyStatus.tsx:29` |
| Health — scheduler lag | HTTP GET | `/api/app_metrics/scheduled_job_lag` (1 h, 60 buckets) | **poll 60 s** | `appMetrics.ts:119-165` (`:143`) |
| Health — subscription invalidations | HTTP GET | `/api/app_metrics/subscription_invalidations_top_k?k=3` | poll 8 s | `SubscriptionInvalidations.tsx:6` |
| Health — deployment summary | WS query + npm | `lastPushEvent`, `convexCloudUrl`, `convexSiteUrl`, `getVersion`; `registry.npmjs.org/convex/latest` | live | `DeploymentSummary.tsx:51,140-165`; **cloud only** (`HealthView.tsx:60`) |
| Health — insights | Big Brain HTTP | `/api/dashboard/teams/{id}/usage/query` | poll 600 s | `cl/api/insights.ts:201-220`; **cloud only** |
| Every page — banners | WS query | `backendState:backendState` | live | `dc/layouts/DeploymentDashboardLayout.tsx:215` |
| **Schedules** — scheduled runs | WS paginated query + auto-pause | `paginatedScheduledJobs {udfPath, componentId}` | live (one-shot while paused) | `dc/features/schedules/lib/usePaginatedScheduledJobs.ts:24-45` |
| Schedules — a run's arguments | WS query | `scheduler:getArgs` | live | `ScheduledFunctionsListItem.tsx:181` |
| Schedules — cancel | HTTP POST | `/api/cancel_job`, `/api/cancel_all_jobs`, `/api/delete_scheduled_functions_table` | once | `dc/features/schedules/lib/api.tsx:21,69,97` |
| Schedules — crons | WS query | `listCronJobs`, `listCronJobRuns` (+ the module list) | live | `CronsProvider.tsx:37-44` |
| **Files** | WS paginated query + auto-pause; WS query | `fileStorageV2:fileMetadata`; `numFiles`, `getFile` | live | `usePaginatedFileMetadata.ts:38,56-60`; `FileStorageView.tsx:76-82` |
| Files — upload | WS mutation, then a raw POST | `fileStorageV2:generateUploadUrl`, then `POST <uploadUrl>` | once | `Uploader.tsx:48,72-79` |
| Files — delete | WS mutation | `fileStorageV2:deleteFiles` | once | `DeleteFileModal.tsx:14` |
| **Settings** — environment variables | WS query; HTTP POST | `listEnvironmentVariables`; `/api/update_environment_variables {changes}` | live read | `DeploymentEnvironmentVariables.tsx:34,205`; `settings/lib/api.ts:20-48` |
| Settings — pause | WS query; HTTP POST | `deploymentState`; `/api/v1/pause_deployment`, `/api/v1/unpause_deployment` | live read | `PauseDeployment.tsx:35`; `settings/lib/api.ts:74-106` |
| Settings — authentication | WS query | `listAuthProviders` | live | `AuthConfig.tsx:10` |
| Settings — components | WS query; HTTP POST | `components.list`; `/api/delete_component` | live | `settings/lib/api.ts:50-72` |
| Settings — integrations | WS query; HTTP POST | `listConfiguredSinks`; `/api/v1/{create,update,delete}_log_stream`, `rotate_webhook_secret` | live read | `IntegrationsView.tsx:29-30`; `dc/lib/integrationsApi.ts:44-125` |
| Settings — usage limits | HTTP GET / POST | `/api/v1/list_usage_limits` (revalidated after writes), `/api/v1/get_current_usage` (**poll 5 s**), `create/update/delete_usage_limit` | poll 5 s (usage) | `dc/features/settings/lib/api.ts:139-315` |
| Settings — general | — | self-hosted: the pause section only (`sh/pages/settings/index.tsx`); cloud adds the summary, deploy keys, delete | live | `cl/pages/t/[team]/[project]/[deploymentName]/settings/index.tsx:40-105` |
| **History** (audit log) | WS paginated query | `paginatedDeploymentEvents {filters}` (needs `ViewAuditLog`) | live | `dc/lib/useDeploymentAuditLog.ts:191`; `HistoryView.tsx:142` (`/api/v1/list_audit_log_events` exists, `lb/deployment_audit_log.rs:180`, but is not used) |
| **Snapshot export** | WS query; HTTP | `latestExport`; `GET /api/export/zip/{id}?adminKey=` or `POST …/token`; `POST /api/export/cancel/{id}`; import via `snapshotImport.list`, `/api/perform_import`, `/api/cancel_import` | live read | `cl/components/deploymentSettings/SnapshotExport.tsx:129`; `cl/hooks/deploymentApi.ts:29-105`; **cloud only** (the self-hosted sidebar always filters Snapshots out, `dc/layouts/SettingsSidebar.tsx:169`) |
| **Backups** | Big Brain HTTP | `/api/dashboard/deployments/{id}/list_cloud_backups` etc. | poll 5 s | `cl/api/backups.ts:25-160`; **cloud only** |

### 1.3 The log stream in detail

- **Client** (`dc/lib/useLogs.ts:204-315`): a loop that awaits `streamFunctionLogs(url, auth, cursor)`, takes
  `newCursor`, appends the entries, and repeats. The cursor starts at 0, so the first answer is whatever the
  server's ring buffer still holds. Errors back off from 500 ms, doubling, up to 16 s with jitter
  (`dc/lib/utils.ts:51-59`); after 5 failures a "disconnected" toast; a 403 stops the loop. At most
  `MAX_LOGS = 10 000` entries are kept (`:31`).
- **Server** (`lb/logs.rs:79-170`): `stream_parts(cursor)` races a 60 s sleep (`:163`); on timeout it answers
  `{entries: [], newCursor: cursor}`. Structured log lines go to `Dashboard` and `CLI` clients (`:96-115`).
  The dashboard uses `/api/app_metrics/stream_function_logs` (`lb/router.rs:508`); the CLI and MCP use
  `/api/stream_function_logs` (`:355`); `stream_udf_execution` (`:38-71`) is the legacy shape, unused by the
  dashboard.
- So **Logs is not a WebSocket subscription**: it is a long-poll, fresh within one round trip of an execution
  finishing.

### 1.4 The self-hosted dashboard and how it connects

**Credentials** (`sh/pages/_app.tsx`) can come four ways:

1. **The form** (`DeploymentCredentialsForm`), pre-filled from `NEXT_PUBLIC_DEPLOYMENT_URL` /
   `NEXT_PUBLIC_ADMIN_KEY` read on the server in `getInitialProps` (`:151-201`, `:506-510`).
2. **`GET /api/current_deployment`** on the dashboard's own origin → `{name, url, adminKey}`, only in a build
   with `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true` (`:136-137`; `sh/lib/fetchCurrentDeployment.ts:18-33`).
   This is how the CLI's local dashboard signs in without a form.
3. **An iframe parent**: `{type: "dashboard-credentials-request"}` posted to `*`, any
   `{type: "dashboard-credentials", adminKey, deploymentUrl, deploymentName, visiblePages?}` accepted
   (`:573-629`); `visiblePages` trims the sidebar (`DeploymentDashboardLayout.tsx:114-147`).
4. **A legacy deployment list**: `?a=<port>&d=<name>` → `GET http://127.0.0.1:<port>` (`:448-481`).

**Check and storage**: `checkDeploymentInfo` → `GET <url>/api/check_admin_key` with `Authorization: Convex
<key>`, 3 tries 500 ms apart; a 404 means every operation (`sh/lib/checkDeploymentInfo.ts:17-58`).
On success the key, URL and name go to `sessionStorage` (`:356-364`, `:396-401`), `allowedOps` drives
`useIsOperationAllowed` (empty = all, `:437-441`), and "Log out" clears them (`:524-528`).

**What the self-hosted build strips** (`deploymentInfo`, `sh/pages/_app.tsx:206-334`):

- Stubbed: team and project (id 0), members (`[]`), entitlements (everything on, audit retention −1),
  `useCurrentDeployment` (a fake `local`/`dev` deployment), protected deployment (`false`), project admin
  (`true`), custom roles (`false`), project env vars (`[]`), deployment-event logging (no-op), every WorkOS
  operation (no-ops), `CloudImport`, `TeamMemberLink` ("An admin"), plan and usage state; analytics and the
  feedback form absent; `isSelfHosted: true`; WorkOS, S3 export and Fivetran progress off.
- Real: `useIsDeploymentPaused` (a live `deploymentState` query, `:264`).
- **Pages kept** (`sh/pages`): Health (without the summary and insights), Data, Schema, Functions, Files, Logs,
  History, Schedules (functions, crons), Settings (General = pause only, environment variables,
  authentication, components, integrations, usage limits).
- **Pages dropped**: settings/backups, settings/custom-domains (shown disabled), settings/snapshots (hidden),
  insights, the deployment summary, project settings and usage (disabled), team / billing / members, the
  command palette. A `*.convex.cloud` URL in the self-hosted dashboard links History, Backups, project
  settings and usage out to the cloud dashboard (`dc/lib/useIsCloudDeploymentInSelfHostedDashboard.ts`).

**The cloud dashboard**, for contrast, uses the WorkOS access token **as** the admin key for cloud deployments
(`Convex <accessToken>`) and asks Big Brain for a local deployment's key
(`cl/providers/DeploymentInfoProvider.tsx:205-260`; `cl/lib/deploymentAuth.ts:4-23`).

### 1.5 Packaging: docker, `dashboard.zip`, the CLI

- **Docker** (`self-hosted/docker/docker-compose.yml:54-66`): a `dashboard` service, its own image
  `ghcr.io/get-convex/convex-dashboard:latest` (Next.js, `next start -p 6791`), port `${DASHBOARD_PORT:-6791}`,
  `NEXT_PUBLIC_DEPLOYMENT_URL` defaulting to `http://127.0.0.1:${PORT:-3210}`, `depends_on` the backend being
  healthy (`curl -f /version`). **No admin key is passed**: the user pastes the one
  `generate_admin_key.sh` printed. The browser talks to the backend directly (another origin); the backend's
  CORS layer mirrors the origin.
- **`dashboard.zip`**: the static export (`build:export`, with `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API=true`),
  attached to every GitHub release.
- **The local dashboard** (`npm-packages/convex/src/cli/lib/localDeployment/dashboard.ts:26-97`, started from
  `cli/lib/dev.ts:111`), **for anonymous local deployments only**: `ensureDashboardDownloaded(version)` fetches
  `dashboard.zip` from the release (`download.ts:327-355`), a Node server on the first free port from 6790
  (saved per deployment) serves the static files and `GET /api/current_deployment` → `{name, url, adminKey}`
  (`:66-77`).
- **`npx convex dashboard`** (`cli/dashboard.ts`): self-hosted → "`npx convex dashboard` is not supported for
  self-hosted deployments" (`:32-36`); anonymous → `http://127.0.0.1:<saved port>/`, after checking that its
  `/api/current_deployment` names this deployment (`:41-84`); otherwise `https://dashboard.convex.dev/d/<name>`.
- **Links in CLI output** (`cli/lib/dashboard.ts`): `deploymentDashboardUrl` (`/t/<team>/<project>/<name>`,
  in `announceDeploymentTarget.ts:199-212`) and `deploymentDashboardUrlPage` (`/d/<name><page>`, in export,
  import, insights, indexes, components, deploy). All point at `dashboard.convex.dev`; a FIXME (`:40-41`) says
  they are wrong for local and self-hosted deployments — a self-hosted export prints a cloud link.

## 2. What an app can observe

Nothing: apps never see the dashboard. What the **operator** observes, and bunvex keeps:

- the screens show the deployment's real data, and the parts that are live in Convex are live (§1.2);
- what is polled is about as fresh (Health 8 s, scheduler lag 60 s, usage 5 s, shapes 60 s), and Logs arrive
  within a round trip of an execution;
- what a credential may do follows `check_admin_key`'s `allowedOps`;
- edits made from the dashboard appear in History (`add_documents`, `update_documents`, `delete_documents`,
  `create_table`, `clear_tables`, …), with Convex's audit documents;
- `docker compose up` brings up a dashboard next to the backend; `bunvex dev` on a local deployment serves one,
  and `bunvex dashboard` opens it; a release carries `dashboard.zip`.

## 3. How bunvex does it

### 3.1 What exists (the server side)

The server already has most of what Convex's dashboard calls over HTTP, and about half its system functions.

**System functions** (`packages/server/src/system-functions.ts`; dispatched in `functions.ts:1273`,
`:1898-1945`, admin only over the WebSocket, `/api/query` and `/api/function`; `componentId` accepted and
ignored). *have* = defined under Convex's name, with the shape its parity row records; *partial* = the data is
there under another name or route; *missing* = not defined.

| `_system/frontend/…` (used by Convex's self-hosted dashboard) | bunvex | where / note |
|---|---|---|
| `getTableMapping` | missing | (`_system/cli/tables` lists names) |
| `paginatedTableDocuments` | missing | (`_system/cli/tableData` is the CLI's) |
| `listById`, `getById` (cloud palette) | missing | |
| `tableSize`, `tableSize:sizeOfAllTables` | have | `:445`, `:450` |
| `indexes` | missing | `/api/get_indexes` missing too (`openapi.ts:494-499`) |
| `getSchemas`, `:schemaValidationProgress` | have | `:136`, `:428` (+ `stagedSchemaValidationProgress` `:437`) |
| `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage`, `createTable` | missing | their audit events are pending with them (platform:62, :252) |
| `modules:listForAllComponents`, `modules:argsValidator` | missing | `_system/cli/modules:apiSpec` (`:287`) has the data |
| `components:list` | missing | components are not built (DV-55); the root alone would do |
| `getVersion` | missing | `/version`, `/instance_version` answer it (`health.ts:74`) |
| `convexCloudUrl`, `convexSiteUrl` | missing — **rule 5** (Q3) | `_system/cli/deploymentUrl:cloudUrl` (`:281`); `/api/v1/get_canonical_urls` |
| `backendState:backendState`, `deploymentState:deploymentState` | have | `:152`, `:158` |
| `deploymentEvents:lastPushEvent`, `paginatedDeploymentEvents`, `listDeploymentEventsFromTime` | have | `:394`, `:336`, `:380` |
| `paginatedScheduledJobs`, `scheduler:getArgs` | have | `:311`, `:330` |
| `listCronJobs`, `listCronJobRuns` | have | `:458`, `:536` |
| `fileStorageV2:{numFiles, fileMetadata, getFile, deleteFile, deleteFiles, generateUploadUrl}` | have | `:482–:559`; each write audited |
| `listEnvironmentVariables` | partial | `_system/cli/queryEnvironmentVariables` (`:292`); `/api/v1/list_environment_variables` |
| `listAuthProviders` | have | `:130` |
| `listConfiguredSinks` | have | `:115` |
| `latestExport`, `snapshotImport:list` (cloud only) | partial | `_system/cli/exports:getLatest` (`:175`), `_system/cli/queryImport:list` (`:188`) |

**HTTP routes** (`packages/server/src/server.ts`; admin gate `:1588-1617`):

| route | bunvex |
|---|---|
| `GET /api/check_admin_key` | have (`:1193`) |
| `GET /api/shapes2` | have (`:1335`) |
| `POST /api/delete_tables`, `/api/delete_scheduled_functions_table` | have (`:1401`, `:1392`) |
| `POST /api/delete_component` | n/a until components (DV-55) |
| `POST /api/cancel_job`, `/api/cancel_all_jobs` | have (`:1372`, `:1376`) |
| `POST /api/(v1/)update_environment_variables` | have (`:1215`) |
| `POST /api/run_test_function` | have (`:1424`, STUDY-119) |
| `GET /api/app_metrics/stream_function_logs`, `/api/stream_function_logs` | have (`STREAM_ROUTE` `:411`, `:1331`); AD-27 `links` for a `dashboard-*` client |
| `GET /api/app_metrics/*` (all ten) | have (`app-metrics-routes.ts:33`) |
| `POST /api/v1/pause_deployment`, `/unpause_deployment` | have (`:549`, `:1170`) |
| `/api/v1/*usage_limit*`, `/api/v1/get_current_usage` | have (`usage-limits.ts:241`) |
| `/api/v1/*_log_stream*` | have (STUDY-59) |
| `/api/export/*`, `/api/perform_import`, `/api/cancel_import` | have (`:1908-1950`, `:2024-2065`) |
| `GET /instance_name`, `/version` | have (`health.ts:63-72`) |
| CORS on `/api/*` (origin mirrored, credentials, preflight) | have (`cors.ts`, wired at `:1789`) |
| WebSocket `Authenticate {tokenType: "Admin"}` | have (`sync.ts:1257-1269`) |
| `GET /api/current_deployment` | missing (it belongs to the local dashboard's server, not the backend) |

Auth on bunvex is `Authorization: Bunvex <key>` (DV-97; `Convex <key>` is a 400 `InvalidAdminKey`,
`server.ts:701-731`), `?adminKey=`, or the key in `run_test_function`'s body. The client header is
`Bunvex-Client: <client>-<semver>` (`client-version.ts:4,15`).

### 3.2 What does not exist (the dashboard side)

- `packages/dashboard` reads everything through `DashboardDataSource` (`data-source.ts:432-526` plus the
  `data-source-*.ts` feature interfaces); the screens get it from `<Dashboard dataSource>`
  (`dashboard.tsx:17,55,66`) and `useDataSource` (`context.tsx:5,13`). Its `watch*` methods are callback
  subscriptions (`(…, onX, onError) => Unsubscribe`, never synchronous); `watchTable` is a signal that makes
  the screen refetch its TanStack Query keys (`database/live.ts:9-18`; STUDY-12 D3, decided).
- `apps/dashboard/src/main.tsx:25-47,96` builds a `MockDataSource` and injects it; sign-in uses
  `mockVerifier()` (`login/credentials.ts:82-94`). `SERVER_OPS` already maps the server's operation names
  (`:43-63`).
- `check-deps` allows `dashboard → ui` and `apps/dashboard → dashboard, ui` only (`scripts/check-deps.ts:62-66`).
- There is no `@bunvex/client/react`: `@bunvex/client` exports `"."` only; React is `@bunvex/react`
  (`BunvexReactClient`, `packages/react/src/client.ts:125`, `setAdminAuth(token)` `:184`, without
  impersonation). `BaseBunvexClient` (`packages/client/src/base-client.ts:100`) has `setAdminAuth(value,
  impersonating?)` `:347`, `subscribe` `:356`, `mutationInternal` `:445`, `actionInternal` `:505` — exactly what
  Convex's runner uses on its side.
- No `dashboard` service in `docker/docker-compose.yml`, no `dashboard.zip`, `bunvex dev` serves no dashboard,
  `bunvex dashboard` warns on a local deployment and refuses on a self-hosted one (STUDY-146).

### 3.3 The design

**A new package, `@bunvex/dashboard-source`** (`packages/dashboard-source`), exporting
`createServerDataSource({ url, adminKey, fetch? }): DashboardDataSource & Disposable` and
`createAdminKeyVerifier()`.

- Depends on `@bunvex/client` (browser-safe) and on `@bunvex/dashboard` for the contract's types only. The
  dashboard package keeps depending on `ui` alone (UI-01 §6), so the same screens still serve a future cloud
  host with another source. This replaces UI-01 §5.7's proposed `@bunvex/dashboard/http` over
  `@bunvex/protocol`: the admin API turned out to be Convex's system functions over the sync protocol, so the
  client, not raw protocol messages, is the right dependency. A UI-01 amendment and a `check-deps` rule
  (`dashboard-source → client, dashboard`; `apps/dashboard → dashboard-source`) come with PR 1.
- **Not React.** The contract is callback-based (D3), so the source holds one `BaseBunvexClient` with
  `setAdminAuth(adminKey)` and turns each `watch*` into a `subscribe` of the matching system query, calling
  back on every new result. `@bunvex/react` is not needed; the screens keep TanStack Query over the contract.
  The runner gets a second client (as Convex's `functionRunner/lib/client.ts`) for `watchFunction` with
  impersonation (`setAdminAuth(key, identity)`).
- **The mapping**, Convex's mechanism per method (§1.2), so freshness matches:

| contract | over |
|---|---|
| `listTables`, `getSchema` | `getTableMapping` + `tableSize` + `indexes` + `getSchemas` (WS query, one-shot) |
| `listDocuments`, `getDocument`, `tableOfId` | `paginatedTableDocuments` (bunvex's `FilterExpression` translated to Convex's `filters`), `listById`, `getTableMapping` |
| `watchTable` | a subscription to the loaded pages' `paginatedTableDocuments` and to `tableSize`; a change fires the signal (live, as Convex; D3's refetch stays inside the dashboard) |
| writes | `addDocument`, `patchDocumentsFields`, `replaceDocument`, `deleteDocuments`, `clearTablePage` (looped), `createTable` (WS mutations; audited server-side); `/api/delete_tables` |
| `inferDocumentType` | `/api/shapes2`, refreshed every 60 s while shown |
| `listFunctions` | `modules:listForAllComponents` + `modules:argsValidator` (subscribed) |
| `runFunction`, `watchFunction` | `mutationInternal` / `actionInternal` / `subscribe` on the runner client |
| custom query (new optional `runTestQuery(source, args)`) | `POST /api/run_test_function` (the key in the body, `format: "encoded_json"`, DV-307); the browser compiles TypeScript as Convex's does |
| `listLogs`, `watchLogs` | one long-poll loop on `/api/app_metrics/stream_function_logs` from cursor 0, Convex's back-off; `listLogs` returns what the ring holds, older pages `isDone` |
| metrics (Health, a function's and a table's statistics) | `/api/app_metrics/*`; the screen polls 8 s (top-k, concurrency, invalidations), 60 s (scheduler lag), once per window (a function's charts), as Convex |
| new optional `functionConcurrency`, `subscriptionInvalidations` | `/api/app_metrics/function_concurrency`, `…/subscription_invalidations_top_k` (platform:342) |
| schedules | `paginatedScheduledJobs` (subscribed, auto-paused past 100 updates / 10 s as Convex), `scheduler:getArgs`, `listCronJobs`, `listCronJobRuns`; `/api/cancel_job`, `/api/cancel_all_jobs` |
| files | `fileStorageV2:*` (subscribed, auto-pause); upload = `generateUploadUrl` then POST |
| environment variables | `listEnvironmentVariables` (subscribed); `/api/update_environment_variables` |
| deployment state, pause | `deploymentState`, `backendState` (subscribed); `/api/v1/(un)pause_deployment` |
| audit log | `paginatedDeploymentEvents` (subscribed) |
| auth providers, sinks | `listAuthProviders`, `listConfiguredSinks` |
| snapshots (bunvex's Settings addition) | `_system/cli/exports:getLatest` / `queryImport:list`, `/api/export/*`, `/api/import` |
| `getDeployment` | `getVersion`, the URL queries (Q3), `/instance_name` |
| `getStats` / `watchStats`, topology, subscriptions, system tables | `/stats`, `/api/debug/*`, `_system/debug/*` (bunvex additions, already server-side) |
| auth admin, clients, workflows, analytics, flags | not offered (`typeof` hides them) until their server sides exist |

- Requests send `Authorization: Bunvex <key>` and `Bunvex-Client: dashboard-<version>` (which also turns on
  the AD-27 log links).
- Errors map to the contract's codes: 401/403 → `unauthorized`, 404 → `not_found`, 400 → `invalid_request`,
  network / 5xx / socket loss → `unavailable`. A connection watcher feeds the dashboard's disconnect state.

**Swapping out the mock** (`apps/dashboard/src/main.tsx`): sign-in calls the real verifier (`GET
<url>/api/check_admin_key` with `Bunvex <key>`, Convex's 3 tries and 404 rule), then
`createServerDataSource({url, adminKey})` replaces `mockSource(session)`. "Use the demo data" (LG1, `?demo=1`)
keeps the mock, so the e2e tests and design work are unchanged. The credentials also come from
`/api/current_deployment` when the build is the local one (`VITE_BUNVEX_USE_CURRENT_DEPLOYMENT=1`, as
Convex's `NEXT_PUBLIC_USE_CURRENT_DEPLOYMENT_API`), and from the allow-listed parent (DV-319).

**The server functions to add** (each under Convex's path and shape, checked against Convex's local backend
with an oracle as STUDY-34 did for the system identity): `getTableMapping`, `paginatedTableDocuments`,
`listById`, `getById`, `indexes`, the six data mutations (with the `add_documents`, `update_documents`,
`delete_documents`, `create_table` and `clear_tables` audit events), `modules:listForAllComponents`,
`modules:argsValidator`, `components:list` (the root only), `getVersion`, `cloudUrl` and `siteUrl` (DV-474),
`listEnvironmentVariables`, `latestExport`, `snapshotImport:list`, and `/api/get_indexes` for the CLI's sake.

**Packaging** (closing DV-189, DV-194, DV-202, DV-217):

- `apps/dashboard` builds a static bundle (Vite already does). A tiny Bun server, `bunvex dashboard serve`
  (internal), serves it and, for a local deployment, `GET /api/current_deployment` (only for a `Host` of `127.0.0.1` or
  `localhost`, DV-476).
- **Docker**: a `dashboard` service on `${DASHBOARD_PORT:-6791}` with `BUNVEX_DEPLOYMENT_URL` defaulting to
  `http://127.0.0.1:${PORT:-3210}`, after the backend is healthy, no admin key passed — as Convex's, from its
  **own image** (`ghcr.io/bunvex/bunvex-dashboard`; Q1 option B, DV-475).
- **`dashboard.zip`** in every release (`scripts/build-binary.ts`), from the same build with the
  current-deployment flag.
- **`bunvex dev`** on a local deployment downloads (or finds in the cache) the release's `dashboard.zip` and
  serves it on the first free port from 6790, saved per deployment; **`bunvex dashboard`** opens it after
  checking `/api/current_deployment`, as Convex's. A self-hosted deployment keeps Convex's "not supported"
  (Q5, decided).
- **CLI links**: export and import link to the local dashboard when `dev` serves one, otherwise print none
  (DV-477, replacing DV-217).

**Security**: Convex's model (the key typed in, kept in memory only, DV-210; sent over the WebSocket and in
`Authorization`; CORS as Convex's), plus the local server's `Host` check (DV-476).

## 4. Divergences

Decided by the owner on 2026-10-12 (§6), recorded in [divergences.md](../parity/divergences.md).

| # | Divergence | Why | Decision |
|---|---|---|---|
| DV-474 (Q3) | `_system/frontend/convexCloudUrl` and `convexSiteUrl` exist under bunvex names (`cloudUrl`, `siteUrl`) | rule 5 has no exceptions, wire names included (DV-307/308/312) | owner, 2026-10-12: rename |
| DV-475 (Q1) | the `dashboard` service's own image (6791; locally 6790, as Convex) holds a static Vite build served by Bun, not a Next.js server; topology and image split match Convex | bunvex's dashboard is a static app (STUDY-12 D1) | owner, 2026-10-12: B, its own image |
| DV-476 (Q4) | the local dashboard's `/api/current_deployment` answers only a `Host` of `127.0.0.1` / `localhost:<port>` | it hands out the admin key; Convex's Node server answers any `Host` (DNS rebinding) | owner, 2026-10-12: add the check |
| DV-477 (Q5) | export / import print a link to the dashboard bunvex is serving locally, or none on self-hosted; never a cloud link | Convex prints `dashboard.convex.dev` even when that is wrong (its FIXME); bunvex has no cloud and rule 5 forbids the link | owner, 2026-10-12: as proposed; replaces DV-217 |

Already decided and kept: D1 (bunvex's own screens), D3 (`watchTable` as a signal; now fed by a real
subscription), DV-97 (`Bunvex` scheme), DV-210 (the key never stored), DV-307 (`encoded_json`), DV-319
(embedding allow-list).

## 4b. Additions (beyond Convex)

| # | Addition | Why | Decision |
|---|---|---|---|
| AD-32 (Q1 option C) | the backend can also serve the dashboard itself, same-origin, at `/dashboard` (opt-in) | one container, one port, no CORS | **not taken** (owner, 2026-10-12: Q1 option B); not recorded in additions.md |

## 5. Tests

- **Contract suite against a live server**: `describeDataSourceContract` (`@bunvex/dashboard/contract`), today
  run on the mock, runs on `createServerDataSource` over an in-process bunvex server (pagination and cursors,
  every filter operator, watchers, writes on a scratch table, errors).
- **System functions against Convex**: each new `_system/frontend` function and its audit event checked against
  Convex's local backend binary with the same inputs (the oracle STUDY-34 and STUDY-48 used), shapes compared
  field by field.
- **Freshness**: a write shows up in a `watchTable`, `watchScheduledFunctions` and `watchFiles` callback without
  a refetch timer; a log line reaches `watchLogs` within one long-poll; a 403 stops the loop; back-off doubles.
- **Sign-in**: the real verifier against `check_admin_key` (good key, read-only key, wrong key, 404).
- **e2e** (`apps/dashboard/e2e`): the existing scenarios once on the mock and once against `bunvex dev`'s local
  dashboard, with axe.
- **Packaging**: `docker/smoke.sh` brings up the `dashboard` service and fetches `/`; `smoke-binary.sh` checks
  `dashboard.zip`; a CLI test for `bunvex dashboard` on a local deployment and `/api/current_deployment`'s Host
  check.
- **Sabotage** per PR (a watcher that never fires, a cursor not passed through, a wrong auth scheme, a missing
  audit event, a Host check removed), each watched to fail.

### PR plan (ordered)

| # | PR | Size |
|---|---|---|
| 1 | `@bunvex/dashboard-source` skeleton: the client wiring, auth, errors, the connection watcher, the real `check_admin_key` verifier, the contract suite on a live server for what exists today (deployment state, schemas, sizes, logs long-poll, metrics); UI-01 amendment and the `check-deps` rule | M (~800 lines) |
| 2 | Server: data reads — `getTableMapping`, `paginatedTableDocuments` (Convex's filter shape), `listById`, `getById`, `indexes`, `/api/get_indexes`; the source's `listTables`, `listDocuments`, `watchTable` | L (~1 200) |
| 3 | Server: data writes — the six mutations with their audit events (closes platform:62 and :252); the source's writes | M–L (~900) |
| 4 | Server: `modules:listForAllComponents`, `modules:argsValidator`, `components:list`, `getVersion`, `cloudUrl` and `siteUrl` (DV-474), `listEnvironmentVariables`, `latestExport`, `snapshotImport:list`; the source's Functions, runner (second client, impersonation), custom query (`runTestQuery` + the runner's editor), env vars, settings | L (~1 100) |
| 5 | The source for schedules, files (auto-pause), history, Health's concurrency and invalidations (new optional contract methods, platform:342) | M (~600) |
| 6 | `apps/dashboard` on the real source by default, the mock behind "Use the demo data"; e2e against a live deployment | S–M (~400) |
| 7 | Packaging: `bunvex dashboard serve`; a **second docker image** (`docker/dashboard.Dockerfile`, published beside the backend's) and the `dashboard` service on 6791 in docker-compose; `dashboard.zip` in releases; the local dashboard in `bunvex dev` (6790, with the `Host` check); `bunvex dashboard` for local; closes DV-189, DV-194, DV-202 | M–L (~900) |
| 8 | CLI links (DV-477, closes DV-217) and the docs (self-hosting guide, parity rows) | S (~200) |

PRs 2–5 can run in parallel once PR 1 is in; 6 needs 2–4; 7 needs 6.

### PR 1, as built

`packages/dashboard-source` (UI-01 §34):

- `admin-http.ts`: the admin routes with `Bunvex <key>` and `Bunvex-Client: dashboard-0.0.0` (the private
  package's version), and the error codes of §3.3.
- `credentials.ts`: `createAdminKeyVerifier`, as `checkDeploymentInfo.ts:17-58` — `Content-Type`,
  `Authorization` and the client header on a GET; a 2xx gives `allowedOps ?? []` and `isReadOnly ?? false` (not
  JSON: everything allowed); a 404 allows everything; anything else, a network error included, sleeps 500 ms
  and tries again, 3 tries in all (so a refused key answers after about 1.5 s, as Convex's). `SERVER_OPS` and
  `capabilitiesOf` moved here from `apps/dashboard`, which re-exports them.
- `sync.ts`: one `BaseBunvexClient` with `setAdminAuth` before any subscription; per-query callbacks shared by
  token, one-shot reads, `mutationInternal` / `actionInternal`; a failure saying "permission" is
  `unauthorized`. The connection watcher is Convex's rule (`deploymentContext.tsx`
  `handleConnectionStateChange`): unknown without a fresh previous observation, disconnected at two in a row.
- `logs.ts`: the long poll of §1.3 and Convex's `processLogs` (each line, then an outcome line carrying the
  execution; quoted string messages unquoted as `messagesToString`; an HTTP action fails by its status).
  `listLogs` pages what the loop holds; since the server holds an empty log's first request up to 60 s, an
  answer within 1 s is the history (listed, not delivered to `watchLogs`), and the log reads as empty until
  one arrives.
- `metrics.ts`: `functionRate` (`udf_rate` is per second, so it is multiplied by the bucket's width, as
  Convex's charts do with their `timeMultiplier`), `cacheHitPercentage`, `latencyPercentiles` (seconds → ms,
  the order asked), `topFunctions` (display paths), `scheduledJobLag`; a window with no bucket is refused
  before it is sent (the server's answer would be a 500).
- `server-source.ts`: `getDeployment` (`/instance_name`, `/version`, the persistence label from `/stats`),
  `getCapabilities` (`check_admin_key`), `getStats` / `watchStats` (`/stats`, which now also reports
  `subscriptions`, the field UI-01 §5.2 maps), `getSchema` (`getSchemas` and its validation progress over the
  socket), `getDeploymentState` (`deploymentState`), pause and resume (the routes; resume skips a running
  deployment, since the contract's resume is idempotent and Convex's route refuses it). `listTables`,
  `listDocuments`, `getDocument`, `watchTable` and `listFunctions` answer `unavailable`.

Two items of the PR plan moved: the table sizes are a field of `listTables`, and a table's rates need the
table mapping to answer `not_found` for an unknown table (the server answers zeros), so both come with PR 2.
The contract's metrics part picks its functions with `listFunctions`, so it runs from PR 4; until then the
metrics are checked by tests of their own against the live server.

**Tests.** `packages/dashboard-source/test` (no server): the verifier's request, tries, delay and 404 rule;
the error codes; the log mapping, the loop's cursor, back-off, reporting, 403 stop (a 401 backs off, as
Convex's) and history rule; the
metric units; the watcher's rule; the schema mapping. `packages/sync-e2e/dashboard/server-source.test.ts`: a
server in the process with a schema and functions pushed over deploy2, then `describeDataSourceContract` with
`only: ["deployment", "logs", "state"]` (pause toggled), and the verifier (full, read-only and wrong keys, a
404 server), the deployment's fields, the counters with a live subscription, `watchStats`' interval, the
schema, the logs' history and live tail, the metrics, and the methods not built yet.

**Sabotage** (each restored after; every one turned a test red):

| Sabotage | Failing tests |
|---|---|
| `Bearer` instead of `Bunvex` in `Authorization` | 18 (unit and live) |
| the verifier tries 2 times | 4 |
| the 404 rule removed | 2 |
| no delay between tries | 1 |
| the log loop does not pass `newCursor` on | 2 |
| the history delivered to `watchLogs` | 2 |
| a 403 does not stop the loop | 1 |
| a 401 (a refused key) stops it too | 1 |
| failures reported at the first one | 1 |
| `watchStats`' unsubscribe does nothing | 1 |
| `udf_rate` left per second | 2 |
| latencies left in seconds | 2 |
| quoted messages kept quoted | 5 |
| `v.any()` shown as a document type | 1 |
| the contract's `only` ignored | 17 |
| `/stats` without `subscriptions` | 1 |

**Measurements.** No hot path changes (the server only adds a counter read per `/stats` call). The app's
entry chunk grows by 521 bytes (the verifier's module, re-exported through `apps/dashboard`); the source itself
is not in the app's bundle until PR 6.

**PR 2 starts from** `server-source.ts`'s `listTables`, `listDocuments`, `getDocument` and `watchTable` stubs,
the `"tables"` and `"documents"` areas of the live suite, `AdminSync.watch` / `query` for the new system
functions (`getTableMapping`, `paginatedTableDocuments`, …), and `Metrics` for `tableRate`.

### PR 2, as built

The Data screen's reads. In the citations, `fe/` is `npm-packages/system-udfs/convex/_system/frontend/` and
`sst` is `npm-packages/system-udfs/convex/_system/secretSystemTables.ts`.

**Server** (`packages/server/src/data-system-functions.ts`, spread into `SYSTEM_QUERIES` by one line; admin only,
ViewData, `componentId` accepted and ignored as the other system functions do, DV-55). Each was compared with
Convex's local backend binary for the same documents (Tests, below).

- `getTableMapping` (`fe/getTableMapping.ts:9-24`; the op is `crates/isolate/src/ops/database.rs:8-11`, which
  takes the table mapping dependency, `crates/database/src/transaction.rs:260-263`): every active table's number
  and name, keeping the user tables and `_scheduled_jobs` and `_file_storage`, the first 1 000 by number. It reads
  `_tables`, so a subscription to it gets a table a push or a write creates.
- `paginatedTableDocuments` (`fe/paginatedTableDocuments.ts:40-209`, `fe/lib/filters.ts`): `filters` is base64
  (standard or URL-safe, padded or not, as js-base64's `decode`) of Convex's `FilterExpression`. As Convex's:
  - the expression's shape is checked (`FilterExpressionSchema`, `filters.ts:131-174`), then each clause's value
    (`findErrorsInFilters`, `:258-276`); a value that is not a JSON value answers the page `[{filter: i, error:
    "Invalid value: …."}]`, `isDone`, cursor `""`;
  - an index filter is checked against the **active schema's** indexes plus `by_creation_time` and `by_id`
    (`getAvailableIndexes`, `:577-594`; a staged index is not there), with Convex's messages and `filter: -1`
    (`validateIndexFilter`, `:397-451`; `validateSearchIndexFilter`, `:462-518`); a search index runs as
    `withSearchIndex` with its filter fields;
  - one `_id eq` clause and no index filter is a `db.get` (`paginatedTableDocuments.ts:153-185`);
  - the field clauses are one `filter` (`applyBuiltinFilters`, `:218-270`), the type clauses are applied to the
    page read (`applyTypeFilters`, `filters.ts:226-247`), so a page can hold fewer than `numItems`;
  - Convex's quirks are kept: `anyOf` / `noneOf` compare their elements as sent, not decoded, so an encoded int64
    or bytes in the list fails with Convex's "Field name $integer starts with a '$', which is reserved."
    (`:238-256`); `anyOf` of nothing filters nothing; a type clause reads a top-level field only
    (`doc[filter.field]`, `filters.ts:236`); an unset field is below every value, so `lt` / `lte` match it;
  - the undefined placeholder is `__BUNVEX_PLACEHOLDER_undefined_…` (`fe/lib/values.ts:3-4` renamed, rule 5:
    **DV-478**).
- `indexes` (`fe/indexes.ts:7-190`): the table's `_tables` row (active, root namespace), its `_index` rows but
  `by_id` and `by_creation_time`, each `{name, staged, fields, backfill: {state[, stats]}}` with the stored
  fields (`_creationTime` last), a search index's `{searchField, filterFields}`, a vector index's
  `{vectorField, filterFields, dimensions}`, and a running backfill's `_index_backfills` counts. bunvex stores
  Convex's `_index` rows (STUDY-134), so the reading is Convex's.
- `listById` and `getById` (`fe/listById.ts:6-47`, `fe/getById.ts:5-17`): as `queryGeneric`'s masks (`sst:70-91`,
  `:179-205`), a system table is reached only through its public virtual table (`_file_storage` → `_storage`,
  `_scheduled_jobs` → `_scheduled_functions`), any other id or table is `null`; `getById("nope")` is `null`.
- `GET /api/get_indexes?component_id=` (`crates/local_backend/src/dashboard.rs:216-233`, the response
  `schema.rs:82-185`, `IndexModel::get_application_indexes`, `crates/database/src/bootstrap_model/index.rs:994-1024`):
  every declared index of the user tables, `{table, name, fields, backfill: {state: "in_progress" | "done"},
  staged}`, sorted by table and name; ViewData; documented in the dashboard OpenAPI document, so DV-381 now
  leaves out two routes (`deployment_info`, `delete_component`).

**Source** (`packages/dashboard-source/src/tables.ts`, wired in `server-source.ts`):

- The table mapping stays **subscribed** for the source's life (Convex's sidebar keeps `getTableMapping`
  subscribed, `dc/lib/useTableMetadata.tsx:26-40`); the table list is its names without `_` (`lib/utils.ts:28`),
  sorted. An unknown table is `not_found` for `listDocuments`, `getDocument`, `watchTable`, `inferDocumentType`
  and `tableRate` (the server answers an empty page and zeros for any name).
- `listTables`: per table `indexes` and `tableSize`, and `getSchemas` for `declared`. The declared indexes are
  listed by name, with their declared fields (the stored `_creationTime` dropped, as the schema's own); a backfill
  is `backfilling` with its counts, `backfilled` is not yet queryable; search, vector and staged indexes are not
  listed (`IndexInfo` has no place for them; Convex's index list shows them — a gap for the contract).
- `listDocuments`: the contract's expression is checked with the dashboard's own `validateFilter` (exported as
  `@bunvex/dashboard/filters`), then translated: the enabled index equalities and the range as one
  `indexRange` clause; the type `int64` is Convex's `bigint`; the clauses otherwise pass as they are, as the
  contract's rules are now Convex's (below, DV-479). A refused clause is named by the contract clause it came from
  (`filter: -1` is the index). A cursor the server refuses, or a malformed expression, is `invalid_request`.
  Documents come with int64 and bytes in their JSON encodings (`toJsonValue`, so `@bunvex/dashboard-source` may
  now import `@bunvex/values`, as Convex's dashboard imports `convex/values`; `check-deps` and UI-01 §34.3).
- `getDocument`: `listById` with the table; `tableOfId`: the id's table number in the mapping
  (`getReferencedTableName`, `dc/lib/utils.ts:61-81`), user tables only (a system table's id is not a page of
  the Database screen).
- `inferDocumentType`: the table's `/api/shapes2` shape as a document type, as Convex's `displaySchemaFromShape`
  (`dc/lib/format.ts:56-150`): system fields dropped at the root, `Never` an empty table (null) or, nested,
  `v.any()`. One answer serves every call for 2 s (SWR's default deduping, the hook `dc/lib/deploymentApi.ts:48-77`),
  and the dashboard's query asks again every 60 s while shown (`refetchInterval`, Convex's `refreshInterval:
  60000`, `:61`; `packages/dashboard/src/data/queries.ts`).
- `watchTable` (STUDY-12 D3, now over real subscriptions): while a table is watched, its `tableSize` and every
  page the source served for it stay subscribed — Convex's grid keeps its loaded pages subscribed
  (`useQueryFilteredTable.ts:36-55`) and the size (`DataContent.tsx:96`). A new result of any of them is one
  change, coalesced per transition, with the size as `count`. A first page starts a generation; pages of the two
  latest generations of the latest filter are kept (at most 200), so the pages a refetch asks again keep their
  subscription; the documents read by id (the open one) are kept too (the newest 50). A write to a document no
  page or panel holds is not reported, as on Convex.
- `tableRate`: `/api/app_metrics/table_rate?name=&metric=&window=`, per second like `udf_rate`, so multiplied by
  the bucket's width (Convex's `timeMultiplier`, `dc/features/data/components/TableMetrics.tsx:21-44`).

**Tests.**

- **Oracle** (`packages/differential/test/dashboard-data.test.ts`): Convex's pinned local backend and bunvex's,
  the same documents (mixed types, a missing field, int64, bytes, a nested object), every call compared (ids by
  first appearance, `_creationTime` by rank, cursors opaque; lists in id order sorted, as ids are random):
  `getTableMapping`, `tableSize`, `indexes` (six argument shapes), `get_indexes` (and without a key), 37 field
  filters, 19 index filters (search-index misuse, every refusal), refused values, the shape's refusals (both
  fail), the cursors (next page, another query's, not a cursor, `numItems: 0`), `listById` (system and unknown
  tables) and `getById`. Three differences of every function, not of these, are rewritten in the test and left
  to a follow-up (below).
- **Server** (`packages/server/test/data-system-functions.test.ts`): the mapping's two system tables; staged,
  search and vector indexes' shapes; the search-index path (filter fields, disabled ones, field filters after,
  each refusal); the placeholder (Convex's is an ordinary string here); base64 forms.
- **Source** (`packages/dashboard-source/test/tables.test.ts`): the translation, the index listing, the shapes.
- **Live** (`packages/sync-e2e/dashboard/server-source.test.ts`): the contract suite's `tables` and `documents`
  areas now run (with deployment, logs and state; the suite's field filters now include `lt` / `lte` / `gte` on a
  field some documents lack, an empty `anyOf` and a type clause on a dotted name); plus the table list's sizes,
  indexes and `declared`; int64 and bytes; the type filter; an unset field and `lt`; `anyOf` of nothing; a type
  clause on a dotted name; a refused value's clause; `watchTable`
  (an unloaded document's write not reported, a loaded one's and the open document's reported, an insert's
  count, nothing after the stop, its subscriptions ended); `tableRate`; `inferDocumentType` and its 2 s sharing;
  `tableOfId`; the table list live across a push that adds a table.

**Sabotage** (each restored after, `git diff` clean; every one turned a test red):

| Sabotage | Failing test |
|---|---|
| `getTableMapping` drops `_scheduled_jobs` and `_file_storage` | oracle; server |
| `indexes` lists `by_id` and `by_creation_time` | oracle |
| `get_indexes` says `ready` for `done` | oracle |
| `anyOf` decodes its elements | oracle |
| type clauses follow dotted paths | oracle |
| no `_id` shortcut | oracle |
| `getById` without the public-system mask | oracle |
| the placeholder not read as `undefined` | oracle |
| the source reads the mapping once (not live) | live (a push's new table) |
| `int64` not mapped to `bigint` | unit; live |
| a refused clause named by its server position | live |
| (after DV-479) the contract's `lt` excludes an unset field | dashboard unit; live contract |
| (after DV-479) the contract's empty `anyOf` matches nothing | dashboard unit; live contract |
| (after DV-479) the contract's type clause follows dots | dashboard unit; live contract |
| (after DV-479) the source adds an "is set" clause after `lt` | live; live contract |
| (after DV-479) the source answers an empty page for an empty `anyOf` | live; live contract |
| `watchTable` does not subscribe the loaded pages | live |
| a size change not reported | live |
| `watchTable`'s stop leaves the size subscribed | live (subscriptions count) |
| `watchTable` on an unknown table not refused | contract |
| a cursor error left `unavailable` | contract |
| shapes fetched on every call | live |
| the document type keeps `_id` / `_creationTime` | unit; contract; live |
| declared indexes keep `_creationTime` | unit; live |
| `tableRate` answers zeros for an unknown table | live |
| `table_rate` left per second | live |

**Measurements.** No hot path changes: the server adds system functions and one route comparison in the admin
routes' chain. A watched table costs one subscription for its size plus one per loaded page; a write to it
re-runs those (the size from the table summaries). The app's bundle grows by 26 bytes (the inferred type's
refetch interval); the source is not in it until PR 6.

**Found on the way, outside PR 2** (differences of every function, rewritten in the oracle test and left to a
follow-up that matches Convex):

1. A cursor that does not parse fails with "InvalidCursor: Failed to parse cursor"; Convex's says "Failed to
   parse cursor" (`crates/keybroker/src/broker.rs:911`; the code is not in the message). Likewise "Key is invalid
   for instance" and "Missing position field" (`:1312-1326`). Core's `cursor.ts:120-148`.
2. `paginate({numItems: 0})` fails with "`options.numItems` must be a positive number. Received `0`."; Convex's
   JavaScript only refuses a negative number (`npm-packages/convex/src/server/impl/query_impl.ts:284-288`) and
   its backend says "Must request at least 1 document while paginating". Core's `tx.ts` `paginate`.
3. A system function's argument error is "ArgumentValidationError: …"; Convex's system functions check their
   arguments in JavaScript ("Uncaught Error: …"). `functions.ts` `systemArgs`.

**DV-479 (owner, 2026-10-12: follow Convex).** The dashboard contract (UI-01 §12.4) was written for the mock
before Convex's server was studied, and differed from it: an unset field matched only `neq`, `noneOf` and
`type: unset`, an empty `anyOf` matched nothing, a type clause followed dots. The owner chose Convex's rules and
set a standing rule: where the contract conflicts with Convex, the contract changes. So `filters.ts` (the mock and
the contract suite's oracle) now follows Convex's `paginatedTableDocuments` — an unset field below every value
(it passes `lt` / `lte`), an empty `anyOf` filters nothing, type clauses read the top-level field by its name — and
the source sends the clauses as they are (its first draft added an "is set" clause after `lt` / `lte` and
answered an empty page for an empty `anyOf`). The suite run against the live server now checks those rules too.
Only the wording of a malformed expression's error stays a divergence (DV-479): bunvex's one line, not zod's
issue list (asked as: Convex / bunvex / same: no, words only / why: reproducing zod's dump brings nothing, only
a hand-made URL sends one / app impact: none / decided: keep bunvex's words).

**Notes for PR 3** (the data mutations):

- The registry for the writes is `DATA_SYSTEM_QUERIES`' module; add a `DATA_SYSTEM_MUTATIONS` beside it and
  one spread into `SYSTEM_MUTATIONS`, as here.
- The writes need no change to `watchTable`: an insert or delete changes the size, a patch or replace changes a
  loaded page or the open document. The contract's `writes` area expects a write to reach `watchTable`; it
  will, through those subscriptions.
- `clearTablePage` loops on a cursor of `paginate` (4 000 per call); `createTable` inserts and deletes a
  document, so the mapping subscription gets the table.
- `getById` / `listById` already follow `queryGeneric`'s masks; Convex's mutations use `mutationGeneric`'s
  equivalents (`sst`).

**Notes for PR 6** (the app on the source): the tables query is refreshed only by a watched table's change
(D3); Convex's sidebar is live on the mapping — a `watchTables` (or refetching the list on the mapping's change)
would match it. Search, vector and staged indexes are not in `IndexInfo`. `tableOfId` answers user tables only.

## 6. Open questions

Every question below is in the decision format the owner asked for (what Convex does / what bunvex would do /
same or not / why / app impact / recommendation), followed by the owner's decision (2026-10-12).

### Q1 — A separate service, or served by the backend? (DV-475, AD-32)

- *Convex*: a separate app. Docker runs `ghcr.io/get-convex/convex-dashboard` (Next.js) on 6791; the CLI serves
  `dashboard.zip` on 6790 for a local deployment; the backend never serves the dashboard.
- *bunvex (proposed)*: also separate — a static Vite build served by `bunvex dashboard serve`, on the same
  ports. For docker, option **A**: the same `bunvex` image with the `dashboard serve` command; option **B**: a
  second image `ghcr.io/bunvex/bunvex-dashboard`. Separately, option **C** (AD-32): the backend can also serve
  it same-origin at `/dashboard`.
- *Same?* The topology is the same; the image name (A) or the server under it is not.
- *Why*: "Ainda não fizemos" for all three; nothing stops matching exactly except that bunvex's dashboard is
  not Next.js (D1).
- *App impact*: none; operators see one more compose service, as with Convex.
- *Recommendation*: a separate service (match Convex), docker option **A** (one image to build, sign and pull;
  the image name is the only difference), and **no** C for now — serving it from the backend makes the admin
  UI reachable wherever the API is, which Convex avoids.
- **Decision (owner, 2026-10-12): option B** — a separate service with its **own** image, as Convex (a second
  image on 6791; the local dashboard on 6790). Not A, and no C: AD-32 is not taken. The topology and the image
  split now match Convex; DV-475 records only what is inside the image (a static Vite build served by Bun, not
  a Next.js server).

### Q2 — Port Convex's dashboard UI, or keep bunvex's and match the data behaviour?

- *Convex*: its own Next.js dashboard, FSL-1.1-Apache-2.0.
- *bunvex*: keeps its own screens (STUDY-12 **D1, already decided**) and matches what they read and how fresh
  it is (§3.3).
- *Same?* The screens differ (decided); the data and its freshness would match.
- *Why*: "Não dá pra fazer" as a straight port — the licence and the Next.js / cloud coupling (D1), and rule 5
  plus DV-97 mean Convex's dashboard could not talk to bunvex unchanged anyway (`Convex <key>` is a 400).
- *App impact*: none.
- *Recommendation*: confirm D1 and close STUDY-12 §6.2: the admin API mirrors Convex's function paths and shapes
  (for the oracle tests), **not** so Convex's dashboard can run against bunvex.
- **Decision (owner, 2026-10-12): confirmed** as planned (D1 kept; STUDY-12 §6.2 closed this way).

### Q3 — Rule 5 and the dashboard's function names (DV-474)

- *Convex*: the dashboard calls `_system/frontend/convexCloudUrl` and `convexSiteUrl`, sends
  `Authorization: Convex <key>`, `Convex-Client: dashboard-0.0.0`, and `format: "convex_encoded_json"` to
  `run_test_function`.
- *bunvex*: `Bunvex <key>` (DV-97), `Bunvex-Client: dashboard-<version>`, `encoded_json` (DV-307) are already
  bunvex's; the two functions would be `_system/frontend/cloudUrl` and `siteUrl` (as
  `_system/cli/deploymentUrl:cloudUrl` already is). Every other path (`paginatedTableDocuments`, …) keeps
  Convex's name.
- *Same?* No, two function paths differ.
- *Why*: "Não dá pra fazer" — rule 5 has no exceptions for wire names (DV-307/308/312, the 2026-10-03 exception
  revoked).
- *App impact*: none (only the dashboard calls them); a script calling `_system/frontend/convexCloudUrl` gets
  "Could not find function".
- *Recommendation*: rename them as proposed.
- **Decision (owner, 2026-10-12): rename** to `cloudUrl` and `siteUrl` (DV-474).

### Q4 — The admin key in the browser (DV-476)

- *Convex*: the operator pastes the key into the dashboard (another origin); it goes over the WebSocket and in
  an `Authorization` header (in the body for `run_test_function`); the backend's CORS mirrors any origin. The
  local dashboard's Node server hands `{name, url, adminKey}` to any `GET /api/current_deployment` on
  127.0.0.1, without checking `Host`; the iframe handshake accepts any parent (bunvex already restricts it,
  DV-319).
- *bunvex*: the same model — key in memory only (DV-210), CORS as Convex (`cors.ts`), no key in the docker
  service. One hardening: the local server answers `/api/current_deployment` only when `Host` is
  `127.0.0.1:<port>` or `localhost:<port>`, so a DNS-rebinding page cannot read the key.
- *Same?* Yes, except the Host check.
- *Why*: "Ainda não fizemos" — nothing forces it; it is a choice to close a hole Convex leaves.
- *App impact*: none; a user who opens the local dashboard by a LAN name gets the sign-in form instead of
  being signed in.
- *Recommendation*: match Convex everywhere else, add the Host check. Same-origin serving (Q1 C) would remove
  CORS from the picture but is not needed for safety: the key, not the origin, is the credential.
- **Decision (owner, 2026-10-12):** Convex's model plus the `Host` check (`127.0.0.1` / `localhost`) against
  DNS rebinding (DV-476).

### Q5 — `bunvex dashboard` on self-hosted, and the CLI's dashboard links (DV-477, closes DV-217)

- *Convex*: `npx convex dashboard` refuses for self-hosted, opens the local dashboard for an anonymous local
  deployment; export / import print a `https://dashboard.convex.dev/d/<name>/settings/snapshots` link, wrong
  for self-hosted (its own FIXME).
- *bunvex*: `bunvex dashboard` the same (refuse on self-hosted, open the local one); export / import print a
  link to the local dashboard when `dev` is serving one, and nothing on self-hosted.
- *Same?* The command yes; the links no.
- *Why*: "Não dá pra fazer" — the only link Convex prints is to its cloud (rule 5, and bunvex has none).
- *App impact*: none (CLI text).
- *Recommendation*: as proposed. Opening the docker dashboard from `bunvex dashboard` on self-hosted would be an
  addition (it needs the dashboard's URL in the CLI's config); not now.
- **Decision (owner, 2026-10-12): as proposed** — a link to the local dashboard when `dev` serves one,
  otherwise none; `bunvex dashboard` refuses on self-hosted, as Convex (DV-477, which replaces DV-217).

### Q6 — Cloud-only screens to skip
 (not a divergence: the self-hosted Convex dashboard lacks them too)
- *Convex self-hosted*: no insights, deployment summary, backups, custom domains, snapshots page, team /
  billing / members / usage; deploy keys are cloud.
- *bunvex*: skip insights (Big Brain), backups and custom domains (cloud), team / billing. Keep bunvex's
  existing additions: the Overview's summary (built from `getVersion`, the URL queries and `lastPushEvent`, all
  deployment-local) and Snapshots in Settings (B1, decided) over `/api/export/*` and `/api/import`.
- *Same?* Yes for what is skipped; the summary and Snapshots are already-decided additions.
- *Why*: "Não dá pra fazer" for the cloud ones (no cloud).
- *App impact*: none.
- *Recommendation*: as proposed.
- **Decision (owner, 2026-10-12): confirmed** as planned.

### Q7 — Package layout (internal, not a divergence)

- *Proposed*: `@bunvex/dashboard-source` depending on `@bunvex/client` and the dashboard's types, instead of
  UI-01 §5.7's `@bunvex/dashboard/http` over `@bunvex/protocol`.
- *Why*: Convex's admin API is system functions over the sync protocol; the client already speaks it.
- *Recommendation*: accept; PR 1 amends UI-01 §5.7 and §6.
- **Decision (owner, 2026-10-12): confirmed** as planned.
